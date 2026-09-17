/**
 * Generate chapters per recording, in German and English.
 *
 * WHY BOUNDARIES ARE CHOSEN ONCE
 *   The player draws chapter breaks on the seek bar and lists them beside the
 *   video. If German and English disagreed about WHERE a chapter starts, the
 *   same lecture would have a different shape depending on who is watching, and
 *   a break would land mid-sentence for one of them. So boundaries are detected
 *   once from the German transcript and only the TITLES are translated. The two
 *   languages are guaranteed identical in timing by construction, not by luck.
 *
 * WHY THE MODEL NEVER WRITES A TIMESTAMP
 *   See chapters-prompt.ts. It returns block indices; this file maps them to
 *   real cue start times. An out-of-range index is dropped rather than clamped —
 *   a hallucinated boundary is worse than one chapter fewer.
 *
 * GPU SERIALISATION
 *   Same single 16 GB card as WhisperX, summarisation and translation. The
 *   shared concurrency key is what keeps them from colliding; removing it OOMs
 *   transcription rather than merely slowing this down.
 */
import { and, eq, sql } from "drizzle-orm";
import { inngest } from "../client";
import { chapters as chaptersTable, db, recordings, transcripts } from "../../lib/db";
import { SUMMARY_MODEL, WARM, approxTokens, assertModel, chat, unload } from "../../lib/ollama";
import {
  CHAPTERS_PROMPT_VERSION,
  CHAPTERS_SYSTEM,
  TITLES_SYSTEM,
  type Block,
  type ChaptersOut,
  type TitlesOut,
  chaptersSchema,
  chaptersUser,
  titlesSchema,
} from "../../lib/chapters-prompt";
import { cueStartSeconds, parseVtt } from "../../lib/vtt";

const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 40960);
const CHUNK_TOKENS = Math.floor(NUM_CTX * 0.6);

/** Seconds of transcript per candidate boundary. Finer than this and the model
 *  is choosing between two points in the same sentence; coarser and a genuine
 *  topic change gets rounded away. */
const BLOCK_SECONDS = Number(process.env.CHAPTER_BLOCK_SECONDS ?? 60);
/** No chapter shorter than this in the final list. */
const MIN_GAP_SECONDS = Number(process.env.CHAPTER_MIN_GAP ?? 240);
/** Roughly one chapter per this much runtime, which sets the per-chunk cap. */
const TARGET_CHAPTER_SECONDS = Number(process.env.CHAPTER_TARGET_SECONDS ?? 900);

export interface Chapter {
  start: number;
  title: string;
}

/** Group cues into fixed-duration blocks, each a candidate chapter start. */
export function toBlocks(
  cues: { timing: string; text: string }[],
  blockSeconds = BLOCK_SECONDS
): Block[] {
  const blocks: Block[] = [];
  for (const cue of cues) {
    const start = cueStartSeconds(cue.timing);
    if (!Number.isFinite(start)) continue;
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const last = blocks[blocks.length - 1];
    if (last && start - last.start < blockSeconds) {
      last.text += ` ${text}`;
    } else {
      blocks.push({ index: blocks.length, start, text });
    }
  }
  return blocks;
}

