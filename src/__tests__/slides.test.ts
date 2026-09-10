import { describe, it, expect } from "bun:test";
import { parseSlideChanges } from "../lib/slides";

describe("parseSlideChanges", () => {
  it("extracts distinct, sorted slide-start times from <image> tags only", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <image id="i2" class="slide" in="12.3" out="30.0" xlink:href="s2.png"/>
      <image id="i1" class="slide" in="0.0" out="12.3" xlink:href="s1.png"/>
      <g class="canvas" image="i2">
        <g class="shape" in="15.0" out="30.0"><polyline/></g>
      </g>
    </svg>`;
    // 15.0 belongs to a <g> annotation, not an <image>, so it's excluded.
    expect(parseSlideChanges(svg)).toEqual([0, 12.3]);
  });

  it("dedupes identical in= values", () => {
    const svg = `<image in="5.0"/><image in="5.0"/><image in="9.5"/>`;
    expect(parseSlideChanges(svg)).toEqual([5, 9.5]);
  });

  it("returns [] when there are no images", () => {
    expect(parseSlideChanges(`<svg></svg>`)).toEqual([]);
  });
});
