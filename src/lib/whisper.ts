import { mkdirSync, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

export const TEMP_DIR = "/tmp/bbb-ingest";

export interface VttSegment {
  start: string;
  end: string;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  vtt: string;
  language: string;
  durationSeconds: number;
}

export interface TranscribeOptions {
  /** WhisperX ASR model, e.g. "large-v3". */
  model?: string;
  /** "cuda" for GPU, "cpu" as a fallback. */
  device?: string;
  /** CTranslate2 precision: "float16" (GPU), "int8", "float32". */
  computeType?: string;
  /** Batched inference size; higher = faster but more VRAM. */
  batchSize?: number;
  /** Enable pyannote speaker diarization ([SPEAKER_xx] labels). Requires hfToken. */
  diarize?: boolean;
  /** Hugging Face read token for the gated pyannote models. */
  hfToken?: string;
  /** Optional speaker-count bounds passed to diarization. */
  minSpeakers?: number;
  maxSpeakers?: number;
  /** ISO code (e.g. "en", "de"). Omit / undefined to auto-detect. Never "auto". */
  language?: string;
}

export function parseVtt(vttContent: string): VttSegment[] {
  const segments: VttSegment[] = [];
  const lines = vttContent.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const [start, end] = line.split("-->").map((s) => s.trim());
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().match(/^\d+$/)) {
        textLines.push(lines[i].trim());
        i++;
      }
      if (textLines.length > 0) {
        segments.push({ start, end, text: textLines.join(" ") });
      }
    } else {
      i++;
    }
  }

  return segments;
}

/**
 * Plain searchable text from a VTT. Any leading `[SPEAKER_00]: ` diarization
 * label is stripped so the `text` column stays clean; the raw labels are kept
 * in the stored `vtt`. No-ops on non-diarized cues.
 */
export function extractTextFromVtt(vttContent: string): string {
  const segments = parseVtt(vttContent);
  return segments
    .map((s) => s.text.replace(/^\[SPEAKER_\d+\]:\s*/, ""))
    .join(" ");
}

/** Parse a VTT timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm") into seconds. */
function vttTimestampToSeconds(ts: string): number {
  // A cue's timing line may carry trailing settings ("... align:start"); keep
  // only the leading clock value.
  const clock = ts.trim().split(/\s+/)[0];
  return clock.split(":").reduce((acc, part) => acc * 60 + (parseFloat(part) || 0), 0);
}

/** Transcript length = the end timestamp of the last cue (0 when empty). */
export function vttDurationSeconds(vttContent: string): number {
  const segments = parseVtt(vttContent);
  const last = segments[segments.length - 1];
  return last ? vttTimestampToSeconds(last.end) : 0;
}

export async function transcribe(
  audioPath: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  const {
    model = "large-v3",
    device = "cuda",
    computeType = "float16",
    batchSize = 16,
    diarize = false,
    hfToken,
    minSpeakers,
    maxSpeakers,
    language,
  } = opts;

  mkdirSync(TEMP_DIR, { recursive: true });

  const args = [
    "whisperx",
    audioPath,
    "--model", model,
    "--device", device,
    "--compute_type", computeType,
    "--batch_size", String(batchSize),
    "--output_format", "vtt",
    "--output_dir", TEMP_DIR,
  ];

  // Auto-detect when no language is configured. WhisperX/Whisper reject
  // "--language auto" (argparse error) — omitting the flag triggers detection.
  if (language && language !== "auto") {
    args.push("--language", language);
  }

  if (diarize) {
    if (!hfToken) {
      throw new Error(
        "Diarization requested but no Hugging Face token provided (set HF_TOKEN)."
      );
    }
    args.push("--diarize", "--hf_token", hfToken);
    if (minSpeakers != null) args.push("--min_speakers", String(minSpeakers));
    if (maxSpeakers != null) args.push("--max_speakers", String(maxSpeakers));
  }

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  // Consume stdout/stderr BEFORE awaiting exit to avoid stream draining issues
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    throw new Error(`WhisperX CLI failed (exit ${exitCode}): ${stderr}`);
  }

  const inputName = basename(audioPath).replace(/\.[^.]+$/, "");
  const vttPath = join(TEMP_DIR, `${inputName}.vtt`);

  if (!existsSync(vttPath)) {
    throw new Error(`WhisperX did not produce VTT output at ${vttPath}`);
  }

  const vtt = readFileSync(vttPath, "utf-8");
  const text = extractTextFromVtt(vtt);
  const durationSeconds = vttDurationSeconds(vtt);

  // WhisperX logs "Detected language: en (0.98) in first 30s of audio" — often
  // to stderr — unless --language was given. Scan both streams; else fall back
  // to the configured language.
  const langMatch = `${stdout}\n${stderr}`.match(/Detected language[:\s]+([a-z]{2,3})\b/i);
  const detectedLanguage = langMatch?.[1] ?? language ?? "unknown";

  unlinkSync(vttPath);

  return { text, vtt, language: detectedLanguage, durationSeconds };
}

export function cleanupOldTempFiles(maxAgeHours: number = 24): void {
  if (!existsSync(TEMP_DIR)) return;

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  for (const file of readdirSync(TEMP_DIR)) {
    const filePath = join(TEMP_DIR, file);
    const stat = statSync(filePath);
    if (now - stat.mtimeMs > maxAgeMs) {
      unlinkSync(filePath);
    }
  }
}
