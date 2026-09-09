CREATE TABLE "summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" integer DEFAULT extract(epoch from now())::integer
);
--> statement-breakpoint
ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_recording_id_unique";--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "language" SET DEFAULT 'de';--> statement-breakpoint
-- Existing WhisperX rows may have a NULL language; SET NOT NULL would abort
-- the whole migration on production. Backfill first — everything recorded so
-- far is German.
UPDATE "transcripts" SET "language" = 'de' WHERE "language" IS NULL;--> statement-breakpoint
-- Same hazard for the new unique index: two rows for one recording with the
-- same language would abort it. There should be none (recording_id was unique
-- until the line above), but fail loudly here rather than half-migrated.
ALTER TABLE "transcripts" ALTER COLUMN "language" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "model" SET DEFAULT 'large-v3';--> statement-breakpoint
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "summaries_recording_language_idx" ON "summaries" USING btree ("recording_id","language");--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_recording_language_idx" ON "transcripts" USING btree ("recording_id","language");