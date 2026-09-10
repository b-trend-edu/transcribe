import { describe, it, expect } from "bun:test";
import {
  chapterLimits,
  chunkCues,
  renderChunkCues,
  collectBoundaries,
  mergeBoundaries,
  parseCues,
  type Cue,
  type RawBoundary,
} from "../lib/chapters";

/** Synthetic cues, one every `step` seconds: cue i spans [i*step, i*step+step). */
function mkCues(n: number, step = 10): Cue[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    start: i * step,
    end: i * step + step,
    text: `cue ${i}`,
  }));
}

describe("chapterLimits", () => {
  it("matches the plan's reference table (sublinear, clamped 5..20)", () => {
    expect(chapterLimits(45 * 60).maxChapters).toBe(7);
    expect(chapterLimits(90 * 60).maxChapters).toBe(10);
    expect(chapterLimits(180 * 60).maxChapters).toBe(15);
    expect(chapterLimits(379 * 60).maxChapters).toBe(20);
  });

  it("clamps to [5, 20]", () => {
    expect(chapterLimits(5 * 60).maxChapters).toBe(5); // tiny -> floor
    expect(chapterLimits(600 * 60).maxChapters).toBe(20); // huge -> ceil
  });

  it("minGap = max(180, duration / (2*maxChapters))", () => {
    // 90 min: 5400 / (2*10) = 270
    expect(chapterLimits(90 * 60).minGapSec).toBeCloseTo(270, 5);
    // short recording: floored at 180
    expect(chapterLimits(20 * 60).minGapSec).toBe(180);
  });
});

describe("chunkCues", () => {
  it("slides a 400-cue window with 40-cue overlap (step 360)", () => {
    const chunks = chunkCues(mkCues(1000));
    expect(chunks[0]).toMatchObject({ startIndex: 0, endIndex: 399 });
    expect(chunks[1]).toMatchObject({ startIndex: 360, endIndex: 759 });
    expect(chunks[2]).toMatchObject({ startIndex: 720, endIndex: 999 });
    expect(chunks).toHaveLength(3);
    // overlap: last 40 of chunk 0 == first 40 of chunk 1
    expect(chunks[0].cues.at(-1)!.index).toBeGreaterThan(chunks[1].cues[0].index);
  });

  it("returns [] for no cues and a single chunk when they all fit", () => {
    expect(chunkCues([])).toEqual([]);
    expect(chunkCues(mkCues(50))).toHaveLength(1);
  });
});

describe("renderChunkCues", () => {
  it("numbers cues by zero-padded GLOBAL index", () => {
    const chunk = chunkCues(mkCues(1000))[1]; // starts at index 360
    expect(renderChunkCues(chunk).split("\n")[0]).toBe("[0360] cue 360");
  });
});

describe("collectBoundaries", () => {
  it("keeps in-range indices, drops out-of-chunk ones, tags the source chunk", () => {
    const chunks = chunkCues(mkCues(1000));
    const raw = collectBoundaries(
      [
        { chunk: 0, boundaries: [{ cue: 10, title: "A", gist: "a" }, { cue: 900, title: "X", gist: "x" }] },
        { chunk: 1, boundaries: [{ cue: 400, title: "B", gist: "b" }] },
      ],
      chunks
    );
    // cue 900 is outside chunk 0 (0..399) -> discarded, never remapped
    expect(raw).toEqual([
      { cue: 10, title: "A", gist: "a", chunk: 0 },
      { cue: 400, title: "B", gist: "b", chunk: 1 },
    ]);
  });
});

describe("mergeBoundaries", () => {
  const cues = mkCues(200); // 0..2000s

  it("maps cue index -> startSeconds and forces a chapter at start:0", () => {
    const b: RawBoundary[] = [{ cue: 5, title: "Intro", gist: "g", chunk: 0 }];
    // duration 1200s -> minGap 180; single boundary snapped down to 0
    expect(mergeBoundaries(b, cues, 1200)).toEqual([{ start: 0, title: "Intro", gist: "g" }]);
  });

  it("collapses boundaries < 3 cues apart, earlier chunk wins", () => {
    const b: RawBoundary[] = [
      { cue: 100, title: "late-chunk", gist: "g1", chunk: 1 },
      { cue: 101, title: "early-chunk", gist: "g2", chunk: 0 },
    ];
    const out = mergeBoundaries(b, cues, 1200);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("early-chunk"); // chunk 0 beats chunk 1
  });

  it("discards a cue index that does not exist (no time hallucination)", () => {
    const b: RawBoundary[] = [
      { cue: 0, title: "Start", gist: "g", chunk: 0 },
      { cue: 99999, title: "Ghost", gist: "g", chunk: 0 },
    ];
    expect(mergeBoundaries(b, cues, 1200)).toEqual([{ start: 0, title: "Start", gist: "g" }]);
  });

  it("snaps a boundary onto a slide change within ±30s", () => {
    const b: RawBoundary[] = [
      { cue: 0, title: "Start", gist: "g", chunk: 0 },
      { cue: 30, title: "Topic", gist: "g", chunk: 0 }, // 300s
    ];
    const out = mergeBoundaries(b, cues, 1200, [290]); // slide at 290s, within 30
    expect(out.map((c) => c.start)).toEqual([0, 290]);
  });

  it("does not snap when the nearest slide is farther than 30s", () => {
    const b: RawBoundary[] = [
      { cue: 0, title: "Start", gist: "g", chunk: 0 },
      { cue: 30, title: "Topic", gist: "g", chunk: 0 },
    ];
    const out = mergeBoundaries(b, cues, 1200, [250]); // 50s away
    expect(out.map((c) => c.start)).toEqual([0, 300]);
  });

  it("merges boundaries closer than minGap (the later one falls away)", () => {
    // duration 1200 -> minGap 180
    const b: RawBoundary[] = [
      { cue: 0, title: "A", gist: "g", chunk: 0 }, // 0s
      { cue: 10, title: "B", gist: "g", chunk: 0 }, // 100s  (<180 -> dropped)
      { cue: 30, title: "C", gist: "g", chunk: 0 }, // 300s  (>=180 -> kept)
    ];
    expect(mergeBoundaries(b, cues, 1200).map((c) => c.start)).toEqual([0, 300]);
  });

  it("caps to maxChapters, dropping the smallest-gap boundary first", () => {
    // duration 1200 -> maxChapters 5, minGap 180; six boundaries 200s apart
    const b: RawBoundary[] = [0, 20, 40, 60, 80, 100].map((cue, i) => ({
      cue,
      title: `T${i}`,
      gist: "g",
      chunk: 0,
    }));
    const out = mergeBoundaries(b, cues, 1200);
    expect(out).toHaveLength(5);
    expect(out.map((c) => c.start)).toEqual([0, 400, 600, 800, 1000]);
  });

  it("enforces the 60-char title cap and strips trailing punctuation", () => {
    const long = "x".repeat(80);
    const out = mergeBoundaries([{ cue: 0, title: long + ".", gist: "g", chunk: 0 }], cues, 1200);
    expect(out[0].title.length).toBeLessThanOrEqual(60);
  });

  it("returns [] when there are no boundaries", () => {
    expect(mergeBoundaries([], cues, 1200)).toEqual([]);
  });
});

describe("parseCues", () => {
  it("turns a VTT into indexed cues with numeric seconds", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
Hello there.

00:01:00.000 --> 00:01:04.000
Second cue.
`;
    const cues = parseCues(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 0, start: 0, end: 5, text: "Hello there." });
    expect(cues[1]).toMatchObject({ index: 1, start: 60, end: 64, text: "Second cue." });
  });
});
