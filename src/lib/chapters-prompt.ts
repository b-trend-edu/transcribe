/**
 * Prompts and reply schemas for chapter detection.
 *
 * THE MODEL NEVER WRITES A TIMESTAMP.
 *   Asked for `start` in seconds, a model will happily invent 14:32 for a
 *   recording that ends at 12:05, or drift a boundary into the middle of a
 *   sentence. So the transcript is presented as numbered blocks and the model
 *   returns the INDEX of the block a chapter begins at. The index is validated
 *   against the range it was offered and then mapped to that block's real cue
 *   start time — a timestamp that provably exists in the recording.
 *
 *   This is the same lesson as the translation cue count: make the thing that
 *   must be true a property of the reply format, not of the model's goodwill.
 */

/** Bump when a prompt changes; the sweep regenerates anything older. */
export const CHAPTERS_PROMPT_VERSION = "v1";

/** A block of transcript offered to the model as one candidate boundary. */
export interface Block {
  index: number;
  start: number;
  text: string;
}

/**
 * Reply shape: chapter starts as block indices, with a German title each.
 *
 * `minItems`/`maxItems` bound how many a chunk may produce. Without an upper
 * bound the model returns a chapter every couple of minutes on a long lecture,
 * which is a table of contents for nobody.
 */
export function chaptersSchema(min: number, max: number) {
  return {
    type: "object",
    properties: {
      chapters: {
        type: "array",
        minItems: min,
        maxItems: max,
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            title: { type: "string" },
          },
          required: ["index", "title"],
        },
      },
    },
    required: ["chapters"],
  } as const;
}

export type ChaptersOut = { chapters: { index: number; title: string }[] };

export const CHAPTERS_SYSTEM = `Du gliederst die Mitschrift einer Unterrichtseinheit in Kapitel.

Die Mitschrift ist in nummerierte Blöcke geteilt. Jeder Block beginnt mit seiner
Nummer und seinem Zeitstempel.

Regeln:
- Gib für jedes Kapitel die Nummer des Blocks an, in dem das Thema BEGINNT.
- Setze eine Grenze nur bei einem echten Themenwechsel, nicht bei jeder neuen
  Frage, Pause oder Wortmeldung.
- Der Titel benennt das fachliche Thema in 2 bis 6 Wörtern. Keine Nummerierung,
  kein "Teil 1", keine ganzen Sätze, kein Punkt am Ende.
- Titel auf Deutsch, in der Fachsprache der Mitschrift.
- Nummern nur aus dem angebotenen Bereich, jede höchstens einmal, aufsteigend.
- Organisatorisches (Begrüßung, Pausenabsprache, Technikprobleme) ist kein
  eigenes Kapitel, solange daneben Fachliches läuft.`;

export function chaptersUser(blocks: Block[], meetingName?: string | null): string {
  const head = meetingName ? `Veranstaltung: ${meetingName}\n\n` : "";
  const body = blocks
    .map((b) => `[${b.index}] (${formatClock(b.start)}) ${b.text}`)
    .join("\n\n");
  return `${head}Blöcke ${blocks[0]?.index} bis ${blocks[blocks.length - 1]?.index}:\n\n${body}`;
}

/** `1:04:07` / `7:12` — for the model to read, never for storage. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export const TITLES_SYSTEM = (to: string) =>
  `Translate each chapter title into ${to}. Return exactly one translation per
input title, in the same order. Keep them as titles: 2-6 words, no numbering, no
trailing period. Preserve technical terms and standard designations (DIN, WLL,
VDE, ...) unchanged.`;

/** Length-exact, for the same reason the caption batches are. */
export function titlesSchema(n: number) {
  return {
    type: "object",
    properties: {
      titles: { type: "array", items: { type: "string" }, minItems: n, maxItems: n },
    },
    required: ["titles"],
  } as const;
}

export type TitlesOut = { titles: string[] };
