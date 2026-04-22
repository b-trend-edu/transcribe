CREATE TYPE "public"."recording_status" AS ENUM('pending', 'downloading', 'transcribing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"meeting_name" text,
	"start_time" integer,
	"end_time" integer,
	"video_url" text NOT NULL,
	"status" "recording_status" DEFAULT 'pending',
	"error" text,
	"created_at" integer DEFAULT extract(epoch from now())::integer,
	"updated_at" integer DEFAULT extract(epoch from now())::integer
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"text" text NOT NULL,
	"vtt" text,
	"language" text,
	"duration_seconds" real,
	"model" text DEFAULT 'base',
	"created_at" integer DEFAULT extract(epoch from now())::integer,
	CONSTRAINT "transcripts_recording_id_unique" UNIQUE("recording_id")
);
--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE no action ON UPDATE no action;