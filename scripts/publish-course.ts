/**
 * Publish the caption track for a course.json ({ recording, transcript }) to BBB.
 * Sends the transcript's VTT to BBB's putRecordingTextTrack API — the same call
 * the ingest pipeline's publish-captions step uses. No re-transcription.
 *
 *   bun run publish-course course.json                # uses stored language
 *   bun run publish-course course.json de             # force language
 *   bun run publish-course course.json de subtitles   # kind = subtitles
 */
import { uploadCaptionTrack, getRecordingTextTracks } from "../src/lib/bbb";
import logger from "../src/lib/logger";
import { readFileSync } from "fs";

/** Human label for a language code, e.g. "de" -> "German"; falls back to the code. */
function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/**
 * Returns a process exit code. We deliberately DON'T call process.exit() — pino's
 * pino-pretty transport runs in a worker thread, and process.exit() kills it
 * mid-flush, dropping the final log line(s). Setting process.exitCode and letting
 * the script end naturally lets the worker finish writing first.
 */
async function main(): Promise<number> {
  const inPath = process.argv[2];
  const langOverride = process.argv[3];
  const kind = (process.argv[4] as "captions" | "subtitles") ?? "captions";
  if (!inPath) {
    logger.error("usage: bun run publish-course <course.json> [lang] [captions|subtitles]");
    return 1;
  }

  const BBB_BASE_URL = process.env.BBB_BASE_URL;
  const BBB_SHARED_SECRET = process.env.BBB_SHARED_SECRET;
  const missing = [
    !BBB_BASE_URL && "BBB_BASE_URL",
    !BBB_SHARED_SECRET && "BBB_SHARED_SECRET",
  ].filter(Boolean);
  if (missing.length || !BBB_BASE_URL || !BBB_SHARED_SECRET) {
    logger.error(
      { missing },
      "missing required env var(s) — add them to .env (loaded via --env-file)"
    );
    return 1;
  }

  const course = JSON.parse(readFileSync(inPath, "utf-8"));
  const recording = course.recording ?? {};
  const transcript = course.transcript ?? {};

  const recordId: string | undefined = recording.id ?? transcript.recordingId;
  const vtt: string = transcript.vtt ?? "";
  const lang = langOverride ?? transcript.language ?? "de";

  if (!recordId) {
    logger.error({ inPath }, "No recording id found in course.json");
    return 1;
  }
  if (!vtt.trim()) {
    logger.error({ inPath, recordId }, "No transcript.vtt found in course.json");
    return 1;
  }

  // Log the project/recording context up front so it's clear which recording this
  // run is publishing to, on which server, and with what track settings.
  logger.info(
    {
      inPath,
      recordId,
      meetingName: recording.meetingName ?? null,
      meetingId: recording.meetingId ?? null,
      language: lang,
      label: languageLabel(lang),
      kind,
      vttBytes: vtt.length,
      baseUrl: BBB_BASE_URL,
    },
    "publishing caption track to BBB"
  );

  const res = await uploadCaptionTrack(
    BBB_BASE_URL,
    BBB_SHARED_SECRET,
    recordId,
    lang,
    languageLabel(lang),
    vtt,
    kind
  );

  if (!res.success) {
    logger.error(
      {
        recordId,
        lang,
        kind,
        status: res.status,
        messageKey: res.messageKey,
        message: res.message,
        rawBody: res.rawBody,
      },
      "caption upload rejected by BBB — not polling"
    );
    return 1;
  }

  logger.info(
    { recordId, lang, kind, status: res.status, messageKey: res.messageKey },
    "upload accepted by BBB"
  );

  // BBB processes the upload asynchronously, so SUCCESS above only means "accepted".
  // Poll getRecordingTextTracks until our lang appears (or give up after ~2 min).
  const POLL_INTERVAL_MS = 5000;
  const MAX_ATTEMPTS = 24; // 24 * 5s = 120s
  logger.info(
    { recordId, lang, kind },
    "polling getRecordingTextTracks until the track is live"
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tracks = await getRecordingTextTracks(BBB_BASE_URL, BBB_SHARED_SECRET, recordId);
    const match = tracks.find((t) => t.lang === lang && t.kind === kind);
    if (match) {
      logger.info(
        { recordId, elapsedSeconds: attempt * (POLL_INTERVAL_MS / 1000), track: match },
        "✓ caption track is live"
      );
      return 0;
    }
    logger.info(
      {
        recordId,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        currentTracks: tracks.map((t) => `${t.kind}/${t.lang}`),
      },
      "track not live yet"
    );
    if (attempt < MAX_ATTEMPTS) await Bun.sleep(POLL_INTERVAL_MS);
  }

  logger.warn(
    { recordId, lang, kind },
    "timed out waiting for the track to appear; upload was accepted so BBB's caption " +
      "worker may still be processing — re-check later with getRecordingTextTracks"
  );
  return 1;
}

process.exitCode = await main();
