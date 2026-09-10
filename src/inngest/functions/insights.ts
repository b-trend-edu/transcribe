/**
 * Chapters per recording: Stufe 1 (LLM per chunk) + Stufe 2 (deterministic merge).
 *
 * WHY CUE INDICES AND NOT TIMES
 *   The model only ever names a cue index from the slice it was shown. Anything
 *   outside that slice is dropped in collectBoundaries, and index -> seconds is
 *   our mapping. A hallucinated timestamp is therefore impossible, not merely
 *   unlikely. Everything after the model — dedup, slide snap, min gap, cap — is
 *   plain TypeScript in lib/chapters.ts and unit-tested there.
 *
 * GPU SERIALISATION
 *   Same account-scoped "gpu" lane as transcription, summarisation and
 *   translation — one 16 GB card. A recording is ~9 chunk calls, so the model
 *   stays WARM across them and is unloaded at the end of the run.
 *
 * Plan: docs/superpowers/plans/2026-08-17-transcript-chapters-summary.md
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import * as z from "zod";
import { inngest } from "../client";
import { db, insights, recordings, transcripts } from "../../lib/db";
import { CHAPTERS_MODEL, WARM, assertModel, chat, unload } from "../../lib/ollama";
import {
  CHAPTERS_PROMPT_VERSION,
  CHAPTERS_SCHEMA,
  type ChunkOut,
  chaptersSystem,
} from "../../lib/chapters-prompt";
import {
  chapterLimits,
  chunkCues,
  collectBoundaries,
  mergeBoundaries,
  parseCues,
  renderChunkCues,
  type Chapter,
  type ChunkBoundaryResult,
} from "../../lib/chapters";
import { readSlideChanges } from "../../lib/slides";

const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 40960);

// onFailure receives the internal inngest/function.failed payload; the original
// event (with recordingId) is nested under data.event.
const failureEventSchema = z.object({
  data: z.object({ event: z.object({ data: z.object({ recordingId: z.string() }) }) }),
});

/**
 * Skip-gate, checked before any GPU work. First failing rule wins.
 * No language rule on purpose: 13 of 376 recordings are genuinely English,
 * Portuguese or Ukrainian, and chapters in the transcript's own language are
 * exactly what the player should show for those.
 */
function skipReasonFor(vtt: string, text: string, durationSeconds: number): string | null {
  if (Buffer.byteLength(vtt, "utf-8") < 1024) return "empty-transcript";
  if (durationSeconds > 0 && text.length / durationSeconds > 25) return "garbled-transcript";
  if (durationSeconds < 300) return "too-short";
  return null;
}

/** Upsert the row. Exactly one of chapters / skipReason is set. */
async function writeInsight(recordingId: string, data: { chapters?: Chapter[]; skipReason?: string }) {
  const set = {
    chapters: data.chapters ?? null,
    skipReason: data.skipReason ?? null,
    model: CHAPTERS_MODEL,
    promptVersion: CHAPTERS_PROMPT_VERSION,
  };
  await db
    .insert(insights)
    .values({ recordingId, ...set })
    .onConflictDoUpdate({
      target: insights.recordingId,
      set: { ...set, createdAt: sql`extract(epoch from now())::integer` },
    });
}

