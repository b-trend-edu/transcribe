/**
 * publish-summaries.ts
 *
 * Publishes generated titles/summaries from the DB to where the player reads
 * them: <recordId>/meta/summary.json, beside thumbs/ and hls/.
 *
 * WHY A FILE AND NOT AN API
 *   The player already fetches derived artifacts over the existing nginx/S3
 *   path, which has private-bucket policy, CORS and local fallback solved. An
 *   API would need auth, CORS and would couple the player's availability to
 *   ai01's. The DB stays the source of truth; this is a published artifact like
 *   the poster.
 *
 * SAFETY
 *   --dry-run by default; --commit writes. Writes to a temp file and renames,
 *   so a reader never sees a half-written JSON. Never deletes.
 *
 * USAGE
 *   bun --env-file=.env run scripts/publish-summaries.ts            # dry run
 *   bun --env-file=.env run scripts/publish-summaries.ts --commit
 *     --root <dir>   published presentation dir (default /var/bigbluebutton/published/presentation)
 *     --limit <n>
 */
import { mkdirSync, renameSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { db, summaries } from "../src/lib/db";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ROOT = flag("root") ?? "/var/bigbluebutton/published/presentation";
const LIMIT = Number(flag("limit") ?? 0) || 0;

type Doc = Record<string, { title: string; summary: string }>;

async function main() {
  console.log(`root : ${ROOT}`);
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const rows = await db
    .select({
      recordingId: summaries.recordingId,
      language: summaries.language,
      title: summaries.title,
      summary: summaries.summary,
    })
    .from(summaries);

  const byRecording = new Map<string, Doc>();
  for (const r of rows) {
    const doc = byRecording.get(r.recordingId) ?? {};
    doc[r.language] = { title: r.title, summary: r.summary };
    byRecording.set(r.recordingId, doc);
  }

  let written = 0, skippedMissing = 0, unchanged = 0;
  let n = 0;
  for (const [recordingId, doc] of byRecording) {
    if (LIMIT && n++ >= LIMIT) break;
    const dir = join(ROOT, recordingId);
    // Only publish next to a recording that actually exists. A stale DB row for
    // a deleted recording must not create a directory on the production share.
    if (!existsSync(dir)) { skippedMissing++; continue; }

    const target = join(dir, "meta", "summary.json");
    const next = JSON.stringify(doc, null, 2) + "\n";
    if (existsSync(target)) {
      const current = await Bun.file(target).text().catch(() => "");
      if (current === next) { unchanged++; continue; }
    }

    if (!COMMIT) {
      console.log(`would write ${target}  (${Object.keys(doc).join(", ")})`);
      written++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    // Write-then-rename: a reader never observes a partial file.
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
