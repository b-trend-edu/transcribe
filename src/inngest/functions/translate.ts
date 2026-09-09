/**
 * Translate a German caption track to English, cue by cue.
 *
 * WHY CUE-WISE AND NOT WHOLE-TEXT
 *   Translating the flattened transcript would give a readable English document
 *   and a useless subtitle track. Translating cues in place keeps every
 *   timestamp, so the result drops straight into the player's caption menu next
 *   to the German one.
 *
 * THE EXPENSIVE ONE
 *   Summarisation writes ~500 tokens; this writes a whole transcript — roughly
 *   60k output tokens for a 4-hour recording, ~10 minutes on this GPU. Across
 *   the corpus that is days, not hours. It therefore runs on the same serialised
 *   GPU lane as everything else, in small sweeps, and is expected to take a
 *   long time. That is not a bug to optimise away.
 *
 * ALIGNMENT IS THE CORRECTNESS PROPERTY
 *   A translated track whose cues drifted is worse than no track: it looks right
 *   until someone follows along. Every batch is checked for an exact cue count,
 *   and a mismatch falls back to translating that batch one cue at a time rather
 *   than accepting a plausible-looking misalignment.
 */
import { and, eq, sql } from "drizzle-orm";
import { inngest } from "../client";
import { db, transcripts } from "../../lib/db";
import { TRANSLATE_MODEL, WARM, assertModel, chat, unload } from "../../lib/ollama";
import {
  CUES_SCHEMA,
  TRANSLATE_PROMPT_VERSION,
  TRANSLATE_SYSTEM,
  type CuesOut,
  translateUser,
} from "../../lib/translate-prompt";
import { batchCues, cuesToText, parseVtt, serialiseVtt, type Cue } from "../../lib/vtt";

const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 40960);
/** Chars of cue text per request. Small enough to leave room for the reply,
 *  large enough that a 4-hour recording is ~100 requests rather than ~4000. */
const BATCH_CHARS = Number(process.env.TRANSLATE_BATCH_CHARS ?? 2500);

const MODEL_TAG = `translated:${TRANSLATE_MODEL}:${TRANSLATE_PROMPT_VERSION}`;

async function translateBatch(texts: string[], from: string, to: string): Promise<string[]> {
  const out = await chat<CuesOut>({
    model: TRANSLATE_MODEL,
    system: TRANSLATE_SYSTEM(from, to),
    user: translateUser(texts),
    schema: CUES_SCHEMA as unknown as Record<string, unknown>,
    numCtx: NUM_CTX,
    // WARM matters most here: a recording is ~100 batch calls, and reloading a
    // 19 GB model for each would cost ~12 minutes per recording in loading
    // alone. unload() at the end of the run gives the VRAM back.
    keepAlive: WARM,
  });
  if (!Array.isArray(out?.cues)) throw new Error("translation reply had no cues array");
  return out.cues;
}

/** Exact count or nothing. Falls back to one cue per request, which cannot
 *  misalign, rather than accepting a batch that lost or gained a line. */
async function translateAligned(
  texts: string[], from: string, to: string, log: (m: string) => void
): Promise<string[]> {
  const first = await translateBatch(texts, from, to).catch((e) => {
    log(`batch failed (${(e as Error).message}), falling back to per-cue`);
    return null;
  });
  if (first && first.length === texts.length) return first;
  if (first) log(`batch returned ${first.length} cues for ${texts.length}, falling back to per-cue`);

  const one: string[] = [];
  for (const text of texts) {
    if (!text.trim()) { one.push(""); continue; }
    const r = await translateBatch([text], from, to);
    one.push(r[0] ?? text);
  }
  return one;
}

