import { inngest } from "../client";
import { NonRetriableError } from "inngest";
import { db, recordings, transcripts } from "../../lib/db";
import { fetchRecordings, buildWebcamsUrl, uploadCaptionTrack } from "../../lib/bbb";
import { transcribe, cleanupOldTempFiles, TEMP_DIR } from "../../lib/whisper";
import { resolveLocalMedia, listLocalRecordingIds, readLocalRecording } from "../../lib/media";
import logger from "../../lib/logger";
import { and, eq, lt, ne } from "drizzle-orm";
import { existsSync, mkdirSync, statSync, unlinkSync, symlinkSync } from "fs";
import { join } from "path";
import * as z from "zod";

/** Human label for a language code, e.g. "en" -> "English"; falls back to the code. */
function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

// Env booleans arrive as strings ("false" is truthy under Boolean()), so coerce
// explicitly from the common truthy tokens.
const envBool = z.preprocess(
  (v) =>
    typeof v === "string"
      ? ["true", "1", "yes", "on"].includes(v.toLowerCase())
      : Boolean(v),
  z.boolean()
);

const envSchema = z
  .object({
    BBB_BASE_URL: z.string(),
    BBB_SHARED_SECRET: z.string().min(1),
    WHISPER_MODEL: z
      .enum(["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"])
      .default("large-v3"),
    // Force the spoken language (e.g. "de") instead of auto-detecting. Recommended
    // for single-language deployments — auto-detect can mislabel short/quiet audio.
    WHISPER_LANGUAGE: z.string().min(2).optional(),
    // Mounted BBB recordings dir (e.g. /recordings -> /var/bigbluebutton/presentation).
    // When the media is found locally under it, transcribe it directly instead of
    // downloading over HTTP. Leave unset to always download.
    RECORDINGS_DIR: z.string().min(1).optional(),
    WHISPERX_DEVICE: z.enum(["cuda", "cpu"]).default("cuda"),
    WHISPERX_COMPUTE_TYPE: z.enum(["float16", "float32", "int8"]).default("float16"),
    WHISPERX_BATCH_SIZE: z.coerce.number().int().positive().default(16),
    DIARIZE: envBool.default(false),
    HF_TOKEN: z.string().min(1).optional(),
    MIN_SPEAKERS: z.coerce.number().int().positive().optional(),
    MAX_SPEAKERS: z.coerce.number().int().positive().optional(),
    // Push the finished VTT back to the BBB recording as a caption track.
    PUBLISH_CAPTIONS: envBool.default(true),
  })
  .refine((e) => !e.DIARIZE || !!e.HF_TOKEN, {
    message: "DIARIZE=true requires HF_TOKEN to be set",
    path: ["HF_TOKEN"],
  });

