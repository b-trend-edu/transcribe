import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Slide-change times from a recording's shapes.svg, used by Stufe 2 to snap a
// chapter boundary onto the nearest slide flip. BBB draws each slide as an
// <image ... in="<seconds>" ...> element; annotations are <g> shapes and are
// intentionally ignored. Best-effort: no file / no images -> [], never throws.

// ponytail: regex over the <image> tags instead of a full SVG parse — we only
// want their `in` attribute, and shapes.svg nests images under <g> groups that
// a shallow parse would miss.
const IMAGE_IN = /<image\b[^>]*?\bin="([0-9]*\.?[0-9]+)"[^>]*>/g;

/** Distinct slide start times (seconds), ascending, from a shapes.svg string. */
export function parseSlideChanges(svg: string): number[] {
  const times = new Set<number>();
  for (const m of svg.matchAll(IMAGE_IN)) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t)) times.add(t);
  }
  return [...times].sort((a, b) => a - b);
}

/** Slide-change times for a recording under the mounted dir, or [] if absent. */
export function readSlideChanges(
  recordingsDir: string | undefined,
  recordId: string
): number[] {
  if (!recordingsDir) return [];
  const path = join(recordingsDir, recordId, "shapes.svg");
  if (!existsSync(path)) return [];
  try {
    return parseSlideChanges(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}
