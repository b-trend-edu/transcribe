/**
 * publish-chapters.ts
 *
 * Publishes generated chapters from the DB to where the player reads them:
 * <recordId>/chapters.json, at the recording root beside metadata.xml.
 *
 * WHY THE RECORDING ROOT AND NOT meta/
 *   The player's chapter contract predates the summary one and already points
 *   at the root (`buildFileURL("chapters.json")`). Moving it would mean shipping
 *   a player change for no gain, so the file goes where the deployed bundle is
 *   already looking.
 *
 * SHAPE
 *   { "de": [{ "start": 0, "title": "Einführung" }], "en": [...] }
 *   `start` is recording-relative seconds — the same clock as the seek bar. A
 *   legacy flat array is still accepted by the player, but never written here.
 *
 * SAFETY
 *   --dry-run by default; --commit writes. Writes to a temp file and renames, so
 *   a reader never sees half a document. Never deletes. Skips any recording that
 *   has no directory on the share — a stale DB row must not create one.
 *
 * USAGE
 *   bun --env-file=.env run scripts/publish-chapters.ts            # dry run
 *   bun --env-file=.env run scripts/publish-chapters.ts --commit
 *     --root <dir>   published presentation dir (default /var/bigbluebutton/published/presentation)
 *     --limit <n>
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { chapters } from "../src/lib/db";
import { db } from "../src/lib/db";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ROOT = flag("root") ?? "/var/bigbluebutton/published/presentation";
const LIMIT = Number(flag("limit") ?? 0) || 0;

type Entry = { start: number; title: string };
type Doc = Record<string, Entry[]>;

async function main() {
  console.log(`root : ${ROOT}`);
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const rows = await db
    .select({
      recordingId: chapters.recordingId,
      language: chapters.language,
      chapters: chapters.chapters,
    })
    .from(chapters);

  const byRecording = new Map<string, Doc>();
  for (const row of rows) {
    let parsed: Entry[];
    try {
      parsed = JSON.parse(row.chapters) as Entry[];
    } catch {
      console.warn(`skip ${row.recordingId}/${row.language}: unparseable chapters JSON`);
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const doc = byRecording.get(row.recordingId) ?? {};
    doc[row.language] = parsed;
    byRecording.set(row.recordingId, doc);
  }

  let written = 0, skippedMissing = 0, unchanged = 0, n = 0;
  for (const [recordingId, doc] of byRecording) {
    if (LIMIT && n++ >= LIMIT) break;
    const dir = join(ROOT, recordingId);
    if (!existsSync(dir)) { skippedMissing++; continue; }

    const target = join(dir, "chapters.json");
    const next = JSON.stringify(doc, null, 2) + "\n";
    if (existsSync(target)) {
      const current = await Bun.file(target).text().catch(() => "");
      if (current === next) { unchanged++; continue; }
    }

    if (!COMMIT) {
      const counts = Object.entries(doc).map(([l, v]) => `${l}:${v.length}`).join(", ");
      console.log(`would write ${target}  (${counts})`);
      written++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, target);
    written++;
    if (written % 25 === 0) console.log(`  published ${written}`);
  }

  console.log(`\nwritten: ${written}   unchanged: ${unchanged}   no recording dir: ${skippedMissing}`);
  if (!COMMIT) console.log("DRY RUN — nothing written. Re-run with --commit.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
