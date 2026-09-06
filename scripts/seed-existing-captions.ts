/**
 * seed-existing-captions.ts
 *
 * Imports captions that already exist on the BBB server into the transcribe DB,
 * so a first sweep against an established host does not re-transcribe hundreds
 * of recordings that are already captioned.
 *
 * WHY THIS EXISTS
 *   The normal guard is findExistingCaption() -> getRecordingTextTracks. That
 *   API returns {"returncode":"FAILED","messageKey":"noRecordings"} for every
 *   recording whose bbb-web index does not contain it — e.g. recordings served
 *   off a shared storage mount but published by a different server. The guard
 *   catches the error and returns { found: false }, i.e. it FAILS OPEN and
 *   queues a full GPU transcription for every already-captioned recording.
 *
 *   This script bypasses the API and reads the published caption files directly
 *   over HTTP, which are served statically:
 *       /presentation/<recordID>/captions.json      -> [{"localeName","locale"}]
 *       /presentation/<recordID>/caption_<lang>.vtt -> WEBVTT
 *
 * SAFETY
 *   - --dry-run (default) writes nothing; use --commit to persist.
 *   - Never overwrites an existing transcript row.
 *   - Recordings are inserted with status 'completed' so the sweep's
 *     presence-based dedup skips them.
 *   - Read-only against BBB: it only GETs static files.
 *
 * USAGE
 *   bun scripts/seed-existing-captions.ts --dry-run
 *   bun scripts/seed-existing-captions.ts --commit
 *
 *   --host   <url>   base host serving /presentation (default: BBB_BASE_URL's origin)
 *   --ids    <file>  newline-separated recordIDs; otherwise fetched via getRecordings
 *   --lang   <code>  preferred caption language (default: WHISPER_LANGUAGE or "de")
 *   --limit  <n>     only consider the first n recordings
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { db, recordings, transcripts } from "../src/lib/db";
import { eq, inArray } from "drizzle-orm";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const COMMIT = has("commit");
const LIMIT = Number(flag("limit") ?? 0) || 0;
const PREFERRED_LANG = (flag("lang") ?? process.env.WHISPER_LANGUAGE ?? "de").toLowerCase();
const IDS_FILE = flag("ids");

const BBB_BASE_URL = process.env.BBB_BASE_URL ?? "";
const BBB_SHARED_SECRET = process.env.BBB_SHARED_SECRET ?? "";
const HOST = (flag("host") ?? (BBB_BASE_URL ? new URL(BBB_BASE_URL).origin : "")).replace(/\/$/, "");

if (!HOST) {
  console.error("ERROR: need --host or BBB_BASE_URL");
  process.exit(1);
}

const CONCURRENCY = 8;

/** BBB checksum: sha1(callName + queryString + sharedSecret) */
function checksum(call: string, query: string): string {
  return createHash("sha1").update(call + query + BBB_SHARED_SECRET).digest("hex");
}

