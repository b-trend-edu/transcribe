/**
 * Re-run ONLY the caption-publish step for an already-transcribed recording.
 * The VTT + language are read from the `transcripts` table, so nothing is
 * re-downloaded or re-transcribed.
 *
 *   bun run scripts/publish-captions.ts <recordingId> [langOverride]
 */
import { db, transcripts } from "../src/lib/db";
import { uploadCaptionTrack } from "../src/lib/bbb";
import { eq } from "drizzle-orm";

function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

const recordingId = process.argv[2];
const langOverride = process.argv[3];
if (!recordingId) {
  console.error("usage: bun run scripts/publish-captions.ts <recordingId> [langOverride]");
  process.exit(1);
}

const BBB_BASE_URL = process.env.BBB_BASE_URL;
const BBB_SHARED_SECRET = process.env.BBB_SHARED_SECRET;
if (!BBB_BASE_URL || !BBB_SHARED_SECRET) {
  console.error("BBB_BASE_URL and BBB_SHARED_SECRET must be set");
  process.exit(1);
}

const [row] = await db
  .select()
  .from(transcripts)
  .where(eq(transcripts.recordingId, recordingId));

if (!row) {
  console.error(`No transcript found for recording ${recordingId}`);
  process.exit(1);
}

const lang = langOverride ?? row.language ?? "de";
if (!row.vtt?.trim()) {
  console.error(`Transcript for ${recordingId} has no VTT content`);
  process.exit(1);
}

const res = await uploadCaptionTrack(
  BBB_BASE_URL,
  BBB_SHARED_SECRET,
  recordingId,
  lang,
  languageLabel(lang),
  row.vtt
);

console.log(JSON.stringify({ recordingId, lang, ...res }, null, 2));
process.exit(res.success ? 0 : 1);