export const translateRecording = inngest.createFunction(
  {
    id: "bbb/translate",
    concurrency: [
      { key: "event.data.recordingId", limit: 1 },
      { scope: "account", key: '"gpu"', limit: 1 },
    ],
    retries: 2,
    triggers: [{ event: "bbb/translate" }],
  },
  async ({ event, step, logger }) => {
    const recordingId = event.data.recordingId as string;
    const force = Boolean(event.data.force);

    // Translate INTO whichever of de/en is missing, from whatever exists. Most
    // recordings are German and need English; 11 are English and need German;
    // a couple are Portuguese or Ukrainian and need both. Hardcoding de -> en
    // left all of those untranslated.
    const source = await step.run("load-source-vtt", async () => {
      const rows = await db
        .select({
          vtt: transcripts.vtt,
          language: transcripts.language,
          duration: transcripts.durationSeconds,
        })
        .from(transcripts)
        .where(eq(transcripts.recordingId, recordingId));
      const have = new Set(rows.map((r) => r.language));
      const target = event.data.target ?? (have.has("de") ? "en" : "de");
      if (have.has(target) && !force) return { done: true as const, target };
      const from = rows.find((r) => r.language !== target && r.vtt) ?? null;
      return from ? { done: false as const, target, ...from } : null;
    });

    // Only a cue-timed source can produce a caption track. A transcript with
    // text but no VTT is not translatable into subtitles, and silently
    // producing a text-only English row would look like success.
    if (!source) {
      logger.info(`${recordingId}: no cue-timed source, cannot produce a caption track`);
      return { skipped: "no-vtt" };
    }
    if (source.done) return { skipped: "already-translated", target: source.target };
    const TARGET = source.target;

    await step.run("assert-model", () => assertModel(TRANSLATE_MODEL));

    const { header, cues } = parseVtt(source.vtt!);
    if (!cues.length) return { skipped: "no-cues" };
    const batches = batchCues(cues, BATCH_CHARS);
    logger.info(`${recordingId}: ${cues.length} cues in ${batches.length} batches`);

    // One step per batch: Inngest checkpoints each, so a retry on a multi-hour
    // recording resumes where it stopped instead of re-translating from cue 1.
    const translated: Cue[] = [...cues];
    for (const [i, batch] of batches.entries()) {
      const texts = await step.run(`translate-${i}`, async () =>
        translateAligned(
          batch.cues.map((c) => c.text.replace(/\n/g, " ")),
          source.language ?? "de",
          TARGET,
          (m) => logger.warn(`${recordingId} batch ${i}: ${m}`)
        )
      );
      texts.forEach((text, j) => {
        const idx = batch.start + j;
        const original = cues[idx]!;
        translated[idx] = { ...original, text: text.trim() || original.text };
      });
    }

    await step.run("store", async () => {
      const vtt = serialiseVtt(header, translated);
      await db
        .insert(transcripts)
        .values({
          recordingId,
          language: TARGET,
          text: cuesToText(translated),
          vtt,
          durationSeconds: source.duration,
          model: MODEL_TAG,
        })
        .onConflictDoUpdate({
          target: [transcripts.recordingId, transcripts.language],
          set: {
            text: cuesToText(translated),
            vtt,
            model: MODEL_TAG,
            createdAt: sql`extract(epoch from now())::integer`,
          },
        });
    });

    await step.run("unload-model", () => unload(TRANSLATE_MODEL).then(() => "released"));

    return { recordingId, from: source.language, to: TARGET, cues: cues.length, batches: batches.length };
  }
);

/**
 * Backfill sweep. Deliberately tiny: each recording is ~10 GPU-minutes, the lane
 * is serialised, and this must never crowd out transcription or summarisation.
 * Newest first, on the assumption that recent courses are the ones being viewed.
 */
export const translateSweep = inngest.createFunction(
  { id: "bbb/translate.sweep", triggers: [{ cron: "15 * * * *" }] },
  async ({ step, logger }) => {
    const batch = Number(process.env.TRANSLATE_BATCH ?? 3);
    const pending = await step.run("find-missing", async () => {
      const rows = await db.execute(sql`
        SELECT src.recording_id AS id
        FROM transcripts src
        WHERE src.vtt IS NOT NULL
          AND length(src.text) >= 200
          AND (
            SELECT count(DISTINCT language) FROM transcripts t
            WHERE t.recording_id = src.recording_id AND t.language IN ('de','en')
          ) < 2
        GROUP BY src.recording_id, src.created_at
        ORDER BY src.created_at DESC
        LIMIT ${batch}
      `);
      return (rows as unknown as { id: string }[]).map((r) => r.id);
    });

    if (!pending.length) return { dispatched: 0 };
    logger.info(`translate sweep: dispatching ${pending.length}`);
    await step.sendEvent(
      "dispatch-translations",
      pending.map((recordingId) => ({ name: "bbb/translate", data: { recordingId } }))
    );
    return { dispatched: pending.length };
  }
);