async function get(url: string, timeoutMs = 30_000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Recording ids + the fields we need for a `recordings` row. */
type RecMeta = { id: string; meetingId: string; meetingName: string | null; start: number | null; end: number | null };

async function fetchRecordingList(): Promise<RecMeta[]> {
  if (IDS_FILE) {
    const ids = readFileSync(IDS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    return ids.map((id) => ({ id, meetingId: id, meetingName: null, start: null, end: null }));
  }
  if (!BBB_SHARED_SECRET) {
    console.error("ERROR: no --ids file and BBB_SHARED_SECRET is unset");
    process.exit(1);
  }
  const url = `${BBB_BASE_URL.replace(/\/$/, "")}/api/getRecordings?checksum=${checksum("getRecordings", "")}`;
  const xml = await (await get(url, 120_000)).text();
  if (!xml.includes("<returncode>SUCCESS</returncode>")) {
    console.error("ERROR: getRecordings failed:\n" + xml.slice(0, 400));
    process.exit(1);
  }
  const out: RecMeta[] = [];
  for (const block of xml.split("<recording>").slice(1)) {
    const pick = (tag: string) => block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
    const id = pick("recordID");
    if (!id) continue;
    out.push({
      id,
      meetingId: pick("meetingID") ?? id,
      meetingName: pick("name"),
      // BBB returns epoch MILLISECONDS; the column is a 32-bit integer and the
      // normal ingest path stores seconds (src/lib/bbb.ts:123). Match it.
      start: Number(pick("startTime")) ? Math.floor(Number(pick("startTime")) / 1000) : null,
      end: Number(pick("endTime")) ? Math.floor(Number(pick("endTime")) / 1000) : null,
    });
  }
  return out;
}

/** Normalise de-DE / de_DE -> de */
const norm = (l: string) => l.toLowerCase().replace("_", "-").split("-")[0]!;

/** VTT -> plain text: drop headers, cue numbers, timestamps; join cue text. */
function vttToText(vtt: string): string {
  const lines = vtt.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === "WEBVTT" || t.startsWith("NOTE") || t.startsWith("STYLE")) continue;
    if (t.includes("-->")) continue;
    if (/^\d+$/.test(t)) continue;
    out.push(t);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Last cue end timestamp -> seconds. */
function vttDuration(vtt: string): number | null {
  const stamps = [...vtt.matchAll(/(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->/g)];
  const last = stamps[stamps.length - 1];
  if (!last) return null;
  const h = Number((last[1] ?? "0:").replace(":", "")) || 0;
  return h * 3600 + Number(last[2]) * 60 + Number(last[3]) + Number(last[4]) / 1000;
}

type Found = { rec: RecMeta; lang: string; vtt: string; text: string; seconds: number | null };

async function probe(rec: RecMeta): Promise<Found | null> {
  const base = `${HOST}/presentation/${rec.id}`;
  let locales: string[] = [];
  try {
    const r = await get(`${base}/captions.json`, 20_000);
    if (!r.ok) return null;
    const body = await r.text();
    if (body.trim().length <= 3) return null; // "[]"
    const parsed = JSON.parse(body) as Array<{ locale?: string }>;
    locales = parsed.map((p) => p.locale).filter((x): x is string => !!x);
  } catch {
    return null;
  }
  if (!locales.length) return null;

  // Prefer the configured language; otherwise take the first declared locale.
  const ordered = [
    ...locales.filter((l) => norm(l) === PREFERRED_LANG),
    ...locales.filter((l) => norm(l) !== PREFERRED_LANG),
  ];

  for (const loc of ordered) {
    for (const candidate of [`caption_${loc}.vtt`, `caption_${norm(loc)}.vtt`]) {
      try {
        const r = await get(`${base}/${candidate}`, 60_000);
        if (!r.ok) continue;
        const vtt = await r.text();
        if (!vtt.includes("-->")) continue;
        const text = vttToText(vtt);
        if (text.length < 20) continue; // empty/placeholder track
        return { rec, lang: norm(loc), vtt, text, seconds: vttDuration(vtt) };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    })
  );
  return out;
}

async function main() {
  console.log(`host           : ${HOST}`);
  console.log(`preferred lang : ${PREFERRED_LANG}`);
  console.log(`mode           : ${COMMIT ? "COMMIT (will write)" : "DRY RUN (no writes)"}`);
  console.log("");

  let list = await fetchRecordingList();
  if (LIMIT) list = list.slice(0, LIMIT);
  console.log(`recordings to consider: ${list.length}`);

  // Skip anything already in the DB — never touch existing rows.
  const existing = new Set<string>();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500).map((r) => r.id);
    const rows = await db.select({ id: recordings.id }).from(recordings).where(inArray(recordings.id, chunk));
    rows.forEach((r) => existing.add(r.id));
  }
  const candidates = list.filter((r) => !existing.has(r.id));
  console.log(`already in DB         : ${existing.size}`);
  console.log(`candidates            : ${candidates.length}`);
  console.log("");

  process.stdout.write("probing captions");
  let done = 0;
  const results = await mapLimit(candidates, CONCURRENCY, async (rec) => {
    const r = await probe(rec);
    if (++done % 25 === 0) process.stdout.write(".");
    return r;
  });
  process.stdout.write("\n\n");

  const found = results.filter((r): r is Found => r !== null);
  const missing = candidates.length - found.length;

  const byLang = found.reduce<Record<string, number>>((a, f) => ((a[f.lang] = (a[f.lang] ?? 0) + 1), a), {});
  console.log(`WITH captions   : ${found.length}   ${JSON.stringify(byLang)}`);
  console.log(`WITHOUT         : ${missing}  <- these are what the GPU would transcribe`);
  console.log("");

  if (found.length) {
    console.log("sample:");
    for (const f of found.slice(0, 5)) {
      console.log(
        `  ${f.rec.id.slice(0, 34)}  lang=${f.lang}  ${f.text.length} chars  ${
          f.seconds ? Math.round(f.seconds / 60) + " min" : "?"
        }`
      );
    }
    console.log("");
  }

  if (!COMMIT) {
    console.log("DRY RUN — nothing written. Re-run with --commit to import.");
    process.exit(0);
  }

  let inserted = 0;
  for (const f of found) {
    await db.transaction(async (tx) => {
      await tx
        .insert(recordings)
        .values({
          id: f.rec.id,
          meetingId: f.rec.meetingId,
          meetingName: f.rec.meetingName,
          startTime: f.rec.start,
          endTime: f.rec.end,
          videoUrl: `${HOST}/presentation/${f.rec.id}/video/webcams.mp4`,
          status: "completed",
        })
        .onConflictDoNothing();
      await tx
        .insert(transcripts)
        .values({
          recordingId: f.rec.id,
          text: f.text,
          vtt: f.vtt,
          language: f.lang,
          durationSeconds: f.seconds,
          model: "imported:bbb",
        })
        .onConflictDoNothing();
    });
    inserted++;
    if (inserted % 25 === 0) console.log(`  imported ${inserted}/${found.length}`);
  }

  console.log("");
  console.log(`DONE — imported ${inserted} recordings as status=completed, model=imported:bbb`);
  console.log(`${missing} recordings have no captions and remain for transcription.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
