/** Bump when the wording changes; stored as the model suffix on the row. */
export const TRANSLATE_PROMPT_VERSION = "v1";

/**
 * Structured output. Asking for an array of strings — rather than free prose —
 * is what makes cue alignment checkable: the reply either has exactly as many
 * entries as the batch had cues, or it is rejected.
 */
/**
 * Exactly `n` translated cues — no more, no fewer.
 *
 * The array length is part of the contract, not a hope. With an unbounded
 * `items` schema the model routinely returned 36 cues for 37, or 27 for 29, and
 * every one of those misses fell back to translating a cue per request: ~2700
 * model calls for a recording instead of ~75, about 80 minutes each, which on a
 * single GPU is weeks of work for the corpus. Constrained decoding enforces the
 * count for free, so the fallback goes back to being the rare case it was meant
 * to be.
 */
export function cuesSchema(n: number) {
  return {
    type: "object",
    properties: {
      cues: { type: "array", items: { type: "string" }, minItems: n, maxItems: n },
    },
    required: ["cues"],
  } as const;
}

export type CuesOut = { cues: string[] };

const NAMES: Record<string, string> = {
  de: "German", en: "English", pt: "Portuguese", uk: "Ukrainian", cy: "Welsh",
};
const name = (code: string) => NAMES[code.split("-")[0]!] ?? code;

export function TRANSLATE_SYSTEM(from: string, to: string): string {
  return `You translate subtitle cues from ${name(from)} to ${name(to)}, taken
from recordings of professional events-technology training.

You are given a JSON array of ${name(from)} cues, in order. Return a JSON object
with a "cues" array containing the ${name(to)} translation of each one.

Absolute rules:
- Return EXACTLY as many cues as you were given, in the same order. This is not
  negotiable: the cues are bound to video timestamps, and one extra or missing
  entry desynchronises the whole subtitle track.
- Translate each cue independently in place. NEVER merge two cues into one,
  split one into two, or move a clause from one cue into its neighbour, even
  when a sentence runs across a cue boundary. A cue that ends mid-sentence must
  stay ending mid-sentence.
- The source is speech recognition output: no reliable punctuation, misspelled
  technical terms, occasional garbled words. Translate the intended meaning.
  Where a word is clearly ASR noise, translate what was plainly meant.
- Keep industry terms that are used untranslated on the job (DMX, Truss,
  Rigging, Case, Line-Array, Patch) rather than inventing calques.
- Keep the register spoken and instructional. This is a trainer talking, not
  written prose.
- If a cue is empty or pure filler, return it as an empty string — do not drop
  it, and do not invent content to fill it.`;
}

export function translateUser(cues: string[]): string {
  return JSON.stringify(cues, null, 0);
}