function getEnv() {
  // Docker/Coolify render `${VAR:-}` defaults as EMPTY STRINGS (present, not
  // undefined). "" bypasses neither .optional() nor .positive(), so drop empty
  // values up front and treat them as unset — otherwise HF_TOKEN/MIN_SPEAKERS/
  // MAX_SPEAKERS="" fail validation and getEnv() throws on every job.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== "")
  );
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Missing required env vars: ${parsed.error.message}`);
  }
  return parsed.data;
}

const processEventSchema = z.object({
  data: z.object({
    recordingId: z.string(),
    videoUrl: z.string(),
  }),
});

// Inngest delivers the internal `inngest/function.failed` payload to onFailure;
// the original `bbb/ingest.process` event (carrying recordingId) is nested under
// `data.event`, not at the top level.
const failureEventSchema = z.object({
  data: z.object({
    event: z.object({
      data: z.object({
        recordingId: z.string(),
      }),
    }),
  }),
});

// Cap how many recordings a single cron run discovers/dispatches. A first run
// against a host with a large backlog would otherwise build one huge
// step.sendEvent that exceeds Inngest's per-request limit (max 5000 events /
// ~256KiB body) and fail the whole send; the remainder drains over later runs.
const DISCOVERY_BATCH = 200;
// Chunk a run's dispatch so even the capped batch stays well under the per-send
// limit and each chunk is its own retryable step.
const DISPATCH_CHUNK = 100;
// Re-dispatch recordings left in 'pending' longer than this. Guards the narrow
// window where a run inserts the row then crashes before sending the process
// event: without a requeue those rows strand forever (every cron dedups on
// presence-in-table, not status). Safe because processRecording is a singleton
// keyed on recording id, so re-poking a row that is merely queued behind the
// single-GPU limit is a no-op.
const STALE_PENDING_SECONDS = 6 * 60 * 60;

// Max transcription jobs to run at once (Inngest concurrency cap on
// processRecording). Default 1: on a single GPU, large-v3 + diarization needs
// ~10-13 GB VRAM, so jobs must serialize. Raise via TRANSCRIBE_CONCURRENCY only
// if the GPU has headroom for parallel runs. Read at module load (registration
// time), so process.env directly rather than the per-job getEnv().
const TRANSCRIBE_CONCURRENCY = Math.max(
  1,
  Math.trunc(Number(process.env.TRANSCRIBE_CONCURRENCY)) || 1
);

// --- Function 1: Sweep BBB for new recordings (cron) ---

export const sweep = inngest.createFunction(
  { id: "bbb/ingest.sweep", triggers: [{ cron: "0 */4 * * *" }] },
  async ({ step }) => {
    await step.run("cleanup-temp-files", async () => {
      cleanupOldTempFiles(24);
    });

    const newRecordings = await step.run("fetch-recordings", async () => {
      const { BBB_BASE_URL, BBB_SHARED_SECRET } = getEnv();
      const bbbRecordings = await fetchRecordings(BBB_BASE_URL, BBB_SHARED_SECRET);

      const existing = await db.select({ id: recordings.id }).from(recordings);
      const existingIds = new Set(existing.map((r) => r.id));

      let newOnes = bbbRecordings.filter((r) => !existingIds.has(r.recordId));
      if (newOnes.length === 0) return [];

      // Oldest-first selection, capped per run: a first sweep against an
      // established server can return a large backlog, so keep this run's dispatch
      // under Inngest's send limit and let later sweeps drain the rest.
      newOnes = [...newOnes]
        .sort((a, b) => a.startTime - b.startTime)
        .slice(0, DISCOVERY_BATCH);

      // Then insert in a stable recordId order (matching the folder scan) so the
      // two concurrent cron transactions acquire row locks on any shared ids in
      // the same order — no deadlock.
      newOnes.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));

      // Insert idempotently inside a transaction and dispatch ONLY rows this run
      // actually inserted. onConflictDoNothing().returning() yields a row only on
      // a real insert, so a race with the folder scan can neither throw a
      // duplicate-key error nor double-dispatch; the transaction makes a mid-loop
      // failure all-or-nothing instead of stranding half-inserted 'pending' rows.
      return await db.transaction(async (tx) => {
        const claimed: Array<{ recordingId: string; videoUrl: string }> = [];
        for (const rec of newOnes) {
          const [row] = await tx
            .insert(recordings)
            .values({
              id: rec.recordId,
              meetingId: rec.meetingId,
              meetingName: rec.meetingName,
              startTime: rec.startTime,
              endTime: rec.endTime,
              videoUrl: rec.videoUrl,
              status: "pending",
            })
            .onConflictDoNothing()
            .returning({ id: recordings.id });
          if (row) {
            claimed.push({ recordingId: rec.recordId, videoUrl: rec.videoUrl });
          }
        }
        return claimed;
      });
    });

    for (let i = 0; i < newRecordings.length; i += DISPATCH_CHUNK) {
      const slice = newRecordings.slice(i, i + DISPATCH_CHUNK);
      await step.sendEvent(
        `dispatch-process-events-${i}`,
        slice.map((r) => ({
          name: "bbb/ingest.process" as const,
          data: { recordingId: r.recordingId, videoUrl: r.videoUrl },
        }))
      );
    }

    return { newRecordings: newRecordings.length };
  }
);

// --- Function 1b: Scan the mounted recordings dir for new recordings (cron) ---
// Discovers recordings straight off disk (no BBB API / no 4h wait) when the
// service runs on the BBB host with the recordings dir mounted. Only rows this
// run actually inserts (onConflictDoNothing + RETURNING) are dispatched, so it
// can race the getRecordings sweep without double-processing. Also re-queues
// recordings stranded in 'pending' by a crash between insert and dispatch, so
// nothing is silently lost.

export const scanRecordings = inngest.createFunction(
  { id: "bbb/ingest.scan", triggers: [{ cron: "0 * * * *" }] },
  async ({ step }) => {
    const discovered = await step.run("scan-local-recordings", async () => {
      const { RECORDINGS_DIR, BBB_BASE_URL } = getEnv();
      if (!RECORDINGS_DIR) return [];

      const ids = listLocalRecordingIds(RECORDINGS_DIR);
      if (ids.length === 0) return [];

      const existing = await db.select({ id: recordings.id }).from(recordings);
      const existingIds = new Set(existing.map((r) => r.id));
      let newIds = ids.filter((id) => !existingIds.has(id));
      if (newIds.length === 0) return [];

      // Oldest-first selection (a record id ends in `-<startMs>`), capped per run
      // so a first scan of a host with thousands of published recordings can't
      // build a send over Inngest's per-request limit; the hourly cron drains the
      // rest.
      newIds.sort(
        (a, b) => (Number(a.split("-").pop()) || 0) - (Number(b.split("-").pop()) || 0)
      );
      const backlog = newIds.length;
      newIds = newIds.slice(0, DISCOVERY_BATCH);

      const origin = new URL(BBB_BASE_URL).origin;

      // Read metadata BEFORE opening the transaction (keeps it short — no file I/O
      // while holding row locks) and insert in a stable recordId order so a
      // concurrent sweep transaction locks any shared rows in the same order — no
      // deadlock. Only rows actually inserted (RETURNING) are dispatched, and the
      // transaction makes a mid-loop failure all-or-nothing so a partial commit
      // can't strand rows in 'pending' with no process event.
      const toInsert = newIds
        .map((id) => readLocalRecording(RECORDINGS_DIR, id, origin))
        .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));

      const claimed = await db.transaction(async (tx) => {
        const rows: Array<{ recordingId: string; videoUrl: string }> = [];
        for (const r of toInsert) {
          const [inserted] = await tx
            .insert(recordings)
            .values({
              id: r.recordId,
              meetingId: r.meetingId,
              meetingName: r.meetingName,
              startTime: r.startTime,
              endTime: r.endTime,
              videoUrl: r.videoUrl,
              status: "pending",
            })
            .onConflictDoNothing()
            .returning({ id: recordings.id });
          if (inserted) rows.push({ recordingId: r.recordId, videoUrl: r.videoUrl });
        }
        return rows;
      });

      logger.info(
        { found: ids.length, backlog, inserted: claimed.length },
        "folder-scan discovered recordings"
      );
      return claimed;
    });

    // Self-heal: re-dispatch recordings left in 'pending' well past insert time —
    // e.g. a crash between the DB commit above and the send below, which would
    // otherwise strand them forever (every cron dedups on presence, not status).
    // Runs even when RECORDINGS_DIR is unset so sweep-inserted rows heal too, and
    // is safe because processRecording is a singleton keyed on recording id: a row
    // merely queued behind the single-GPU limit is skipped, not re-processed.
    const stalePending = await step.run("requeue-stale-pending", async () => {
      const cutoff = Math.floor(Date.now() / 1000) - STALE_PENDING_SECONDS;
      const rows = await db
        .select({ id: recordings.id, videoUrl: recordings.videoUrl })
        .from(recordings)
        .where(and(eq(recordings.status, "pending"), lt(recordings.updatedAt, cutoff)))
        .limit(DISCOVERY_BATCH);
      return rows.map((r) => ({ recordingId: r.id, videoUrl: r.videoUrl }));
    });

    // Dispatch fresh discoveries + stranded rows (deduped by id, since a freshly
    // inserted row is never also stale), chunked to stay under the send limit.
    const seen = new Set<string>();
    const toDispatch = [...discovered, ...stalePending].filter((r) => {
      if (seen.has(r.recordingId)) return false;
      seen.add(r.recordingId);
      return true;
    });

    for (let i = 0; i < toDispatch.length; i += DISPATCH_CHUNK) {
      const slice = toDispatch.slice(i, i + DISPATCH_CHUNK);
      await step.sendEvent(
        `dispatch-scan-process-events-${i}`,
        slice.map((r) => ({
          name: "bbb/ingest.process" as const,
          data: { recordingId: r.recordingId, videoUrl: r.videoUrl },
        }))
      );
    }

    return { discovered: discovered.length, requeued: stalePending.length };
  }
);

// --- Function 2: Process a single recording (event-triggered) ---

export const processRecording = inngest.createFunction(
  {
    id: "bbb/ingest.process",
    retries: 2,
    // Cap simultaneous transcriptions. Default 1 (single GPU: large-v3 +
    // diarization needs ~10-13 GB VRAM); tune with TRANSCRIBE_CONCURRENCY.
    concurrency: { limit: TRANSCRIBE_CONCURRENCY },
    // A recording can be dispatched more than once (the sweep and folder-scan
    // crons overlap, and the stale-'pending' requeue re-pokes stranded rows), so
    // dedupe by recording id: while a run for this id is queued or running, any
    // duplicate event is skipped. Recordings that already completed are guarded
    // separately in the handler (singleton only covers in-flight duplicates).
    singleton: { mode: "skip", key: "event.data.recordingId" },
    triggers: [{ event: "bbb/ingest.process" }],
    onFailure: async ({ event, error }) => {
      const parsed = failureEventSchema.safeParse(event);
      if (!parsed.success) return;
      const { recordingId } = parsed.data.data.event.data;
      // Never clobber a recording that already completed — a late failure of a
      // duplicate/re-dispatched run must not flip a good transcript to 'failed'.
      await db.update(recordings)
        .set({
          status: "failed",
          error: error.message,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(and(eq(recordings.id, recordingId), ne(recordings.status, "completed")));
    },
  },
  async ({ event, step }) => {
    const parsed = processEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`Invalid event data: ${parsed.error.message}`);
    }
    const { recordingId, videoUrl } = parsed.data.data;

    // A duplicate event can arrive after this recording already finished (e.g. a
    // stale-pending requeue whose original run only just completed, or a manual
    // re-ingest). Skip the expensive re-download/transcribe when it's already
    // done. In-flight duplicates are handled upstream by the singleton config.
    const alreadyCompleted = await step.run(`check-status-${recordingId}`, async () => {
      const [row] = await db
        .select({ status: recordings.status })
        .from(recordings)
        .where(eq(recordings.id, recordingId))
        .limit(1);
      return row?.status === "completed";
    });
    if (alreadyCompleted) {
      return { recordingId, status: "completed", skipped: "already completed" };
    }

    const audioPath = await step.run(`download-${recordingId}`, async () => {
      await db.update(recordings)
        .set({ status: "downloading", updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recordings.id, recordingId));

      mkdirSync(TEMP_DIR, { recursive: true });

      // Prefer locally-mounted recording media (service running on the BBB host)
      // to skip the HTTP download. Symlink it into TEMP_DIR so the VTT filename
      // stays unique per recording and cleanup only removes the link — never the
      // source recording under the read-only mount.
      const localMedia = resolveLocalMedia(getEnv().RECORDINGS_DIR, recordingId);
      if (localMedia) {
        const ext = localMedia.endsWith(".mp4") ? "mp4" : "webm";
        const linkPath = join(TEMP_DIR, `${recordingId}.${ext}`);
        try {
          unlinkSync(linkPath);
        } catch {
          // no stale link to clear
        }
        symlinkSync(localMedia, linkPath);
        return linkPath;
      }

      // Idempotent: if a previous attempt already downloaded this media (a
      // function retry, or the step re-running before its result was memoized),
      // reuse it instead of re-fetching the whole video over HTTP.
      for (const ext of ["webm", "mp4"] as const) {
        const existing = join(TEMP_DIR, `${recordingId}.${ext}`);
        if (existsSync(existing) && statSync(existing).size > 0) return existing;
      }

      // `videoUrl` is the HTML playback PAGE, not media. The real audio lives at
      // <origin>/presentation/<id>/video/webcams.{webm,mp4}. Try webm then mp4,
      // and reject HTML responses (a 200 player/error page) so we never hand
      // ffmpeg a web page.
      const candidates: Array<["webm" | "mp4", string]> = [
        ["webm", buildWebcamsUrl(videoUrl, recordingId, "webm")],
        ["mp4", buildWebcamsUrl(videoUrl, recordingId, "mp4")],
      ];

      let lastStatus = 0;
      for (const [ext, mediaUrl] of candidates) {
        const response = await fetch(mediaUrl);
        if (!response.ok) {
          lastStatus = response.status;
          continue;
        }
        if ((response.headers.get("content-type") ?? "").includes("text/html")) {
          lastStatus = 415; // got a page, not media
          continue;
        }
        const outputPath = join(TEMP_DIR, `${recordingId}.${ext}`);
        await Bun.write(outputPath, response);
        return outputPath;
      }

      throw new Error(
        `Could not download recording media for ${recordingId} (last status ${lastStatus})`
      );
    });

    const result = await step.run(`transcribe-${recordingId}`, async () => {
      await db.update(recordings)
        .set({ status: "transcribing", updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recordings.id, recordingId));

      const e = getEnv();
      try {
        return await transcribe(audioPath, {
          model: e.WHISPER_MODEL,
          device: e.WHISPERX_DEVICE,
          computeType: e.WHISPERX_COMPUTE_TYPE,
          batchSize: e.WHISPERX_BATCH_SIZE,
          diarize: e.DIARIZE,
          hfToken: e.HF_TOKEN,
          minSpeakers: e.MIN_SPEAKERS,
          maxSpeakers: e.MAX_SPEAKERS,
          language: e.WHISPER_LANGUAGE,
        });
      } catch (err) {
        // A GPU/driver failure (e.g. CUDA error 803) is environmental, not
        // specific to this recording — every retry re-runs the whole pipeline
        // (re-download + re-transcribe) and fails the same way, wasting minutes
        // per recording. Fail fast so the host gets fixed instead of thrashing.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /\bcuda\b|cudnn|cublas|unsupported display driver|no CUDA-capable device|out of memory|nvidia/i.test(
            msg
          )
        ) {
          throw new NonRetriableError(`GPU unavailable, not retrying: ${msg}`);
        }
        throw err;
      }
    });

    await step.run(`store-${recordingId}`, async () => {
      const { WHISPER_MODEL } = getEnv();
      await db.insert(transcripts)
        .values({
          recordingId,
          text: result.text,
          vtt: result.vtt,
          language: result.language,
          durationSeconds: result.durationSeconds,
          model: WHISPER_MODEL,
        })
        .onConflictDoUpdate({
          target: transcripts.recordingId,
          set: {
            text: result.text,
            vtt: result.vtt,
            language: result.language,
            durationSeconds: result.durationSeconds,
            model: WHISPER_MODEL,
            createdAt: Math.floor(Date.now() / 1000),
          },
        });

      await db.update(recordings)
        .set({ status: "completed", updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recordings.id, recordingId));

      try {
        unlinkSync(audioPath);
      } catch {
        // ignore cleanup errors
      }
    });

    // Best-effort: push the VTT back to the BBB recording as a caption track
    // (async on BBB's side). The transcript is already saved, so a failure here
    // must NOT fail the job or flip the recording back to "failed".
    await step.run(`publish-captions-${recordingId}`, async () => {
      const e = getEnv();
      const lang = e.WHISPER_LANGUAGE ?? result.language;

      if (!e.PUBLISH_CAPTIONS) return { skipped: "disabled" };
      if (!lang || lang === "unknown" || !result.vtt.trim()) {
        return { skipped: "no language or empty vtt" };
      }

      try {
        const res = await uploadCaptionTrack(
          e.BBB_BASE_URL,
          e.BBB_SHARED_SECRET,
          recordingId,
          lang,
          languageLabel(lang),
          result.vtt
        );
        if (!res.success) {
          logger.warn(
            {
              recordingId,
              lang,
              status: res.status,
              messageKey: res.messageKey,
              message: res.message,
              rawBody: res.rawBody,
            },
            "caption upload rejected by BBB"
          );
        }
        return res;
      } catch (err) {
        logger.warn({ recordingId, lang, err }, "caption upload failed");
        return { success: false };
      }
    });

    return { recordingId, status: "completed" };
  }
);
