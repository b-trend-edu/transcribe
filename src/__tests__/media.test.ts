import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { resolveLocalMedia } from "../lib/media";

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