export const insightsGenerate = inngest.createFunction(
  {
    id: "insights/generate",
    // One at a time per recording, and one at a time on the GPU overall.
    concurrency: [
      { key: "event.data.recordingId", limit: 1 },
      { scope: "account", key: '"gpu"', limit: 1 },
    ],
    retries: 2,
    triggers: [{ event: "insights/generate" }],
    // A terminal failure becomes a skipReason, so the hourly scan stops
    // re-dispatching (and re-burning the GPU lane) on a poison recording. A
    // regenerate clears it; a host-wide fix can bulk-clear `error:%`.
    onFailure: async ({ event, error }) => {
      const parsed = failureEventSchema.safeParse(event);
      if (!parsed.success) return;
      const { recordingId } = parsed.data.data.event.data;
      await writeInsight(recordingId, { skipReason: `error:${error.message}`.slice(0, 200) });
    },
  },
  async ({ event, step, logger }) => {
    const recordingId = event.data.recordingId as string;

    const skipWith = async (reason: string) => {
      await step.run("write-skip", () => writeInsight(recordingId, { skipReason: reason }));
      logger.info(`${recordingId}: skipped (${reason})`);
      return { recordingId, skipped: reason };
    };

    // Transcripts are one row per language. Chapters come from the ASR original
    // — its cue timings are the source of truth — never from a translated track
    // unless no original with a VTT exists.
    const source = await step.run("load-transcript", async () => {
      const rows = await db
        .select({
          vtt: transcripts.vtt,
          text: transcripts.text,
          language: transcripts.language,
          durationSeconds: transcripts.durationSeconds,
          model: transcripts.model,
        })
        .from(transcripts)
        .where(eq(transcripts.recordingId, recordingId));
      return (
        rows.find((r) => r.vtt && !r.model?.startsWith("translated:")) ??
        rows.find((r) => r.vtt) ??
        null
      );
    });
    if (!source) return skipWith("empty-transcript");

    const vtt = source.vtt ?? "";
    const cues = parseCues(vtt);
    // Imported caption tracks can lack a stored duration; the last cue is as good.
    const durationSeconds = source.durationSeconds ?? cues.at(-1)?.end ?? 0;
    const skip = skipReasonFor(vtt, source.text, durationSeconds);
    if (skip) return skipWith(skip);

    await step.run("assert-model", () => assertModel(CHAPTERS_MODEL));

    const chunks = chunkCues(cues);
    const { maxChapters } = chapterLimits(durationSeconds);
    logger.info(`${recordingId}: ${cues.length} cues in ${chunks.length} chunks, max ${maxChapters} chapters`);

    // Stufe 1: one step per chunk. Inngest checkpoints each, so a retry resumes
    // after the last successful chunk instead of re-inferring from cue 0.
    const results: ChunkBoundaryResult[] = [];
    for (const [i, chunk] of chunks.entries()) {
      // The slice's budget is the recording's budget scaled to the slice.
      const maxBoundaries = Math.max(1, Math.round((maxChapters * chunk.cues.length) / cues.length));
      const boundaries = await step.run(`chunk-${i}`, async () => {
        const out = await chat<ChunkOut>({
          model: CHAPTERS_MODEL,
          system: chaptersSystem(source.language, maxBoundaries),
          user: renderChunkCues(chunk),
          schema: CHAPTERS_SCHEMA as unknown as Record<string, unknown>,
          numCtx: NUM_CTX,
          keepAlive: WARM,
        });
        return Array.isArray(out?.boundaries) ? (out.boundaries as ChunkOut["boundaries"]) : [];
      });
      results.push({ chunk: i, boundaries });
    }

    // Stufe 2: deterministic. Slide changes are optional — no shapes.svg, no snap.
    const chapters = mergeBoundaries(
      collectBoundaries(results, chunks),
      cues,
      durationSeconds,
      readSlideChanges(process.env.RECORDINGS_DIR || undefined, recordingId)
    );

    await step.run("store", () => writeInsight(recordingId, { chapters }));

    // Release the VRAM before anything else wants the card. Not in a finally: a
    // failed run is retried and reloads anyway, and Ollama drops the model on
    // its own timer regardless.
    await step.run("unload-model", () => unload(CHAPTERS_MODEL).then(() => "released"));

    return { recordingId, chapters: chapters.length, chunks: chunks.length };
  }
);

/**
 * Backfill sweep. Mirrors summarizeSweep: completed recordings with a cue-timed
 * transcript and no insights row at all. Rows carrying a skipReason are left
 * alone by design — regenerate clears them. Small per run: the lane is
 * serialised and a recording is ~9 LLM calls.
 */
export const insightsScan = inngest.createFunction(
  { id: "insights/scan", triggers: [{ cron: "45 * * * *" }] },
  async ({ step, logger }) => {
    // INSIGHTS_BATCH=0 keeps the scan idle — for the test phase, when only
    // hand-picked recordings should reach the GPU via POST /insights/:id/regenerate.
    const batch = Number(process.env.INSIGHTS_BATCH ?? 10);
    if (batch <= 0) return { dispatched: 0, idle: true };
    const pending = await step.run("find-missing", async () => {
      // selectDistinct: transcripts has one row per language per recording.
      const rows = await db
        .selectDistinct({ id: recordings.id })
        .from(recordings)
        .innerJoin(transcripts, eq(transcripts.recordingId, recordings.id))
        .leftJoin(insights, eq(insights.recordingId, recordings.id))
        .where(
          and(
            eq(recordings.status, "completed"),
            isNotNull(transcripts.vtt),
            isNull(insights.recordingId)
          )
        )
        .limit(batch);
      return rows.map((r) => r.id);
    });

    if (!pending.length) return { dispatched: 0 };
    logger.info(`insights scan: dispatching ${pending.length}`);
    await step.sendEvent(
      "dispatch-insights",
      pending.map((recordingId) => ({ name: "insights/generate", data: { recordingId } }))
    );
    return { dispatched: pending.length };
  }
);
