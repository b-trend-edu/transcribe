/**
 * Skip / import recordings that BBB already has captions for.
 *
 * The sweep dedupes only against our own `recordings` table, so against an
 * established BBB server with a fresh database every already-captioned
 * recording would be queued for a full GPU transcription. On the b-trend estate
 * that is ~300 recordings of redundant work.
 *
 * Two modes (EXISTING_CAPTIONS):
 *   import  (default) — pull the VTT BBB already serves and store it as the
 *                       transcript. One HTTP GET instead of ~40 min of GPU, and
 *                       it leaves the row usable for summarisation later.
 *   skip              — mark the recording done, store nothing.
 *   ignore            — old behaviour; re-transcribe everything.
 */
import { getRecordingTextTracks, type RecordingTextTrack } from "./bbb";
import { extractTextFromVtt, vttDurationSeconds } from "./whisper";
import logger from "./logger";

export type ExistingCaptionMode = "import" | "skip" | "ignore";

export function captionMode(raw: string | undefined): ExistingCaptionMode {
  const v = (raw ?? "import").toLowerCase();
  return v === "skip" || v === "ignore" ? v : "import";
}

/**
 * Pick the track to reuse. Prefers `language` when set (a de-only server should
 * not adopt a stray en track), otherwise takes the first track that has an href.
 * A track without `href` has been uploaded but not yet processed by BBB's async
 * caption worker — not usable, and not proof of a finished transcript either.
 */
export function pickTrack(
  tracks: RecordingTextTrack[],
  language?: string
): RecordingTextTrack | null {
  const usable = tracks.filter((t) => typeof t.href === "string" && t.href.length > 0);
  if (usable.length === 0) return null;
  if (language) {
    const norm = (s: string) => s.toLowerCase().replace("_", "-").split("-")[0];
    const match = usable.find((t) => norm(t.lang) === norm(language));
    return match ?? null;
  }
  return usable[0] ?? null;
}

export interface ExistingCaption {
  vtt: string;
  text: string;
  language: string;
  durationSeconds: number;
}

/**
 * Returns the already-published caption for a recording, or null if there is
 * none worth reusing. Never throws — a BBB API hiccup must not strand discovery,
 * so on error we return null and the recording follows the normal path.
 */
export async function findExistingCaption(
  baseUrl: string,
  secret: string,
  recordId: string,
  language: string | undefined,
  mode: ExistingCaptionMode
): Promise<{ found: boolean; caption: ExistingCaption | null }> {
  if (mode === "ignore") return { found: false, caption: null };

  let tracks: RecordingTextTrack[];
  try {
    tracks = await getRecordingTextTracks(baseUrl, secret, recordId);
  } catch (err) {
    logger.warn({ recordId, err }, "caption pre-check failed; will transcribe normally");
    return { found: false, caption: null };
  }

  const track = pickTrack(tracks, language);
  if (!track) return { found: false, caption: null };

  if (mode === "skip") return { found: true, caption: null };

  try {
    const res = await fetch(track.href as string);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vtt = await res.text();
    const text = extractTextFromVtt(vtt);
    // An empty/placeholder VTT is not a transcript — fall through and do the work.
    if (text.trim().length === 0) return { found: false, caption: null };
    return {
      found: true,
      caption: {
        vtt,
        text,
        language: track.lang,
        durationSeconds: vttDurationSeconds(vtt),
      },
    };
  } catch (err) {
    logger.warn({ recordId, err }, "existing caption download failed; will transcribe");
    return { found: false, caption: null };
  }
}
