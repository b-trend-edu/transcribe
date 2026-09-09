/**
 * WebVTT parse / serialise.
 *
 * Translation must preserve cue timings EXACTLY — a translated caption track
 * whose timestamps drifted is worse than no track at all, because it looks
 * fine until someone tries to follow along. So the rule here is: timestamps are
 * copied verbatim as strings, never parsed to numbers and re-rendered. Only cue
 * text is ever replaced.
 */

export type Cue = {
  /** Optional cue identifier line, preserved as-is. */
  id?: string;
  /** The full timing line, verbatim — including any cue settings after the
   *  timestamps (align:, position:, line:), which WhisperX can emit. */
  timing: string;
  /** Cue payload, newlines preserved. */
  text: string;
};

const TIMING = /-->/;

export function parseVtt(vtt: string): { header: string; cues: Cue[] } {
  const normalised = vtt.replace(/\r\n?/g, "\n");
  const blocks = normalised.split(/\n{2,}/);

  let header = "WEBVTT";
  const cues: Cue[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("WEBVTT")) {
      header = trimmed;
      continue;
    }
    // NOTE and STYLE blocks carry no cue text and must survive untouched, but
    // they are not cues either — drop them rather than mangle them.
    if (trimmed.startsWith("NOTE") || trimmed.startsWith("STYLE")) continue;

    const lines = trimmed.split("\n");
    const timingIdx = lines.findIndex((l) => TIMING.test(l));
    if (timingIdx === -1) continue; // not a cue

    cues.push({
      id: timingIdx > 0 ? lines.slice(0, timingIdx).join("\n") : undefined,
      timing: lines[timingIdx]!,
      text: lines.slice(timingIdx + 1).join("\n"),
    });
  }
  return { header, cues };
}

export function serialiseVtt(header: string, cues: Cue[]): string {
  const parts = [header.startsWith("WEBVTT") ? header : "WEBVTT"];
  for (const cue of cues) {
    const block = [cue.id, cue.timing, cue.text].filter((x) => x !== undefined && x !== "").join("\n");
    parts.push(block);
  }
  return parts.join("\n\n") + "\n";
}

/** Plain text of a VTT, for the transcripts.text column. */
export function cuesToText(cues: Cue[]): string {
  return cues
    .map((c) => c.text.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Group cues into batches for translation.
 *
 * One cue at a time would be accurate but ruinously slow and would strip the
 * context a translator needs — a 4-hour recording is thousands of cues. Batches
 * give the model surrounding sentences to work from, and cut the number of
 * round trips by two orders of magnitude.
 */
export function batchCues(cues: Cue[], maxChars: number): { start: number; cues: Cue[] }[] {
  const batches: { start: number; cues: Cue[] }[] = [];
  let current: Cue[] = [];
  let start = 0;
  let size = 0;

  cues.forEach((cue, i) => {
    const len = cue.text.length + 1;
    if (current.length && size + len > maxChars) {
      batches.push({ start, cues: current });
      current = [];
      start = i;
      size = 0;
    }
    if (!current.length) start = i;
    current.push(cue);
    size += len;
  });
  if (current.length) batches.push({ start, cues: current });
  return batches;
}
