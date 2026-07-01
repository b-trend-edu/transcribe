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
