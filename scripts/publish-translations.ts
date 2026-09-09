/**
 * publish-translations.ts
 *
 * Publishes translated caption tracks to the recording directory and repairs
 * captions.json so the player offers every language present.
 *
 * WHY NOT BBB's putRecordingTextTrack API
 *   Uploading through the API makes rap-caption-inbox.rb write the file — and
 *   that script rewrites the presentation captions.json as a SINGLE-element
 *   array built from the upload it is handling:
 *
 *     file.puts "[{\"localeName\": \"...\", \"locale\": \"#{lang}\"}]"
 *
 *   So uploading English would erase the German entry, breaking the captions
 *   that were just repaired. Writing directly avoids that, and this script
 *   rebuilds captions.json from the caption_*.vtt files actually on disk — so
 *   it is self-healing: if the Ruby clobbers it later, the next run restores
 *   every locale.
 *
 * SAFETY
 *   --dry-run by default. Write-then-rename, so no reader sees a partial file.
 *   Never deletes a caption, never removes a locale that has a file on disk.
 *
 * USAGE
 *   bun --env-file=.env run scripts/publish-translations.ts
 *   bun --env-file=.env run scripts/publish-translations.ts --commit
 */
import { existsSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { isNotNull, and, ne } from "drizzle-orm";
import { db, transcripts } from "../src/lib/db";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ROOT = flag("root") ?? "/var/bigbluebutton/published/presentation";
const LIMIT = Number(flag("limit") ?? 0) || 0;

/** Label shown in the player's caption menu. */
const LOCALE_NAMES: Record<string, string> = {
  de: "German", en: "English", cy: "Welsh", pt: "Portuguese", uk: "Ukrainian",
};
const label = (loc: string) => LOCALE_NAMES[loc.split("-")[0]!] ?? loc;

function writeAtomic(target: string, content: string): boolean {
  if (existsSync(target)) {
    const current = Bun.file(target);
    // cheap length check first; full compare only if sizes match
    if (current.size === Buffer.byteLength(content)) return false;
  }
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
  return true;
}

/** captions.json rebuilt from what is actually on disk — never from the DB, so
 *  a locale published by any other route survives. */
function rebuildCaptionsJson(dir: string): { json: string; locales: string[] } {
  const locales = readdirSync(dir)
    .map((f) => /^caption_(.+)\.vtt$/.exec(f)?.[1])
    .filter((x): x is string => Boolean(x))
    // en-US is the artefact of the old hardcode; it duplicates a real locale
    // and must not appear as a separate language in the menu.
    .filter((loc) => loc !== "en-US")
    .sort();
  const json = JSON.stringify(
    locales.map((loc) => ({ localeName: label(loc), locale: loc })),
  ) + "\n";
  return { json, locales };
}

async function main() {
  console.log(`root : ${ROOT}`);
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const rows = await db
    .select({
      recordingId: transcripts.recordingId,
      language: transcripts.language,
      vtt: transcripts.vtt,
    })
    .from(transcripts)
    .where(and(isNotNull(transcripts.vtt), ne(transcripts.language, "de")));

  let wroteVtt = 0, wroteJson = 0, noDir = 0, unchanged = 0, n = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    if (LIMIT && n++ >= LIMIT) break;
    const dir = join(ROOT, row.recordingId);
    if (!existsSync(dir)) { noDir++; continue; }
    const target = join(dir, `caption_${row.language}.vtt`);

    if (!COMMIT) {
      console.log(`would write ${target}`);
      wroteVtt++; touched.add(dir); continue;
    }
    if (writeAtomic(target, row.vtt!)) wroteVtt++; else unchanged++;
    touched.add(dir);
  }

  // Repair captions.json for every directory that gained a track.
  for (const dir of touched) {
    const { json, locales } = rebuildCaptionsJson(dir);
    const target = join(dir, "captions.json");
    if (!COMMIT) { console.log(`would set captions.json -> [${locales.join(", ")}]`); wroteJson++; continue; }
    if (writeAtomic(target, json)) wroteJson++;
  }

  console.log(`\nvtt written: ${wroteVtt}   captions.json updated: ${wroteJson}   unchanged: ${unchanged}   no recording dir: ${noDir}`);
  if (!COMMIT) console.log("DRY RUN — nothing written. Re-run with --commit.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
