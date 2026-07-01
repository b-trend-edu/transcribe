import { describe, it, expect } from "bun:test";
import { parseVtt, extractTextFromVtt, vttDurationSeconds } from "../lib/whisper";

const sampleVtt = `WEBVTT

1
00:00:00.000 --> 00:00:05.000
Hello, this is a test.

2
00:00:05.000 --> 00:00:10.000
This is the second segment.
`;

// WhisperX diarized output has no numeric cue indices and prefixes each cue
// with a `[SPEAKER_xx]: ` label.
const diarizedVtt = `WEBVTT

00:00:00.000 --> 00:00:03.000
[SPEAKER_00]: Hello there.

00:01:04.500 --> 00:01:07.250
[SPEAKER_01]: Hi back.
`;

describe("parseVtt", () => {
  it("parses VTT content into segments", () => {
    const segments = parseVtt(sampleVtt);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Hello, this is a test.");
    expect(segments[0].start).toBe("00:00:00.000");
    expect(segments[0].end).toBe("00:00:05.000");
  });
});

describe("extractTextFromVtt", () => {
  it("extracts plain text from VTT content", () => {
    const text = extractTextFromVtt(sampleVtt);
    expect(text).toBe("Hello, this is a test. This is the second segment.");
  });

  it("strips [SPEAKER_xx] diarization labels from plain text", () => {
    const text = extractTextFromVtt(diarizedVtt);
    expect(text).toBe("Hello there. Hi back.");
  });
});

describe("parseVtt (diarized)", () => {
  it("keeps the speaker label inside the cue text", () => {
    const segments = parseVtt(diarizedVtt);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("[SPEAKER_00]: Hello there.");
  });
});

describe("vttDurationSeconds", () => {
  it("returns the end timestamp of the last cue in seconds", () => {
    expect(vttDurationSeconds(sampleVtt)).toBe(10);
    expect(vttDurationSeconds(diarizedVtt)).toBe(67.25);
  });

  it("returns 0 for empty content", () => {
    expect(vttDurationSeconds("WEBVTT\n")).toBe(0);
  });
});
