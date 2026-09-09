/**
 * The summarisation prompt, versioned.
 *
 * PROMPT_VERSION is stored on every row. Bump it whenever the wording changes,
 * so "generated before the change" is a query rather than an inference from
 * timestamps.
 */
export const PROMPT_VERSION = "v1";

/** Ollama constrains generation to this, so the reply parses without cleanup. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
  },
  required: ["title", "summary"],
} as const;

export type SummaryOut = { title: string; summary: string };

const SHARED_RULES = `
Rules:
- Base everything ONLY on the transcript. Never invent a topic, name, product or
  number that does not appear in it.
- The transcript is automatic speech recognition output: it has no punctuation
  reliability, misspells technical terms and proper nouns, and may contain
  crosstalk. Read through those errors; do not quote them.
- Ignore administrative talk — greetings, breaks, audio checks, "can you hear
  me", scheduling. Summarise what was TAUGHT.
- If the transcript is too short or too garbled to summarise, say so plainly in
  the summary field rather than inventing content.
`;

/**
 * The title is the hard part. These recordings sit in a list of several hundred
 * from the same trainer on adjacent topics, so a title is only useful if it
 * distinguishes THIS lesson from its neighbours. "Schulung" or "Weiterbildung"
 * is worse than useless — it is 374 identical rows.
 */
export function systemPrompt(target: "de" | "en"): string {
  const language =
    target === "de"
      ? "Antworte auf Deutsch."
      : "Answer in English, even though the transcript is in German.";

  return `You summarise recordings of German-language professional training
sessions for b-trend, a provider of events-technology courses. ${language}

Produce two things:

1. "title" — a specific, concrete name for THIS lesson, 3 to 8 words. It must
   distinguish this recording from several hundred others by the same trainer on
   related topics. Name the actual subject matter: the technique, the equipment,
   the standard, the software. Never generic labels like "Schulung",
   "Weiterbildung", "Training Session" or "Lesson 4". No date, no trainer name,
   no quotation marks, no trailing punctuation.

2. "summary" — 3 to 5 sentences covering what was taught: the topics, the
   concepts explained, any equipment or software demonstrated, and the practical
   takeaway. Write for someone deciding whether this recording answers their
   question. Do not begin with "In this training session" or "In dieser
   Schulung" — start with the substance.
${SHARED_RULES}`;
}

export function userPrompt(transcript: string, meetingName?: string | null): string {
  // The BBB meeting name is a weak hint — often just the room name, sometimes
  // genuinely descriptive. Offer it as context, explicitly not as the answer,
  // or the model will simply echo it back as the title.
  const hint = meetingName?.trim()
    ? `Meeting name from the calendar (may be a generic room name — use it only if the transcript supports it, never copy it as the title):\n${meetingName.trim()}\n\n`
    : "";
  return `${hint}Transcript:\n\n${transcript}`;
}

/**
 * Map-reduce for transcripts that exceed the context window.
 *
 * Chunk summaries are deliberately terse and factual: they are read by the model
 * itself, not by a person, and a chunk that editorialises drags the final
 * summary off the source.
 */
export const CHUNK_SYSTEM = `You are reading one consecutive section of a longer
German training recording. List the concrete topics taught in this section as
terse bullet points — techniques, equipment, standards, software, worked
examples. No preamble, no conclusion, no attempt to summarise the whole course.
If the section is only administrative talk, reply exactly: (nothing taught)`;

export function reduceUserPrompt(chunkNotes: string[], meetingName?: string | null): string {
  const hint = meetingName?.trim() ? `Meeting name: ${meetingName.trim()}\n\n` : "";
  return `${hint}The following are ordered notes taken from consecutive sections of one training recording. Produce the title and summary for the recording as a whole.\n\n${chunkNotes.join("\n\n")}`;
}
