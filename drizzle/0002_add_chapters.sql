CREATE TABLE IF NOT EXISTS "chapters" (
	"id" serial PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"language" text NOT NULL,
	"chapters" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" integer DEFAULT extract(epoch from now())::integer
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chapters" ADD CONSTRAINT "chapters_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chapters_recording_language_idx" ON "chapters" ("recording_id","language");
