import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export interface BbbRecording {
  recordId: string;
  meetingId: string;
  meetingName: string;
  startTime: number;
  endTime: number;
  videoUrl: string;
}

export function buildChecksum(
  apiCall: string,
  queryString: string,
  secret: string
): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`${apiCall}${queryString}${secret}`);
  return hasher.digest("hex");
}

export function buildApiUrl(
  baseUrl: string,
  apiCall: string,
  queryString: string,
  secret: string
): string {
  const checksum = buildChecksum(apiCall, queryString, secret);
  return `${baseUrl}/api/${apiCall}?${queryString}&checksum=${checksum}`;
}

/**
 * Map a recording's playback-page URL (what getRecordings returns in
 * `playback.format.url`) to the actual downloadable webcam+audio media.
 *
 * The playback URL is an HTML player page (`…/playback/presentation/2.3/<id>`);
 * the media lives at `<origin>/presentation/<recordId>/video/webcams.<ext>` on
 * the SAME host (see the bbb-player buildFileURL convention). The webcams stream
 * carries the mixed meeting audio (deskshare.webm is muted screen video).
 */
export function buildWebcamsUrl(
  playbackUrl: string,
  recordId: string,
  ext: "webm" | "mp4" = "webm"
): string {
  const origin = new URL(playbackUrl).origin;
  return `${origin}/presentation/${recordId}/video/webcams.${ext}`;
}

const bbbRecordingSchema = z.object({
  recordID: z.coerce.string(),
  meetingID: z.coerce.string(),
  name: z.coerce.string().optional().default(""),
  startTime: z.coerce.number(),
  endTime: z.coerce.number(),
  playback: z
    .object({
      format: z.union([z.array(z.object({ url: z.string().optional() })), z.object({ url: z.string().optional() })]).optional(),
    })
    .or(z.string())
    .optional(),
});

const bbbRecordingsSchema = z
  .object({
    recording: z.array(bbbRecordingSchema).optional(),
  })
  .or(z.string())
  .optional();

const bbbResponseSchema = z.object({
  response: z.object({
    returncode: z.string(),
    message: z.string().optional(),
    recordings: bbbRecordingsSchema,
  }),
});

export function parseRecordingsXml(xml: string): BbbRecording[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => name === "recording" || name === "format",
  });

  const raw = parser.parse(xml);
  const parsed = bbbResponseSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`BBB API response parse error: ${parsed.error.message}`);
  }

  const { response } = parsed.data;

  if (response.returncode !== "SUCCESS") {
    throw new Error(`BBB API error: ${response.message ?? "unknown"}`);
  }

  const recs = response.recordings;
  if (!recs || typeof recs === "string") {
    return [];
  }

  const recordingsNode = recs.recording;
  if (!recordingsNode) {
    return [];
  }

  return recordingsNode
    .map((rec) => {
      const playback = rec.playback;
      if (!playback || typeof playback === "string") return null;
      const formats = playback.format;
      const format = Array.isArray(formats) ? formats[0] : formats;
      const videoUrl = format?.url;

      if (!videoUrl) return null;

      return {
        recordId: rec.recordID,
        meetingId: rec.meetingID,
        meetingName: rec.name ?? "",
        startTime: Math.floor(rec.startTime / 1000),
        endTime: Math.floor(rec.endTime / 1000),
        videoUrl,
      };
    })
    .filter((r): r is BbbRecording => r !== null);
}

export interface CaptionUploadResult {
  success: boolean;
  messageKey?: string;
  message?: string;
}

/**
 * Upload a WebVTT caption track to a published recording via BBB's async
 * `putRecordingTextTrack` API. BBB writes `caption_<lang>.vtt` and a
 * `captions.json` entry into the recording's presentation dir once its caption
 * worker processes the upload (can take a few minutes). Re-uploading the same
 * `kind`+`lang` replaces the existing track.
 *
 * The checksum covers the query string only (not the file body), so we build the
 * query string once and reuse it verbatim for both the checksum and the URL. The
 * VTT is sent as a `multipart/form-data` part named `file` with `text/vtt`.
 */
export async function uploadCaptionTrack(
  baseUrl: string,
  secret: string,
  recordId: string,
  lang: string,
  label: string,
  vtt: string,
  kind: "captions" | "subtitles" = "captions"
): Promise<CaptionUploadResult> {
  const queryString = new URLSearchParams({
    recordID: recordId,
    kind,
    lang,
    label,
  }).toString();
  const url = buildApiUrl(baseUrl, "putRecordingTextTrack", queryString, secret);

  const form = new FormData();
  form.append("file", new Blob([vtt], { type: "text/vtt" }), `caption_${lang}.vtt`);

  const response = await fetch(url, { method: "POST", body: form });
  const xml = await response.text();

  const returncode = xml.match(/<returncode>(.*?)<\/returncode>/)?.[1];
  return {
    success: response.ok && returncode === "SUCCESS",
    messageKey: xml.match(/<messageKey>(.*?)<\/messageKey>/)?.[1],
    message: xml.match(/<message>(.*?)<\/message>/)?.[1],
  };
}

export async function fetchRecordings(
  baseUrl: string,
  secret: string
): Promise<BbbRecording[]> {
  const queryString = "state=published";
  const url = buildApiUrl(baseUrl, "getRecordings", queryString, secret);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`BBB API request failed: ${response.status}`);
  }

  const xml = await response.text();
  return parseRecordingsXml(xml);
}

export interface RecordingMetadata {
  meetingName?: string;
  meetingId?: string;
  startTime?: number; // epoch seconds
  endTime?: number; // epoch seconds
  playbackUrl?: string; // presentation playback page URL
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Parse a BBB *recording* metadata.xml (the per-recording file in the published
 * dir, e.g. .../presentation/<id>/metadata.xml). Defensive across BBB versions:
 * field names have varied, so we try the known aliases and fall back to
 * undefined. Timestamps are epoch MILLISECONDS in the file and returned as epoch
 * SECONDS (matching the recordings table).
 */
export function parseRecordingMetadataXml(xml: string): RecordingMetadata {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml) as Record<string, any>;
  const rec = (parsed?.recording ?? {}) as Record<string, any>;
  const meta = (rec.meta ?? {}) as Record<string, any>;

  const startMs = firstNumber(rec.start_time, rec.start_timestamp, rec.startTime);
  const endMs = firstNumber(rec.end_time, rec.end_timestamp, rec.endTime);

  // <playback> may be a single block or several (one per format); pick the
  // presentation one, else the first. The playback URL is <link> (or <url>).
  const pbRaw = rec.playback;
  const pbList: any[] = Array.isArray(pbRaw) ? pbRaw : pbRaw ? [pbRaw] : [];
  const pres = pbList.find((p) => firstString(p?.format) === "presentation") ?? pbList[0];
  const playbackUrl = firstString(pres?.link, pres?.url);

  return {
    meetingName: firstString(meta.meetingName, meta.name, rec.name),
    meetingId: firstString(meta.meetingId, rec.meetingId),
    startTime: startMs != null ? Math.floor(startMs / 1000) : undefined,
    endTime: endMs != null ? Math.floor(endMs / 1000) : undefined,
    playbackUrl,
  };
}
