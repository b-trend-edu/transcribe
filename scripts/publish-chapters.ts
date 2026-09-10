/**
 * publish-chapters.ts
 *
 * Publishes generated chapters from the DB to where the player reads them:
 * <recordId>/chapters.json in the recording root (use-chapters.ts fetches it
 * from there, next to metadata.xml).
 *
 * Same shape and safety as publish-summaries.ts: a file on the existing
 * nginx/S3 path rather than an API; --dry-run by default, --commit writes;
 * write-then-rename so a reader never sees a half-written JSON; never deletes.
 * The per-chapter `gist` stays in the DB — the player schema is { start, title }.
 *
 * USAGE
 *   bun --env-file=.env run scripts/publish-chapters.ts            # dry run
 *   bun --env-file=.env run scripts/publish-chapters.ts --commit
 *     --root <dir>   published presentation dir (default /var/bigbluebutton/published/presentation)
 *     --limit <n>
 */
import { renameSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { isNotNull } from "drizzle-orm";
import { db, insights } from "../src/lib/db";
import type { Chapter } from "../src/lib/chapters";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ROOT = flag("root") ?? "/var/bigbluebutton/published/presentation";
const LIMIT = Number(flag("limit") ?? 0) || 0;

async function main() {
  console.log(`root : ${ROOT}`);
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);

  const rows = await db
    .select({ recordingId: insights.recordingId, chapters: insights.chapters })
    .from(insights)
    .where(isNotNull(insights.chapters));

  let written = 0, skippedMissing = 0, unchanged = 0;
  let n = 0;
  for (const { recordingId, chapters } of rows) {
    if (LIMIT && n++ >= LIMIT) break;
    const dir = join(ROOT, recordingId);
    // Only publish next to a recording that actually exists. A stale DB row for
    // a deleted recording must not create a directory on the production share.
    if (!existsSync(dir)) { skippedMissing++; continue; }

    const target = join(dir, "chapters.json");
    const doc = (chapters as Chapter[]).map(({ start, title }) => ({ start, title }));
    const next = JSON.stringify(doc, null, 2) + "\n";
    if (existsSync(target)) {
      const current = await Bun.file(target).text().catch(() => "");
      if (current === next) { unchanged++; continue; }
    }

    if (!COMMIT) {
      console.log(`would write ${target}  (${doc.length} chapters)`);
      written++;
      continue;
    }
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
