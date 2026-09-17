/**
 * publish-derived.ts
 *
 * Backfill: push every generated summary and chapter list in the database to
 * the recording bucket, where nginx serves them onto the player's origin.
 *
 * Replaces publish-summaries.ts / publish-chapters.ts, which wrote into
 * /var/bigbluebutton/published — the live production share, reachable only by
 * shelling into a BBB host. New runs publish themselves (see the publish-to-s3
 * step in summarize.ts and chapters.ts); this is for everything generated
 * before that existed, and for re-publishing after a prompt change.
 *
 * SAFETY
 *   --dry-run by default; --commit writes. Only ever writes under
 *   `presentation/<recordId>/meta/`, never touches anything BBB produced, and
 *   never deletes. Skips objects whose content is already identical.
 *
 * USAGE
 *   bun --env-file=.env run scripts/publish-derived.ts            # dry run
 *   bun --env-file=.env run scripts/publish-derived.ts --commit
 *     --only summaries|chapters     (default: both)
 *     --limit <n>
 */
import { eq } from "drizzle-orm";
import { chapters, db, summaries } from "../src/lib/db";
import { disabledReason, enabled, getJson, metaKey, putJson } from "../src/lib/s3";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const COMMIT = args.includes("--commit");
const ONLY = flag("only");
const LIMIT = Number(flag("limit") ?? 0) || 0;

type Doc = Record<string, unknown>;

async function publishAll(
  name: string,
  file: string,
  docs: Map<string, Doc>,
): Promise<void> {
  console.log(`\n${name}: ${docs.size} recording(s)`);
  let written = 0, unchanged = 0, n = 0;
  for (const [recordingId, doc] of docs) {
    if (LIMIT && n++ >= LIMIT) break;
    const key = metaKey(recordingId, file);

    const current = await getJson<Doc>(key);
    if (current && JSON.stringify(current) === JSON.stringify(doc)) { unchanged++; continue; }

    if (!COMMIT) {
      console.log(`  would write ${key}  (${Object.keys(doc).join(", ")})`);
      written++;
      continue;
    }
    await putJson(key, doc);
    written++;
    if (written % 25 === 0) console.log(`  published ${written}`);
  }
  console.log(`${name}: written ${written}, unchanged ${unchanged}`);
}

async function main() {
  if (!enabled()) {
    console.error(`S3 ${disabledReason()} — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY`);
    process.exit(1);
  }
  console.log(`mode : ${COMMIT ? "COMMIT" : "DRY RUN"}`);

  if (ONLY !== "chapters") {
    const rows = await db
      .select({ recordingId: summaries.recordingId, language: summaries.language, title: summaries.title, summary: summaries.summary })
      .from(summaries);
    const docs = new Map<string, Doc>();
    for (const r of rows) {
      const doc = (docs.get(r.recordingId) ?? {}) as Doc;
      doc[r.language] = { title: r.title, summary: r.summary };
      docs.set(r.recordingId, doc);
    }
    await publishAll("summaries", "summary.json", docs);
  }

  if (ONLY !== "summaries") {
    const rows = await db
      .select({ recordingId: chapters.recordingId, language: chapters.language, chapters: chapters.chapters })
      .from(chapters);
    const docs = new Map<string, Doc>();
    for (const r of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(r.chapters); } catch { console.warn(`  skip ${r.recordingId}/${r.language}: bad JSON`); continue; }
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const doc = (docs.get(r.recordingId) ?? {}) as Doc;
      doc[r.language] = parsed;
      docs.set(r.recordingId, doc);
    }
    await publishAll("chapters", "chapters.json", docs);
  }

  if (!COMMIT) console.log("\nDRY RUN — nothing written. Re-run with --commit.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
