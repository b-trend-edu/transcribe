import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import { parseRecordingMetadataXml, type RecordingMetadata } from "./bbb";

// BBB record IDs (and their published-recording directory names) look like
// `<sha1hex>-<unix_ms>`, where the trailing ms is the meeting start time.
const RECORD_ID = /^[a-f0-9]+-\d+$/;

export interface LocalRecording {
  recordId: string;
  meetingId: string;
  meetingName: string;
  startTime: number | null; // epoch seconds
  endTime: number | null; // epoch seconds
  videoUrl: string; // playback page URL (used only for the HTTP download fallback)
}

/**
 * Path to a recording's locally-mounted webcam media, or null if not present.
 *
 * When the service runs on the BBB host, the recording dir can be mounted in
 * (read-only) so we transcribe the media directly instead of downloading it over
 * HTTP. Follows the BBB layout: `<recordingsDir>/<recordId>/video/webcams.{webm,mp4}`.
 */
export function resolveLocalMedia(
  recordingsDir: string | undefined,
  recordId: string
): string | null {
  if (!recordingsDir) return null;
  for (const ext of ["webm", "mp4"] as const) {
    const p = join(recordingsDir, recordId, "video", `webcams.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Record IDs of transcribable recordings present under the mounted dir: direct
 * children whose name is a BBB record ID and that have webcam media. Used by the
 * folder-scan discovery. Never throws — a missing/unreadable dir yields [].
 */
export function listLocalRecordingIds(recordingsDir: string | undefined): string[] {
  if (!recordingsDir || !existsSync(recordingsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(recordingsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => {
    if (!RECORD_ID.test(name)) return false;
    try {
      if (!statSync(join(recordingsDir, name)).isDirectory()) return false;
    } catch {
      return false;
    }
    return resolveLocalMedia(recordingsDir, name) !== null;
  });
}

/**
 * Build a recordings-table row for a locally-discovered recording. Reads
 * `<dir>/<id>/metadata.xml` (best-effort) for the meeting name / times / playback
 * link, falling back to values derived from the record ID: the `-<ms>` suffix is
 * the start time, and a synthetic playback URL is composed from `baseOrigin`
 * (only ever used if the local media is later missing and we fall back to HTTP).
 */
export function readLocalRecording(
  recordingsDir: string,
  recordId: string,
  baseOrigin: string
): LocalRecording {
  const suffix = Number(recordId.split("-").pop());
  const startFromId = Number.isFinite(suffix) ? Math.floor(suffix / 1000) : null;

  let meta: RecordingMetadata = {};
  try {
    const xml = readFileSync(join(recordingsDir, recordId, "metadata.xml"), "utf-8");
    meta = parseRecordingMetadataXml(xml);
  } catch {
    // metadata.xml missing/unreadable — fall back to id-derived values.
  }

  return {
    recordId,
    meetingId: meta.meetingId ?? recordId,
    meetingName: meta.meetingName ?? recordId,
    startTime: meta.startTime ?? startFromId,
    endTime: meta.endTime ?? null,
    videoUrl: meta.playbackUrl ?? `${baseOrigin}/playback/presentation/2.3/${recordId}`,
  };
}
