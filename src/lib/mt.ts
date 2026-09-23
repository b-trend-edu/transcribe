/**
 * Local machine translation: OPUS-MT through CTranslate2 (mt/translate.py).
 *
 * WHY NOT THE LLM
 *   gemma4 through Ollama translated ~120 batches per 4-hour recording at about
 *   a minute each, on the one GPU everything else also needs — weeks for the
 *   backlog. A dedicated translation model does the whole recording in one call
 *   in well under a minute, and returns exactly one line per cue, so alignment
 *   holds by construction instead of by checking.
 *
 *   The trade is fluency: cues are translated one at a time, so a sentence split
 *   across two cues reads stiffly. The LLM path stays for language pairs with no
 *   baked model (the few Portuguese/Ukrainian recordings) and as an opt-in via
 *   TRANSLATE_ENGINE=llm.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const MODELS_DIR = process.env.MT_MODELS_DIR ?? "/opt/mt";
const SCRIPT = process.env.MT_SCRIPT ?? join(import.meta.dir, "../../mt/translate.py");

export const MT_VERSION = "v1";

function modelName(from: string, to: string): string {
  return `opus-mt-${from}-${to}`;
}

/** The model tag stored on the transcript row, e.g. `translated:opus-mt-de-en:v1`. */
export function mtModelTag(from: string, to: string): string {
  return `translated:${modelName(from, to)}:${MT_VERSION}`;
}

/** True when a model for this pair is baked into the image and MT is enabled. */
export function mtAvailable(from: string, to: string): boolean {
  if (process.env.TRANSLATE_ENGINE === "llm") return false;
  return existsSync(join(MODELS_DIR, modelName(from, to), "model.bin"));
}

/** Translate cue texts one-to-one. The result has exactly `texts.length` entries. */
export async function translateCues(
  texts: string[],
  from: string,
  to: string,
): Promise<{ texts: string[]; device: string; seconds: number }> {
  const proc = Bun.spawn(["python", SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify({ model_dir: join(MODELS_DIR, modelName(from, to)), texts }));
  proc.stdin.end();

  // Consume stdout/stderr BEFORE awaiting exit to avoid stream draining issues
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    throw new Error(`MT failed (exit ${exitCode}): ${stderr.slice(-2000)}`);
  }
  const out = JSON.parse(stdout) as { texts: string[]; device: string; seconds: number };
  if (!Array.isArray(out.texts) || out.texts.length !== texts.length) {
    throw new Error(`MT returned ${out.texts?.length} cues for ${texts.length}`);
  }
  return out;
}
