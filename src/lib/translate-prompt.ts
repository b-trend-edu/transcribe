/** Bump when the wording changes; stored as the model suffix on the row. */
export const TRANSLATE_PROMPT_VERSION = "v2";

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

You are given a JSON object with "cues" — the ${name(from)} cues to translate, in
order — and optionally "context_before" and "context_after", which are the
neighbouring cues of the same recording. The context is there ONLY so you can
understand what is being said; never translate it and never return it. Return a
JSON object with a "cues" array holding the ${name(to)} translation of each cue
in "cues", and nothing else.

Absolute rules:
- Return EXACTLY as many cues as you were given, in the same order. This is not
  negotiable: the cues are bound to video timestamps, and one extra or missing
  entry desynchronises the whole subtitle track.
- READ THE WHOLE PASSAGE FIRST, then translate. The cues are consecutive
  speech, frequently splitting a single sentence across several of them, and
  "context_before" / "context_after" continue that speech beyond this batch.
  Use all of it to decide what each cue means.
- Keep each translation INSIDE its own cue. Never merge two cues, split one in
  two, or move a clause into a neighbour, even when a sentence runs across a cue
  boundary — a cue that ends mid-sentence stays ending mid-sentence. This is
  about where the words go, NOT about translating each cue blind.
- Resolve pronouns from the surrounding cues, not from the cue in isolation.
  German grammatical gender is not natural gender: "er" for "der Träger", "der
  Scheinwerfer", "der Zug" is IT, not HE; "sie" for "die Traverse", "die Last"
  is IT, not SHE. Use HE or SHE only for a person who has actually been named.
- "man" is impersonal — "you" or "one", never "man". "man sieht" is "you can
  see", not "the man sees".
- Carry terminology across cues. Once a term has been rendered one way in this
  passage, keep rendering it that way.
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

/**
 * The batch to translate, plus the speech either side of it.
 *
 * Without context the model translates a five-second fragment blind: a cue that
 * is only "...dass er zu schwer ist" has no antecedent, so "er" becomes "he"
 * when it meant a beam. Sending the neighbouring cues as reference costs a few
 * hundred tokens and is the difference between a translation that reads and one
 * that does not.
 */
export function translateUser(
  cues: string[],
  contextBefore: string[] = [],
  contextAfter: string[] = [],
): string {
  const payload: Record<string, string[]> = {};
  if (contextBefore.length) payload.context_before = contextBefore;
  payload.cues = cues;
  if (contextAfter.length) payload.context_after = contextAfter;
  return JSON.stringify(payload, null, 0);
}
