import { pgTable, text, integer, real, serial, pgEnum } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

// --- Schema ---

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

export const transcripts = pgTable("transcripts", {
  id: serial("id").primaryKey(),
  recordingId: text("recording_id")
    .notNull()
    .unique()
    .references(() => recordings.id),
  text: text("text").notNull(),
  vtt: text("vtt"),
  language: text("language"),
  durationSeconds: real("duration_seconds"),
  model: text("model").default("large-v3"),
  createdAt: integer("created_at").default(sql`extract(epoch from now())::integer`),
});

// --- DB Instance ---

export type Recording = typeof recordings.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;

const client = postgres(process.env.DATABASE_URL ?? "postgres://inngest:password@localhost:5432/transcribe");
export const db = drizzle(client, { schema: { recordings, transcripts } });
