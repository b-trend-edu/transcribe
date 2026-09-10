import { parseVtt } from "./whisper";

// Stufe 2 of the map-reduce: turn the LLM's per-chunk topic boundaries (given as
// cue INDICES, never times) into a recording's chapters.json. Deterministic and
// LLM-free — this is the module the plan asks to be unit-tested, because the
// correctness lives here, not in the model output.

/** A transcript cue with its 0-based position and numeric second offsets. */
export interface Cue {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** A slice of cues handed to one Stufe-1 call, with its inclusive index range. */
export interface CueChunk {
  startIndex: number;
  endIndex: number;
  cues: Cue[];
}

/** Raw JSON a Stufe-1 call returns for one chunk (cue = GLOBAL cue index). */
export interface ChunkBoundaryResult {
  chunk: number;
  boundaries: Array<{ cue: number; title: string; gist: string }>;
}

/** A boundary after collection: validated in-range and tagged with its chunk. */
export interface RawBoundary {
  cue: number;
  title: string;
  gist: string;
  chunk: number;
}

/** A finished chapter. `start` is recording-relative seconds; gist feeds Stufe 3
 *  and is dropped by the chapters.json endpoint. */
export interface Chapter {
  start: number;
  title: string;
  gist: string;
}

export const CHUNK_SIZE = 400;
export const CHUNK_OVERLAP = 40;
export const TITLE_MAX = 60;
export const GIST_MAX = 200;
/** Boundaries this many cues apart or less are the same boundary seen twice. */
const OVERLAP_DEDUP_CUES = 3;
/** A boundary within this many seconds of a slide change snaps onto it. */
const SLIDE_SNAP_SECONDS = 30;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Chapter budget for a recording. Sublinear in length: a 6h recording covers the
 * same topics longer, not 8x more of them, so max chapters grows with √minutes
 * (clamped 5..20). minGap keeps chapters from bunching on the seekbar.
 */
export function chapterLimits(durationSeconds: number): {
  maxChapters: number;
  minGapSec: number;
} {
  const minutes = durationSeconds / 60;
  const maxChapters = clamp(Math.round(1.1 * Math.sqrt(minutes)), 5, 20);
  const minGapSec = Math.max(180, durationSeconds / (2 * maxChapters));
  return { maxChapters, minGapSec };
}

/** VTT timestamp ("HH:MM:SS.mmm" / "MM:SS.mmm") -> seconds. */
function timestampToSeconds(ts: string): number {
  const clock = ts.trim().split(/\s+/)[0];
  return clock.split(":").reduce((acc, part) => acc * 60 + (parseFloat(part) || 0), 0);
}

/** Parse a VTT into indexed, numeric cues (reuses the transcript VTT parser). */
export function parseCues(vtt: string): Cue[] {
  return parseVtt(vtt).map((s, index) => ({
    index,
    start: timestampToSeconds(s.start),
    end: timestampToSeconds(s.end),
    text: s.text,
  }));
}

/** Sliding window of `size` cues stepping by `size - overlap`. */
export function chunkCues(
  cues: Cue[],
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): CueChunk[] {
  if (cues.length === 0) return [];
  const step = Math.max(1, size - overlap);
  const chunks: CueChunk[] = [];
  for (let start = 0; start < cues.length; start += step) {
    const end = Math.min(start + size, cues.length);
    chunks.push({ startIndex: start, endIndex: end - 1, cues: cues.slice(start, end) });
    if (end === cues.length) break; // last window reached the end
  }
  return chunks;
}

/** Render a chunk's cues for the prompt: `[0142] text`, numbered by GLOBAL index. */
export function renderChunkCues(chunk: CueChunk): string {
  return chunk.cues
    .map((c) => `[${String(c.index).padStart(4, "0")}] ${c.text}`)
    .join("\n");
}

/**
 * Flatten Stufe-1 results into boundaries, dropping any cue index the model
 * placed OUTSIDE the chunk it was shown (structural anti-hallucination: an
 * out-of-range index is discarded, never remapped) and tagging each with its
 * source chunk for the overlap-dedup.
 */
export function collectBoundaries(
  results: ChunkBoundaryResult[],
  chunks: CueChunk[]
): RawBoundary[] {
  const out: RawBoundary[] = [];
  for (const { chunk, boundaries } of results) {
    const range = chunks[chunk];
    if (!range) continue;
    for (const b of boundaries) {
      if (!Number.isFinite(b.cue) || b.cue < range.startIndex || b.cue > range.endIndex) {
        continue;
      }
      out.push({ cue: b.cue, title: b.title ?? "", gist: b.gist ?? "", chunk });
    }
  }
  return out;
}

function cleanTitle(raw: string): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
  return collapsed.length > TITLE_MAX ? collapsed.slice(0, TITLE_MAX).trim() : collapsed;
}

