/**
 * Publishing derived artifacts to the recording bucket.
 *
 * WHY S3 AND NOT THE SHARE
 *   `/var/bigbluebutton/published` is the live production recording tree, shared
 *   read-write by two BBB hosts and backed by a Storage Box with no versioning.
 *   Writing generated files into it means this machine needs shell access to a
 *   production box, and every publish is a hand-run step. The bucket is already
 *   where derived artifacts live (HLS segments, thumbnails), nginx already
 *   proxies them onto the player's origin, and writing there needs nothing but
 *   a key.
 *
 * KEY LAYOUT — must match the nginx rule exactly
 *   nginx: proxy_pass https://<endpoint>/<bucket>$uri
 *   with   $uri = /presentation/<recordId>/<kind>/<rest>
 *   so the object key is `presentation/<recordId>/<kind>/<rest>` — no leading
 *   slash, same shape rclone uses for hls/ and thumbs/.
 *
 *   Everything generated here goes under `meta/`, so ONE nginx prefix covers
 *   every present and future derived document.
 *
 * DISABLED BY DEFAULT
 *   No credentials configured ⇒ `enabled()` is false and callers skip
 *   publishing rather than failing. A generated summary sitting in the database
 *   unpublished is a delay; a summarisation run that fails at the last step
 *   because a key is missing is lost GPU time.
 */
const ENDPOINT = process.env.S3_ENDPOINT ?? "";
const BUCKET = process.env.S3_BUCKET ?? "";
const ACCESS_KEY = process.env.S3_ACCESS_KEY ?? "";
const SECRET_KEY = process.env.S3_SECRET_KEY ?? "";
const REGION = process.env.S3_REGION ?? "auto";
/** Recording format prefix; `presentation` for every recording BBB makes here. */
const FORMAT = process.env.S3_FORMAT ?? "presentation";

export function enabled(): boolean {
  return Boolean(ENDPOINT && BUCKET && ACCESS_KEY && SECRET_KEY);
}

/** Human-readable reason publishing is off, for logs. */
export function disabledReason(): string {
  const missing = [
    !ENDPOINT && "S3_ENDPOINT",
    !BUCKET && "S3_BUCKET",
    !ACCESS_KEY && "S3_ACCESS_KEY",
    !SECRET_KEY && "S3_SECRET_KEY",
  ].filter(Boolean);
  return missing.length ? `not configured (${missing.join(", ")})` : "configured";
}

function client() {
  return new Bun.S3Client({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    bucket: BUCKET,
    endpoint: ENDPOINT,
    region: REGION,
  });
}

/** `presentation/<recordId>/meta/<name>` — the key the player's URL resolves to. */
export function metaKey(recordingId: string, name: string): string {
  return `${FORMAT}/${recordingId}/meta/${name}`;
}

/**
 * Write one derived JSON document.
 *
 * Returns the key on success. Throws on failure: unlike a missing key (which
 * disables publishing entirely), a rejected write is a real fault the caller
 * should retry — Inngest wraps this in a step.
 */
export async function putJson(key: string, value: unknown): Promise<string> {
  if (!enabled()) throw new Error(`S3 publishing ${disabledReason()}`);
  const body = JSON.stringify(value, null, 2) + "\n";
  await client().write(key, body, { type: "application/json; charset=utf-8" });
  return key;
}

/** Read a derived document back, or null when it is absent. Used to skip
 *  rewriting an object that is already identical. */
export async function getJson<T>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  try {
    const file = client().file(key);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}
