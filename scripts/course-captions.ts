/**
 * Convert a course.json ({ recording, transcript }) into a JSON caption file.
 * Reuses the app's own VTT parser so cue splitting matches the pipeline.
 *
 *   bun run scripts/course-captions.ts course.json                 # -> course.captions.json
 *   bun run scripts/course-captions.ts course.json out.json        # explicit output path
 *   bun run scripts/course-captions.ts course.json -               # print to stdout
 */
import { parseVtt } from "../src/lib/whisper";
import { readFileSync, writeFileSync } from "fs";

/** VTT timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm") -> seconds. */
function toSeconds(ts: string): number {
  const clock = ts.trim().split(/\s+/)[0]; // drop trailing cue settings
  return clock.split(":").reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
}

const inPath = process.argv[2];
const outArg = process.argv[3];
if (!inPath) {
  console.error("usage: bun run scripts/course-captions.ts <course.json> [out.json|-]");
  process.exit(1);
}

const course = JSON.parse(readFileSync(inPath, "utf-8"));
const recording = course.recording ?? {};
const transcript = course.transcript ?? {};
const vtt: string = transcript.vtt ?? "";

if (!vtt.trim()) {
  console.error(`No transcript.vtt found in ${inPath}`);
  process.exit(1);
}

const cues = parseVtt(vtt).map((s, i) => {
  // Strip a leading "[SPEAKER_00]: " diarization label into its own field.
  const m = s.text.match(/^\[(SPEAKER_\d+)\]:\s*(.*)$/);
  return {
    index: i,
    start: toSeconds(s.start),
    end: toSeconds(s.end),
    speaker: m ? m[1] : null,
    text: m ? m[2] : s.text,
  };
});

const caption = {
  recordingId: recording.id ?? transcript.recordingId ?? null,
  meetingName: recording.meetingName ?? null,
  language: transcript.language ?? "de",
  durationSeconds: transcript.durationSeconds ?? cues.at(-1)?.end ?? 0,
  cueCount: cues.length,
  cues,
};

const json = JSON.stringify(caption, null, 2);

if (outArg === "-") {
  process.stdout.write(json + "\n");
} else {
  const outPath = outArg ?? inPath.replace(/\.json$/, "") + ".captions.json";
  writeFileSync(outPath, json);
  console.error(`Wrote ${cues.length} cues -> ${outPath}`);
}
