/**
 * The chapter-boundary prompt (Stufe 1 of the map-reduce), versioned.
 *
 * The model sees one numbered slice of cues and answers with cue INDICES, never
 * times. An index outside the slice is discarded downstream, so a hallucinated
 * timestamp is structurally impossible. Bump CHAPTERS_PROMPT_VERSION whenever
 * the wording changes; `DELETE FROM insights WHERE prompt_version = '<old>'`
 * then re-queues everything it produced.
 */
export const CHAPTERS_PROMPT_VERSION = "chapters-v1";

/** Ollama constrains generation to this, so the reply parses without cleanup. */
export const CHAPTERS_SCHEMA = {
  type: "object",
  properties: {
    boundaries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cue: { type: "integer" },
          title: { type: "string" },
          gist: { type: "string" },
        },
        required: ["cue", "title", "gist"],
      },
    },
  },
  required: ["boundaries"],
} as const;

export type ChunkOut = { boundaries: { cue: number; title: string; gist: string }[] };

/**
 * Titles are nominal, not learning-objective sentences: on 8-14B models the
 * objective style reliably attracts filler, runs to 70-100 characters and is
 * then truncated in both the seekbar tooltip and the material column.
 * "Topic: subaspect" carries the same information without the sentence.
 */
export function chaptersSystem(language: string, maxBoundaries: number): string {
  return `You split a lecture transcript into topical chapters.

Input is a numbered slice of transcript cues, one per line: [<index>] <text>

Reply with ONLY JSON: {"boundaries":[{"cue":<index>,"title":"...","gist":"..."}]}

Rules:
- "cue" MUST be one of the indices shown; it marks where a NEW topic begins.
- Emit between 1 and ${maxBoundaries} boundaries for this slice — only genuine topic shifts, not every paragraph.
- "title": at most 60 characters, a noun phrase, no trailing punctuation, no leading verb. Prefer "Topic: subaspect" over a sentence. Language: ${language}.
- "gist": exactly one sentence, at most 200 characters, in ${language}.
- The transcript is automatic speech recognition output and misspells technical terms; read through those errors.
- Never invent anything not present in the cues.`;
}
