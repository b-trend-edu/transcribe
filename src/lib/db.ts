import { pgTable, text, integer, real, serial, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";


export const statusEnum = pgEnum("recording_status", [
  "pending",
  "downloading",
  "transcribing",
  "completed",
  "failed",
]);

export const recordings = pgTable("recordings", {
  id: text("id").primaryKey(), // BBB recordID
  meetingId: text("meeting_id").notNull(),
  meetingName: text("meeting_name"),
  startTime: integer("start_time"),
  endTime: integer("end_time"),
  videoUrl: text("video_url").notNull(),
  status: statusEnum("status").default("pending"),
  error: text("error"),
  createdAt: integer("created_at").default(sql`extract(epoch from now())::integer`),
  updatedAt: integer("updated_at").default(sql`extract(epoch from now())::integer`),
});

// One row PER LANGUAGE, not per recording: the German original comes from
// WhisperX, the English one from a local translation pass. `recordingId` used to
// be unique on its own, which made a second language impossible to store.
export const transcripts = pgTable(
  "transcripts",
  {
    id: serial("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id),
    text: text("text").notNull(),
    vtt: text("vtt"),
    language: text("language").notNull().default("de"),
    durationSeconds: real("duration_seconds"),
    // "large-v3" for WhisperX output, "translated:<model>" for a derived one, so
    // a regeneration can target only what a given model produced.
    model: text("model").default("large-v3"),
    createdAt: integer("created_at").default(sql`extract(epoch from now())::integer`),
  },
  (t) => ({
    recordingLanguage: uniqueIndex("transcripts_recording_language_idx").on(
      t.recordingId,
      t.language
    ),
  })
);

// Generated title + summary, one row per (recording, language).
//
// A separate table rather than columns on `recordings`: prompts and models will
// change, and a regeneration must not touch the row that mirrors BBB. A failed
// generation likewise leaves the recording untouched.
export const summaries = pgTable(
  "summaries",
  {
    id: serial("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id),
    language: text("language").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // Which model and which prompt produced this. promptVersion is what lets you
    // find everything generated before a prompt change without re-reading text.
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").default(sql`extract(epoch from now())::integer`),
  },
  (t) => ({
    recordingLanguage: uniqueIndex("summaries_recording_language_idx").on(
      t.recordingId,
      t.language
    ),
  })
);

// --- DB Instance ---

export type Recording = typeof recordings.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type Summary = typeof summaries.$inferSelect;

const client = postgres(process.env.DATABASE_URL ?? "postgres://inngest:password@localhost:5432/transcribe");
export const db = drizzle(client, { schema: { recordings, transcripts, summaries } });
