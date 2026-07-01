import { inngest } from "../client";
import { db, recordings, transcripts } from "../../lib/db";
import { fetchRecordings, buildWebcamsUrl, uploadCaptionTrack } from "../../lib/bbb";
import { transcribe, cleanupOldTempFiles, TEMP_DIR } from "../../lib/whisper";
import logger from "../../lib/logger";
import { eq } from "drizzle-orm";
import { mkdirSync, unlinkSync } from "fs";
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

const failureEventSchema = z.object({
  data: z.object({
    recordingId: z.string(),
  }),
});

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

      const newOnes = bbbRecordings.filter((r) => !existingIds.has(r.recordId));

      for (const rec of newOnes) {
        await db.insert(recordings).values({
          id: rec.recordId,
          meetingId: rec.meetingId,
          meetingName: rec.meetingName,
          startTime: rec.startTime,
          endTime: rec.endTime,
          videoUrl: rec.videoUrl,
          status: "pending",
        });
      }

      return newOnes.map((r) => ({
        recordingId: r.recordId,
        videoUrl: r.videoUrl,
      }));
    });

    if (newRecordings.length > 0) {
      await step.sendEvent(
        "dispatch-process-events",
        newRecordings.map((r) => ({
          name: "bbb/ingest.process" as const,
          data: { recordingId: r.recordingId, videoUrl: r.videoUrl },
        }))
      );
    }

    return { newRecordings: newRecordings.length };
  }
);

// --- Function 2: Process a single recording (event-triggered) ---

export const processRecording = inngest.createFunction(
  {
    id: "bbb/ingest.process",
    retries: 2,
    // Single GPU: large-v3 + diarization needs ~10-13 GB VRAM, so serialize jobs.
    // Raise only if the GPU has headroom for concurrent runs.
    concurrency: { limit: 1 },
    triggers: [{ event: "bbb/ingest.process" }],
    onFailure: async ({ event, error }) => {
      const parsed = failureEventSchema.safeParse(event);
      if (!parsed.success) return;
      const { recordingId } = parsed.data.data;
      await db.update(recordings)
        .set({
          status: "failed",
          error: error.message,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(recordings.id, recordingId));
    },
  },
  async ({ event, step }) => {
    const parsed = processEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new Error(`Invalid event data: ${parsed.error.message}`);
    }
    const { recordingId, videoUrl } = parsed.data.data;

    const audioPath = await step.run(`download-${recordingId}`, async () => {
      await db.update(recordings)
        .set({ status: "downloading", updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recordings.id, recordingId));

      mkdirSync(TEMP_DIR, { recursive: true });

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
            { recordingId, lang, messageKey: res.messageKey },
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
