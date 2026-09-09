/**
 * Generate a title + summary per recording, in German and English.
 *
 * WHY HERE AND NOT IN A BBB post_publish HOOK
 *   The transcript does not exist at publish time — transcription happens later
 *   on this machine. Beyond that, hooks run sequentially and would stall the
 *   publish queue, run as `bigbluebutton` on the production BBB box (no place
 *   for an inference endpoint), and must never raise, so they have no retry
 *   semantics. Inngest already provides the retries, dedup and concurrency this
 *   needs.
 *
 * GPU SERIALISATION
 *   ai01 has ONE 16 GB card, shared with WhisperX large-v3. Every function that
 *   touches it declares the same concurrency key so they queue rather than
 *   compete. Removing that key will OOM transcription, not just slow it down.
 */
import { and, eq, sql } from "drizzle-orm";
import { inngest } from "../client";
import { db, recordings, summaries, transcripts } from "../../lib/db";
import { SUMMARY_MODEL, WARM, approxTokens, assertModel, chat, unload } from "../../lib/ollama";
import {
  CHUNK_SYSTEM,
  PROMPT_VERSION,
  SUMMARY_SCHEMA,
  type SummaryOut,
  reduceUserPrompt,
  systemPrompt,
  userPrompt,
} from "../../lib/summarize-prompt";

const TARGETS = ["de", "en"] as const;

// Context to allocate. gemma4:12b leaves ~8.5 GB free on a 16 GB card, which
// comfortably holds this; raising it past the free VRAM makes Ollama silently
// spill to CPU and throughput collapses.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 40960);
// Leave room for the system prompt and the reply inside NUM_CTX.
const CHUNK_TOKENS = Math.floor(NUM_CTX * 0.6);

/** Split on paragraph/sentence boundaries near the target size. Chunking mid-
 *  sentence costs more quality than the uneven chunk sizes this produces. */
