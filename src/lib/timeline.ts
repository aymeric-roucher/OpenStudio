import type { Segment } from "./types";

export const MIN_SEGMENT = 0.1;

const segLength = (s: Segment) => (s.end - s.start) / s.speed;

export function outputDuration(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + segLength(s), 0);
}

/** Output start time of each segment. */
export function segmentOffsets(segments: Segment[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const s of segments) {
    offsets.push(acc);
    acc += segLength(s);
  }
  return offsets;
}

/** Map an output time to a segment index and a source time. Times past the end clamp to the last frame. */
export function outputToSource(segments: Segment[], t: number): { index: number; source: number } {
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const len = segLength(s);
    if (t < acc + len || i === segments.length - 1) {
      const local = Math.min(Math.max(t - acc, 0), len);
      return { index: i, source: s.start + local * s.speed };
    }
    acc += len;
  }
  throw new Error("outputToSource called with no segments");
}

export function sourceToOutput(segments: Segment[], index: number, source: number): number {
  const s = segments[index];
  return segmentOffsets(segments)[index] + (source - s.start) / s.speed;
}

/** Split the segment under output time `t`. Splits too close to an edge are ignored. */
export function splitAt(segments: Segment[], t: number, newId: () => string): Segment[] {
  const { index, source } = outputToSource(segments, t);
  const s = segments[index];
  if (source - s.start < MIN_SEGMENT || s.end - source < MIN_SEGMENT) return segments;
  return [
    ...segments.slice(0, index),
    { ...s, end: source },
    { ...s, id: newId(), start: source },
    ...segments.slice(index + 1),
  ];
}

/** Move one edge of a segment (in source seconds), staying within neighbours and the source bounds. */
export function trimEdge(
  segments: Segment[],
  id: string,
  edge: "start" | "end",
  value: number,
  sourceDuration: number,
): Segment[] {
  const i = segments.findIndex((s) => s.id === id);
  const s = segments[i];
  if (edge === "start") {
    const lo = i > 0 ? segments[i - 1].end : 0;
    const start = Math.min(Math.max(value, lo), s.end - MIN_SEGMENT);
    return segments.map((x) => (x.id === id ? { ...x, start } : x));
  }
  const hi = i < segments.length - 1 ? segments[i + 1].start : sourceDuration;
  const end = Math.max(Math.min(value, hi), s.start + MIN_SEGMENT);
  return segments.map((x) => (x.id === id ? { ...x, end } : x));
}
