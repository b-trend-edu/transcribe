CREATE TABLE "insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"chapters" jsonb,
	"model" text,
	"prompt_version" text,
	"skip_reason" text,
	"created_at" integer DEFAULT extract(epoch from now())::integer,
	CONSTRAINT "insights_recording_id_unique" UNIQUE("recording_id")
);
--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE no action ON UPDATE no action;