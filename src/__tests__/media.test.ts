import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { resolveLocalMedia, listLocalRecordingIds, readLocalRecording } from "../lib/media";

const base = join("/tmp", `transcribe-media-test-${process.pid}`);
const recId = "2e7f5090f86f23755efac4820a23ee8890ec2c67-1781159278066";

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("resolveLocalMedia", () => {
  it("returns null when no recordings dir is configured", () => {
    expect(resolveLocalMedia(undefined, recId)).toBeNull();
  });

  it("returns null when the recording media is absent", () => {
    expect(resolveLocalMedia(base, "missing-record")).toBeNull();
  });

  it("finds webcams.webm in the BBB <id>/video layout", () => {
    const dir = join(base, recId, "video");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "webcams.webm");
    writeFileSync(file, "x");
    expect(resolveLocalMedia(base, recId)).toBe(file);
  });

  it("falls back to webcams.mp4 when only the mp4 exists", () => {
    const mp4Rec = "rec-mp4-only";
    const dir = join(base, mp4Rec, "video");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "webcams.mp4");
    writeFileSync(file, "x");
    expect(resolveLocalMedia(base, mp4Rec)).toBe(file);
  });
});

describe("listLocalRecordingIds", () => {
  const dir = join("/tmp", `transcribe-scan-test-${process.pid}`);
  const good = "aaaa1111bbbb2222cccc3333dddd4444eeee5555-1781159278066";
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("returns [] for an unset or nonexistent dir", () => {
    expect(listLocalRecordingIds(undefined)).toEqual([]);
    expect(listLocalRecordingIds("/no/such/dir")).toEqual([]);
  });

  it("lists only record-id dirs that have webcam media", () => {
    // valid id + media -> included
    mkdirSync(join(dir, good, "video"), { recursive: true });
    writeFileSync(join(dir, good, "video", "webcams.webm"), "x");
    // valid id but NO media -> excluded
    mkdirSync(join(dir, "ffff9999-1700000000000"), { recursive: true });
    // non-record-id name with media -> excluded
    mkdirSync(join(dir, "not-a-record", "video"), { recursive: true });
    writeFileSync(join(dir, "not-a-record", "video", "webcams.webm"), "x");
    // a stray file matching nothing -> ignored
    writeFileSync(join(dir, "README"), "x");

    expect(listLocalRecordingIds(dir)).toEqual([good]);
  });
});

describe("readLocalRecording", () => {
  const dir = join("/tmp", `transcribe-read-test-${process.pid}`);
  const id = "abc123def456-1490721543626";
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers metadata.xml values", () => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, "metadata.xml"),
      `<recording><start_time>1490721543626</start_time><meta><meetingName>Falck</meetingName></meta><playback><format>presentation</format><link>https://vroom.b-trend.digital/playback/presentation/2.3/${id}</link></playback></recording>`
    );
    const rec = readLocalRecording(dir, id, "https://vroom.b-trend.digital");
    expect(rec.recordId).toBe(id);
    expect(rec.meetingName).toBe("Falck");
    expect(rec.startTime).toBe(1490721543);
    expect(rec.videoUrl).toContain("/playback/presentation/2.3/");
  });

  it("falls back to id-derived values when metadata.xml is absent", () => {
    const bare = "deadbeef-1700000000000";
    const rec = readLocalRecording(dir, bare, "https://vroom.b-trend.digital");
    expect(rec.meetingName).toBe(bare); // no metadata -> id
    expect(rec.startTime).toBe(1700000000); // ms suffix / 1000
    expect(rec.videoUrl).toBe(
      "https://vroom.b-trend.digital/playback/presentation/2.3/deadbeef-1700000000000"
    );
  });
});
