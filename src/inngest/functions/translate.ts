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
import { TRANSLATE_MODEL, assertModel, chat } from "../../lib/ollama";
import {
  CUES_SCHEMA,
  TRANSLATE_PROMPT_VERSION,
  TRANSLATE_SYSTEM,
  type CuesOut,
  translateUser,
} from "../../lib/translate-prompt";
import { batchCues, cuesToText, parseVtt, serialiseVtt, type Cue } from "../../lib/vtt";

const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 16384);
/** Chars of cue text per request. Small enough to leave room for the reply,
 *  large enough that a 4-hour recording is ~100 requests rather than ~4000. */
const BATCH_CHARS = Number(process.env.TRANSLATE_BATCH_CHARS ?? 2500);

const MODEL_TAG = `translated:${TRANSLATE_MODEL}:${TRANSLATE_PROMPT_VERSION}`;

async function translateBatch(texts: string[]): Promise<string[]> {
  const out = await chat<CuesOut>({
    model: TRANSLATE_MODEL,
    system: TRANSLATE_SYSTEM,
    user: translateUser(texts),
    schema: CUES_SCHEMA as unknown as Record<string, unknown>,
    numCtx: NUM_CTX,
  });
  if (!Array.isArray(out?.cues)) throw new Error("translation reply had no cues array");
  return out.cues;
}

/** Exact count or nothing. Falls back to one cue per request, which cannot
 *  misalign, rather than accepting a batch that lost or gained a line. */
async function translateAligned(texts: string[], log: (m: string) => void): Promise<string[]> {
  const first = await translateBatch(texts).catch((e) => {
    log(`batch failed (${(e as Error).message}), falling back to per-cue`);
    return null;
  });
  if (first && first.length === texts.length) return first;
  if (first) log(`batch returned ${first.length} cues for ${texts.length}, falling back to per-cue`);

  const one: string[] = [];
  for (const text of texts) {
    if (!text.trim()) { one.push(""); continue; }
    const r = await translateBatch([text]);
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

    const source = await step.run("load-german-vtt", async () => {
      const [row] = await db
        .select({ vtt: transcripts.vtt, duration: transcripts.durationSeconds })
        .from(transcripts)
        .where(and(eq(transcripts.recordingId, recordingId), eq(transcripts.language, "de")))
        .limit(1);
      return row ?? null;
    });

    // Only a cue-timed source can produce a caption track. A transcript with
    // text but no VTT is not translatable into subtitles, and silently
    // producing a text-only English row would look like success.
    if (!source?.vtt?.trim()) {
      logger.info(`${recordingId}: no German VTT, cannot produce a caption track`);
      return { skipped: "no-vtt" };
    }

    if (!force) {
      const existing = await step.run("check-existing", async () => {
        const [row] = await db
          .select({ id: transcripts.id })
          .from(transcripts)
          .where(and(eq(transcripts.recordingId, recordingId), eq(transcripts.language, "en")))
          .limit(1);
        return row ?? null;
      });
      if (existing) return { skipped: "already-translated" };
    }

    await step.run("assert-model", () => assertModel(TRANSLATE_MODEL));

    const { header, cues } = parseVtt(source.vtt);
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
          language: "en",
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

    return { recordingId, cues: cues.length, batches: batches.length };
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
        SELECT de.recording_id AS id
        FROM transcripts de
        WHERE de.language = 'de'
          AND de.vtt IS NOT NULL
          AND length(de.text) >= 200
          AND NOT EXISTS (
            SELECT 1 FROM transcripts en
            WHERE en.recording_id = de.recording_id AND en.language = 'en'
          )
        ORDER BY de.created_at DESC
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
