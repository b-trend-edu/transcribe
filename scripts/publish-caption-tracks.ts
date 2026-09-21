/**
 * publish-caption-tracks.ts
 *
 * Upload caption tracks that exist in the database but were never published to
 * BBB. Reads the VTT straight from `transcripts` — nothing is re-downloaded,
 * re-transcribed or re-translated.
 *
 * WHY THIS EXISTS
 *   Transcription published its German track; translation stored the English
 *   one and stopped. So BBB served a single language, captions.json listed one
 *   locale, and the player's transcript language selector — which only appears
 *   with two or more tracks — never showed up. The translations were real, just
 *   unreachable.
 *
 *   translate.ts now publishes its own track. This is for everything generated
 *   before that.
 *
 * SAFETY
 *   --dry-run by default; --commit uploads. Only ever adds caption tracks;
 *   never deletes a recording or anything else on BBB.
 *
 * USAGE
 *   bun run scripts/publish-caption-tracks.ts                  # dry run, all languages
 *   bun run scripts/publish-caption-tracks.ts --lang en --commit
 *     --lang <code>   only this language (default: every language present)
 *     --limit <n>
 */
import { eq } from "drizzle-orm";
import { db, transcripts } from "../src/lib/db";
import { getRecordingTextTracks, uploadCaptionTrack } from "../src/lib/bbb";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const LANG = flag("lang");
const LIMIT = Number(flag("limit") ?? 0) || 0;

const BASE = process.env.BBB_BASE_URL;
/** Where recordings are SERVED, to check a recording exists before uploading to it. */
const MEDIA_ROOT = (process.env.BBB_MEDIA_ROOT ?? (BASE ?? "").replace(/\/bigbluebutton\/?$/, "")) + "/presentation";
const SECRET = process.env.BBB_SHARED_SECRET;

function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

async function main() {
  if (!BASE || !SECRET) {
    console.error("BBB_BASE_URL / BBB_SHARED_SECRET not set");
    process.exit(1);
  }
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}${LANG ? `   language: ${LANG}` : ""}\n`);

  const rows = await db
    .select({ recordingId: transcripts.recordingId, language: transcripts.language, vtt: transcripts.vtt })
    .from(transcripts);

  const wanted = rows.filter((r) => r.vtt?.trim() && (!LANG || r.language === LANG));

  let uploaded = 0, present = 0, failed = 0, missing = 0, n = 0;
  for (const row of wanted) {
    if (LIMIT && n++ >= LIMIT) break;

    // Skip recordings with no published folder on this server.
    //
    // BBB accepts the upload regardless, then its caption inbox tries to write
    // captions.json into a directory that does not exist, raises ENOENT, and
    // dies — taking down caption processing for every other recording until
    // someone clears the stray file by hand. Uploading a track for a recording
    // that is not here is never useful, so check first.
    const head = await fetch(`${MEDIA_ROOT}/${row.recordingId}/metadata.xml`, { method: "HEAD" })
      .then((r) => r.ok)
      .catch(() => false);
    if (!head) { missing++; continue; }

    // Ask BBB what it already serves rather than assuming — re-uploading an
    // existing track is wasted work and an unnecessary write to production.
    const existing = await getRecordingTextTracks(BASE, SECRET, row.recordingId).catch(() => null);
    const have = new Set((existing ?? []).map((t: { lang?: string }) => t.lang));
    if (have.has(row.language)) { present++; continue; }

    if (!COMMIT) {
      console.log(`would upload ${row.language}  ${row.recordingId}`);
      uploaded++;
      continue;
    }

    const res = await uploadCaptionTrack(
      BASE, SECRET, row.recordingId, row.language, languageLabel(row.language), row.vtt!
    ).catch((e) => ({ success: false, message: String(e) }) as { success: boolean; message?: string });

    if (res.success) {
      uploaded++;
      if (uploaded % 10 === 0) console.log(`  uploaded ${uploaded}`);
    } else {
      failed++;
      console.warn(`  FAILED ${row.language} ${row.recordingId}: ${res.message ?? "rejected"}`);
    }
  }

  console.log(`\nuploaded: ${uploaded}   already on BBB: ${present}   not published here: ${missing}   failed: ${failed}`);
  if (!COMMIT) console.log("DRY RUN — nothing uploaded. Re-run with --commit.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