export function chunk(text: string, maxTokens: number): string[] {
  if (approxTokens(text) <= maxTokens) return [text];
  const maxChars = maxTokens * 3;
  const out: string[] = [];
  let buf = "";
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    if (buf && (buf.length + piece.length) > maxChars) {
      out.push(buf.trim());
      buf = "";
    }
    buf += (buf ? " " : "") + piece;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export const summarizeRecording = inngest.createFunction(
  {
    id: "bbb/summarize",
    // One at a time per recording, and one at a time on the GPU overall.
    concurrency: [{ key: "event.data.recordingId", limit: 1 }, { scope: "account", key: '"gpu"', limit: 1 }],
    retries: 3,
    triggers: [{ event: "bbb/summarize" }],
  },
  async ({ event, step, logger }) => {
    const recordingId = event.data.recordingId as string;
    const force = Boolean(event.data.force);

    // Prefer German, but do NOT require it. 13 of 376 recordings were conducted
    // in English, Portuguese or Ukrainian and have no German transcript at all;
    // requiring `de` here silently left those with no summary. The model reads
    // any of them and still produces both target languages.
    const source = await step.run("load-transcript", async () => {
      const rows = await db
        .select({
          text: transcripts.text,
          language: transcripts.language,
          meetingName: recordings.meetingName,
        })
        .from(transcripts)
        .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
        .where(eq(transcripts.recordingId, recordingId));
      return rows.find((r) => r.language === "de") ?? rows[0] ?? null;
    });

    if (!source?.text?.trim()) {
      logger.info(`no transcript in any language for ${recordingId}`);
      return { skipped: "no-transcript" };
    }
    if (source.language !== "de") {
      logger.info(`${recordingId}: summarising from '${source.language}' (no German transcript)`);
    }
    // 8 of 375 recordings are genuinely silent. Do not spend GPU asking a model
    // to summarise nothing, and do not write a row claiming it did.
    if (source.text.trim().length < 200) {
      logger.info(`transcript for ${recordingId} is ${source.text.trim().length} chars, too short`);
      return { skipped: "too-short" };
    }

    const existing = await step.run("check-existing", async () =>
      db
        .select({ language: summaries.language, promptVersion: summaries.promptVersion })
        .from(summaries)
        .where(eq(summaries.recordingId, recordingId))
    );
    const done = new Set(
      existing
        .filter((r: { promptVersion: string }) => r.promptVersion === PROMPT_VERSION)
        .map((r: { language: string }) => r.language)
    );
    const todo = TARGETS.filter((l) => force || !done.has(l));
    if (!todo.length) return { skipped: "already-current" };

    await step.run("assert-model", () => assertModel(SUMMARY_MODEL));

    // Long transcripts are reduced ONCE and the notes reused for both languages:
    // the expensive pass is reading the transcript, not writing the summary.
    const notes = await step.run("chunk-notes", async () => {
      const parts = chunk(source.text, CHUNK_TOKENS);
      if (parts.length === 1) return null;
      logger.info(`${recordingId}: ${parts.length} chunks (${approxTokens(source.text)} tokens)`);
      const collected: string[] = [];
      for (const [i, part] of parts.entries()) {
        const note = await chat<string>({
          model: SUMMARY_MODEL,
          system: CHUNK_SYSTEM,
          user: part,
          numCtx: NUM_CTX,
          keepAlive: WARM,
        });
        if (!note.includes("(nothing taught)")) collected.push(`Section ${i + 1}:\n${note}`);
      }
      return collected;
    });

    const written: string[] = [];
    for (const lang of todo) {
      const out = await step.run(`generate-${lang}`, async () => {
        const result = await chat<SummaryOut>({
          model: SUMMARY_MODEL,
          system: systemPrompt(lang),
          user: notes
            ? reduceUserPrompt(notes, source.meetingName)
            : userPrompt(source.text, source.meetingName),
          schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
          numCtx: NUM_CTX,
          keepAlive: WARM,
        });
        const title = result.title?.trim();
        const summary = result.summary?.trim();
        if (!title || !summary) throw new Error(`empty title/summary for ${recordingId}/${lang}`);
        return { title, summary };
      });

      await step.run(`store-${lang}`, async () => {
        await db
          .insert(summaries)
          .values({
            recordingId,
            language: lang,
            title: out.title,
            summary: out.summary,
            model: SUMMARY_MODEL,
            promptVersion: PROMPT_VERSION,
          })
          // A regeneration must replace, not duplicate — the unique index is on
          // (recording_id, language).
          .onConflictDoUpdate({
            target: [summaries.recordingId, summaries.language],
            set: {
              title: out.title,
              summary: out.summary,
              model: SUMMARY_MODEL,
              promptVersion: PROMPT_VERSION,
              createdAt: sql`extract(epoch from now())::integer`,
            },
          });
      });
      written.push(lang);
    }

    // Release the 19 GB before anything else wants the card. Not in a finally:
    // a failed run is retried and will reload anyway, and Ollama drops the model
    // on its own timer regardless.
    await step.run("unload-model", () => unload(SUMMARY_MODEL).then(() => "released"));

    return { recordingId, written, chunked: Boolean(notes) };
  }
);

/**
 * Backfill sweep. Mirrors scanRecordings: find completed recordings whose
 * summary is missing or stale, and dispatch. Deliberately small per run — the
 * GPU lane is serialised, so a huge fan-out would just sit queued for days while
 * blocking nothing usefully.
 */
export const summarizeSweep = inngest.createFunction(
  { id: "bbb/summarize.sweep", triggers: [{ cron: "*/30 * * * *" }] },
  async ({ step, logger }) => {
    const batch = Number(process.env.SUMMARIZE_BATCH ?? 20);
    const pending = await step.run("find-missing", async () => {
      const rows = await db.execute(sql`
        SELECT t.recording_id AS id
        FROM transcripts t
        WHERE t.language = 'de'
          AND length(t.text) >= 200
          AND (
            SELECT count(*) FROM summaries s
            WHERE s.recording_id = t.recording_id
              AND s.prompt_version = ${PROMPT_VERSION}
          ) < ${TARGETS.length}
        ORDER BY t.created_at DESC
        LIMIT ${batch}
      `);
      return (rows as unknown as { id: string }[]).map((r) => r.id);
    });

    if (!pending.length) return { dispatched: 0 };
    logger.info(`summarize sweep: dispatching ${pending.length}`);
    await step.sendEvent(
      "dispatch-summaries",
      pending.map((recordingId) => ({ name: "bbb/summarize", data: { recordingId } }))
    );
    return { dispatched: pending.length };
  }
);
