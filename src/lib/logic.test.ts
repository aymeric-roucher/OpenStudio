import { describe, expect, it } from "vitest";
import { outputDuration, outputToSource, sourceToOutput, splitAt, trimEdge } from "./timeline";
import { zoomViewport } from "./zoom";
import { fitFrame, outputSize } from "./layout";
import type { Segment, ZoomRegion } from "./types";

const segs: Segment[] = [
  { id: "a", start: 0, end: 4, speed: 1 },
  { id: "b", start: 6, end: 10, speed: 2 },
];

describe("timeline", () => {
  it.each([
    [0, 0, 0],
    [3, 0, 3],
    [4, 1, 6],
    [5, 1, 8],
    [6, 1, 10],
  ])("output %f maps to segment %i source %f and back", (out, idx, src) => {
    expect(outputDuration(segs)).toBe(6);
    const m = outputToSource(segs, out);
    expect(m.index).toBe(idx);
    expect(m.source).toBeCloseTo(src);
    expect(sourceToOutput(segs, m.index, m.source)).toBeCloseTo(out);
  });

  it.each([
    ["split inside second segment", 5, [[0, 4], [6, 8], [8, 10]]],
    ["split on boundary does nothing", 4, [[0, 4], [6, 10]]],
  ] as const)("%s", (_name, at, expected) => {
    const result = splitAt(segs, at, () => "new");
    expect(result.map((s) => [s.start, s.end])).toEqual(expected);
  });

  it.each([
    ["end cannot pass next start", "a", "end", 9, 6],
    ["start cannot pass previous end", "b", "start", 1, 4],
    ["start keeps minimum length", "a", "start", 3.99, 3.9],
    ["start cannot go negative", "a", "start", -2, 0],
    ["end clamped to source duration", "b", "end", 50, 12],
  ] as const)("trim: %s", (_name, id, edge, value, expected) => {
    const result = trimEdge(segs, id, edge, value, 12);
    const seg = result.find((s) => s.id === id)!;
    expect(seg[edge]).toBeCloseTo(expected);
  });
});

describe("zoom", () => {
  const zooms: ZoomRegion[] = [{ id: "z", start: 2, end: 6, scale: 2, x: 0.9, y: 0.5, instant: false }];
  it.each([
    ["before region: full view", 0, { x: 0, y: 0, w: 1, h: 1 }],
    ["fully zoomed: focus clamped inside frame", 4, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }],
    ["after region: full view", 7, { x: 0, y: 0, w: 1, h: 1 }],
  ])("%s", (_name, t, expected) => {
    const v = zoomViewport(zooms, t);
    expect(v.x).toBeCloseTo(expected.x);
    expect(v.y).toBeCloseTo(expected.y);
    expect(v.w).toBeCloseTo(expected.w);
    expect(v.h).toBeCloseTo(expected.h);
  });
});

describe("layout", () => {
  it.each([
    ["wide 1080p", "wide", 1920, 1, [1920, 1080]],
    ["vertical 1080p", "vertical", 1920, 1, [1080, 1920]],
    ["auto follows content", "auto", 1280, 4 / 3, [1280, 960]],
  ] as const)("output size %s", (_name, aspect, long, contentAspect, expected) => {
    expect(outputSize(aspect, long, contentAspect)).toEqual(expected);
  });

  it("fits a 16:9 frame inside a square canvas with padding", () => {
    const r = fitFrame(1000, 1000, 16 / 9, 0.1);
    expect(r.w).toBeCloseTo(800);
    expect(r.h).toBeCloseTo(450);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(275);
  });
});
