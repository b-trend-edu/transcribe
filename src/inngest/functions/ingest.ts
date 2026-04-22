import { inngest } from "../client";
import { db, recordings, transcripts } from "../../lib/db";
import { fetchRecordings } from "../../lib/bbb";
import { transcribe, cleanupOldTempFiles, TEMP_DIR } from "../../lib/whisper";
import { eq } from "drizzle-orm";
import { mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import * as z from "zod";

const envSchema = z.object({
  BBB_BASE_URL: z.string(),
  BBB_SHARED_SECRET: z.string().min(1),
  WHISPER_MODEL: z.enum(["tiny", "base", "small", "medium", "large"]).default("base"),
});

function getEnv() {
  const parsed = envSchema.safeParse(process.env);
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
    concurrency: { limit: 2 },
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
      const outputPath = join(TEMP_DIR, `${recordingId}.mp4`);

      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      await Bun.write(outputPath, response);
      return outputPath;
    });

    const result = await step.run(`transcribe-${recordingId}`, async () => {
      await db.update(recordings)
        .set({ status: "transcribing", updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(recordings.id, recordingId));

      return await transcribe(audioPath, getEnv().WHISPER_MODEL);
    });

    await step.run(`store-${recordingId}`, async () => {
      const { WHISPER_MODEL } = getEnv();
      await db.insert(transcripts)
        .values({
          recordingId,
          text: result.text,
          vtt: result.vtt,
          language: result.language,
          model: WHISPER_MODEL,
        })
        .onConflictDoUpdate({
          target: transcripts.recordingId,
          set: {
            text: result.text,
            vtt: result.vtt,
            language: result.language,
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

    return { recordingId, status: "completed" };
  }
);