function cleanGist(raw: string): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > GIST_MAX ? collapsed.slice(0, GIST_MAX).trim() : collapsed;
}

/** Nearest value in `values` within `tol` of `target`, or null. */
function nearestWithin(values: number[], target: number, tol: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const v of values) {
    const d = Math.abs(v - target);
    if (d <= tol && d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/**
 * Merge per-chunk boundaries into a recording's chapters. Order is load-bearing:
 * 1. overlap-dedup (earlier chunk wins — it saw more lead-up)
 * 2. cue index -> startSeconds (unknown index discarded)
 * 3. slide-snap (±30s onto a slide change, if slides given)
 * 4. min-gap merge (later boundary falls away)
 * 5. cap to maxChapters (drop the smallest-gap boundary first)
 * 6. force a chapter at start:0
 */
export function mergeBoundaries(
  boundaries: RawBoundary[],
  cues: Cue[],
  durationSeconds: number,
  slideChanges: number[] = []
): Chapter[] {
  const byIndex = new Map(cues.map((c) => [c.index, c]));
  const { maxChapters, minGapSec } = chapterLimits(durationSeconds);

  // 1. Overlap-dedup: boundaries within OVERLAP_DEDUP_CUES cues are one boundary
  //    seen in two chunks; keep the one from the earlier chunk.
  const sorted = [...boundaries].sort((a, b) => a.cue - b.cue || a.chunk - b.chunk);
  const deduped: RawBoundary[] = [];
  for (const b of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(b.cue - prev.cue) < OVERLAP_DEDUP_CUES) {
      if (b.chunk < prev.chunk) deduped[deduped.length - 1] = b;
      continue;
    }
    deduped.push(b);
  }

  // 2. Cue index -> time. An index with no matching cue is dropped outright.
  let chapters: Chapter[] = [];
  for (const b of deduped) {
    const cue = byIndex.get(b.cue);
    if (!cue) continue;
    chapters.push({ start: cue.start, title: cleanTitle(b.title), gist: cleanGist(b.gist) });
  }
  chapters.sort((a, b) => a.start - b.start);

  // 3. Slide-snap.
  if (slideChanges.length) {
    for (const ch of chapters) {
      const near = nearestWithin(slideChanges, ch.start, SLIDE_SNAP_SECONDS);
      if (near != null) ch.start = near;
    }
    chapters.sort((a, b) => a.start - b.start);
  }

  // 4. Min-gap merge.
  const gapped: Chapter[] = [];
  for (const ch of chapters) {
    const prev = gapped[gapped.length - 1];
    if (prev && ch.start - prev.start < minGapSec) continue;
    gapped.push(ch);
  }
  chapters = gapped;

  // 5. Cap to maxChapters, always keeping the first chapter.
  while (chapters.length > maxChapters) {
    let victim = 1;
    let smallest = Infinity;
    for (let i = 1; i < chapters.length; i++) {
      const gap = chapters[i].start - chapters[i - 1].start;
      if (gap < smallest) {
        smallest = gap;
        victim = i;
      }
    }
    chapters.splice(victim, 1);
  }

  // 6. Force the first chapter to start at 0 (the model nearly always emits an
  //    early boundary, so this is a small nudge, not an invented intro).
  if (chapters.length && chapters[0].start !== 0) chapters[0].start = 0;

  return chapters;
}
