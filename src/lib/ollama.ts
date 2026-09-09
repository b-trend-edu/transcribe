/**
 * Ollama client — local inference on ai01.
 *
 * WHY LOCAL, NOT A HOSTED API
 *   Transcripts contain named participants speaking in b-trend training
 *   sessions. Keeping inference on the box means that content never leaves the
 *   premises, which removes the GDPR question rather than answering it.
 *
 * VRAM IS THE BINDING CONSTRAINT
 *   ai01 is a 16 GB card that also runs WhisperX large-v3. Model weights plus a
 *   long-transcript KV cache do not both fit alongside it, so:
 *     - callers must serialise against transcription (Inngest concurrency),
 *     - KEEP_ALIVE defaults to 0 so Ollama unloads the model after each call
 *       instead of holding 8-13 GB hostage while WhisperX wants it.
 *   Measured headroom with weights resident:
 *     gemma4:12b      7.6 GB  -> ~8.5 GB free
 *     gpt-oss:latest 13   GB  -> ~3   GB free
 */

const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
export const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL ?? "gemma4:12b";
export const TRANSLATE_MODEL = process.env.OLLAMA_TRANSLATE_MODEL ?? "gemma4:12b";

// 0 = unload as soon as the call returns. Do not raise this without also
// serialising against WhisperX, or transcription will OOM.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "0";

/** Rough tokens-for-German heuristic. Only used for chunking decisions, never
 *  for billing, so an approximation is fine — but German compounds tokenize
 *  worse than English, hence /3 rather than the usual /4 chars-per-token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export class OllamaError extends Error {}

type ChatOpts = {
  model: string;
  system: string;
  user: string;
  /** JSON schema. Ollama constrains generation to it — this is what makes the
   *  response parseable instead of prose wrapped in a code fence. */
  schema?: Record<string, unknown>;
  /** Context window to allocate. Larger = more KV cache = more VRAM. */
  numCtx?: number;
  temperature?: number;
  timeoutMs?: number;
};

export async function chat<T = unknown>(opts: ChatOpts): Promise<T extends unknown ? any : T> {
  const {
    model, system, user, schema,
    numCtx = 8192,
    temperature = 0.2,
    // Translation of a long transcript legitimately runs for tens of minutes on
    // this hardware; a default fetch timeout would kill it mid-way.
    timeoutMs = 60 * 60 * 1000,
  } = opts;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        ...(schema ? { format: schema } : {}),
        options: { temperature, num_ctx: numCtx },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    throw new OllamaError(
      `ollama ${model} unreachable at ${HOST}: ${(e as Error).name} ${(e as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new OllamaError(`ollama ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content?.trim();
  if (!content) throw new OllamaError(`ollama ${model} returned an empty message`);

  if (!schema) return content as any;
  try {
    return JSON.parse(content);
  } catch {
    // Constrained decoding should make this unreachable. If it fires, the model
    // tag does not support `format` — worth an explicit error rather than a
    // confusing downstream undefined.
    throw new OllamaError(
      `ollama ${model} did not return JSON despite a schema: ${content.slice(0, 200)}`
    );
  }
}

/** Fails fast with a clear message if the model tag is not pulled. */
export async function assertModel(model: string): Promise<void> {
  const res = await fetch(`${HOST}/api/tags`).catch(() => null);
  if (!res?.ok) throw new OllamaError(`ollama unreachable at ${HOST}`);
  const { models = [] } = (await res.json()) as { models?: { name: string }[] };
  const have = models.map((m) => m.name);
  if (!have.includes(model)) {
    throw new OllamaError(`model "${model}" not pulled. available: ${have.join(", ") || "none"}`);
  }
}
