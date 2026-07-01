import { existsSync } from "fs";
import { join } from "path";

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