/** Split blocks into groups that fit the context window, keeping order. */
export function chunkBlocks(blocks: Block[], maxTokens = CHUNK_TOKENS): Block[][] {
  const groups: Block[][] = [];
  let current: Block[] = [];
  let tokens = 0;
  for (const block of blocks) {
    const cost = approxTokens(block.text) + 16; // + the "[i] (mm:ss) " preamble
    if (current.length && tokens + cost > maxTokens) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(block);
    tokens += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Drop hallucinated or useless boundaries, then thin the rest.
 *
 * Order matters: validate against the offered range FIRST (an index the model
 * invented has no meaning), then sort, then enforce spacing. Always anchors a
 * chapter at 0 — a recording whose first chapter starts at 8 minutes looks
 * broken in the seek bar.
 */
export function normalise(raw: { start: number; title: string }[], duration: number): Chapter[] {
  const clean = raw
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start < duration)
    .map((c) => ({ start: Math.round(c.start), title: c.title.trim().replace(/[.\s]+$/, "") }))
    .filter((c) => c.title.length > 0 && c.title.length <= 80)
    .sort((a, b) => a.start - b.start);

  const out: Chapter[] = [];
  for (const chapter of clean) {
    const previous = out[out.length - 1];
    if (previous && chapter.start - previous.start < MIN_GAP_SECONDS) continue;
    out.push(chapter);
  }
  if (out.length && out[0]!.start > 0) out[0] = { ...out[0]!, start: 0 };
  return out;
}

export const generateChapters = inngest.createFunction(
  {
    id: "bbb/chapters",
    concurrency: [{ key: "event.data.recordingId", limit: 1 }, { scope: "account", key: '"gpu"', limit: 1 }],
    retries: 3,
    triggers: [{ event: "bbb/chapters" }],
  },
  async ({ event, step, logger }) => {
    const recordingId = event.data.recordingId as string;
    const force = Boolean(event.data.force);

    // Needs the VTT, not the flat text: chapters are timestamps, and the text
    // column has none. A recording transcribed before VTT was stored has no
    // chapters and cannot get them without re-transcription.
    const source = await step.run("load-transcript", async () => {
      const rows = await db
        .select({
          vtt: transcripts.vtt,
          language: transcripts.language,
          durationSeconds: transcripts.durationSeconds,
          meetingName: recordings.meetingName,
        })
        .from(transcripts)
        .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
        .where(eq(transcripts.recordingId, recordingId));
      return rows.find((r) => r.language === "de" && r.vtt) ?? rows.find((r) => r.vtt) ?? null;
    });

    if (!source?.vtt) {
      logger.info(`no VTT for ${recordingId} — cannot place chapters`);
      return { skipped: "no-vtt" };
    }

    const existing = await step.run("check-existing", async () =>
      db
        .select({ language: chaptersTable.language, promptVersion: chaptersTable.promptVersion })
        .from(chaptersTable)
        .where(eq(chaptersTable.recordingId, recordingId))
    );
    const current = existing.filter(
      (r: { promptVersion: string }) => r.promptVersion === CHAPTERS_PROMPT_VERSION
    );
    if (!force && current.length >= 2) return { skipped: "already-current" };

    const { cues } = parseVtt(source.vtt);
    const blocks = toBlocks(cues);
    const duration =
      source.durationSeconds ?? (blocks.length ? blocks[blocks.length - 1]!.start + BLOCK_SECONDS : 0);

    // A short recording is one chapter, which is no chapters at all. Don't spend
    // GPU proving it.
    if (blocks.length < 4 || duration < MIN_GAP_SECONDS * 2) {
      logger.info(`${recordingId}: ${blocks.length} blocks / ${Math.round(duration)}s — too short`);
      return { skipped: "too-short" };
    }

    await step.run("assert-model", () => assertModel(SUMMARY_MODEL));

    const german = await step.run("detect-boundaries", async () => {
      const groups = chunkBlocks(blocks);
      logger.info(`${recordingId}: ${blocks.length} blocks in ${groups.length} chunk(s)`);
      const found: { start: number; title: string }[] = [];

      for (const group of groups) {
        const span = (group[group.length - 1]!.start - group[0]!.start) || 1;
        const max = Math.max(1, Math.min(12, Math.round(span / TARGET_CHAPTER_SECONDS) + 1));
        const result = await chat<ChaptersOut>({
          model: SUMMARY_MODEL,
          system: CHAPTERS_SYSTEM,
          user: chaptersUser(group, source.meetingName),
          schema: chaptersSchema(1, max) as unknown as Record<string, unknown>,
          numCtx: NUM_CTX,
          keepAlive: WARM,
        });

        // The index must be one this chunk actually offered. Anything else is
        // invented; dropping it costs a chapter, keeping it costs trust in the
        // seek bar.
        const lowest = group[0]!.index;
        const highest = group[group.length - 1]!.index;
        for (const chapter of result.chapters ?? []) {
          if (!Number.isInteger(chapter.index) || chapter.index < lowest || chapter.index > highest) {
            logger.warn(`${recordingId}: dropped out-of-range index ${chapter.index}`);
            continue;
          }
          const block = blocks[chapter.index];
          if (block) found.push({ start: block.start, title: String(chapter.title ?? "") });
        }
      }
      return normalise(found, duration);
    });

    if (!german.length) {
      logger.info(`${recordingId}: no usable boundaries`);
      return { skipped: "no-chapters" };
    }

    // Titles only. The starts are already fixed, so English cannot drift.
    const english = await step.run("translate-titles", async () => {
      const titles = german.map((c) => c.title);
      const result = await chat<TitlesOut>({
        model: SUMMARY_MODEL,
        system: TITLES_SYSTEM("English"),
        user: JSON.stringify({ titles }),
        schema: titlesSchema(titles.length) as unknown as Record<string, unknown>,
        numCtx: NUM_CTX,
        keepAlive: WARM,
      });
      const out = result.titles ?? [];
      // Length is schema-enforced, but a refusal or a retry could still land
      // short — fall back to the German title rather than shifting the list.
      return german.map((chapter, i) => ({ start: chapter.start, title: out[i]?.trim() || chapter.title }));
    });

    await step.run("store", async () => {
      for (const [language, list] of [["de", german], ["en", english]] as const) {
        await db
          .insert(chaptersTable)
          .values({
            recordingId,
            language,
            chapters: JSON.stringify(list),
            model: SUMMARY_MODEL,
            promptVersion: CHAPTERS_PROMPT_VERSION,
          })
          .onConflictDoUpdate({
            target: [chaptersTable.recordingId, chaptersTable.language],
            set: {
              chapters: JSON.stringify(list),
              model: SUMMARY_MODEL,
              promptVersion: CHAPTERS_PROMPT_VERSION,
              createdAt: sql`extract(epoch from now())::integer`,
            },
          });
      }
    });

    await step.run("unload-model", () => unload(SUMMARY_MODEL).then(() => "released"));
    return { recordingId, chapters: german.length };
  }
);

/**
 * Backfill sweep. Same shape and the same restraint as the summary sweep: the
 * GPU lane is serialised, so dispatching the whole corpus at once would only
 * build a queue nobody can read.
 */
export const chaptersSweep = inngest.createFunction(
  { id: "bbb/chapters.sweep", triggers: [{ cron: "*/30 * * * *" }] },
  async ({ step, logger }) => {
    const batch = Number(process.env.CHAPTERS_BATCH ?? 20);
    const pending = await step.run("find-missing", async () => {
      const rows = await db.execute(sql`
        SELECT t.recording_id AS id
        FROM transcripts t
        WHERE t.language = 'de'
          AND t.vtt IS NOT NULL
          AND (
            SELECT count(*) FROM chapters c
            WHERE c.recording_id = t.recording_id
              AND c.prompt_version = ${CHAPTERS_PROMPT_VERSION}
          ) < 2
        ORDER BY t.created_at DESC
        LIMIT ${batch}
      `);
      return (rows as unknown as { id: string }[]).map((r) => r.id);
    });

    if (!pending.length) return { dispatched: 0 };
    logger.info(`chapters sweep: dispatching ${pending.length}`);
    await step.sendEvent(
      "dispatch-chapters",
      pending.map((recordingId) => ({ name: "bbb/chapters", data: { recordingId } }))
    );
    return { dispatched: pending.length };
  }
);
