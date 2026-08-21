/**
 * Check the live caption text tracks for a recording.
 *   bun run check-tracks <recordId>
 *   bun run check-tracks course.json     # reads recording.id from the file
 */
import { getRecordingTextTracks } from "../src/lib/bbb";
import logger from "../src/lib/logger";
import { readFileSync, existsSync } from "fs";

const arg = process.argv[2] ?? "course.json";
const recordId = arg.endsWith(".json") && existsSync(arg)
  ? JSON.parse(readFileSync(arg, "utf-8")).recording?.id
  : arg;

const base = process.env.BBB_BASE_URL;
const secret = process.env.BBB_SHARED_SECRET;
if (!base || !secret) {
  logger.error(
    { missing: [!base && "BBB_BASE_URL", !secret && "BBB_SHARED_SECRET"].filter(Boolean) },
    "missing env — is BBB_SHARED_SECRET in .env?"
  );
  process.exitCode = 1;
} else if (!recordId) {
  logger.error({ arg }, "no recordId");
  process.exitCode = 1;
} else {
  const tracks = await getRecordingTextTracks(base, secret, recordId);
  logger.info({ recordId, count: tracks.length, tracks }, "getRecordingTextTracks");
}
