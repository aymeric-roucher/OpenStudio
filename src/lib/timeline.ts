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

type Span = { id: string; start: number; end: number };
export const MIN_REGION = 0.3;

/** Move or resize a region on its track, without overlapping its neighbours or leaving [0, total]. */
export function moveRegion<T extends Span>(regions: T[], id: string, start: number, end: number, total: number, mode: "move" | "start" | "end"): T[] {
  const r = regions.find((x) => x.id === id)!;
  const others = regions.filter((x) => x.id !== id);
  const lo = Math.max(0, ...others.filter((x) => x.end <= r.start).map((x) => x.end));
  const hi = Math.min(total, ...others.filter((x) => x.start >= r.end).map((x) => x.start));
  let s = r.start, e = r.end;
  if (mode === "move") {
    const len = r.end - r.start;
    s = Math.min(Math.max(start, lo), hi - len);
    e = s + len;
  }
  if (mode === "start") s = Math.min(Math.max(start, lo), r.end - MIN_REGION);
  if (mode === "end") e = Math.max(Math.min(end, hi), r.start + MIN_REGION);
  return regions.map((x) => (x.id === id ? { ...x, start: s, end: e } : x));
}

/** Room for a new region of up to `length` seconds at t: after t if possible, else ending at t. Null if there is not enough. */
export function freeSlot(regions: Span[], t: number, length: number, total: number): [number, number] | null {
  if (regions.some((x) => t > x.start && t < x.end)) return null;
  const next = Math.min(total, ...regions.filter((x) => x.start >= t).map((x) => x.start));
  const end = Math.min(t + length, next);
  if (end - t >= 0.5) return [t, end];
  const prev = Math.max(0, ...regions.filter((x) => x.end <= t).map((x) => x.end));
  const start = Math.max(t - length, prev);
  return t - start >= 0.5 ? [start, t] : null;
}

/** Regions stored in source seconds, placed on the output timeline. Fully cut regions are dropped. */
export function regionsToOutput<T extends Span>(segments: Segment[], regions: T[]): T[] {
  return regions.flatMap((r) => {
    const o = sourceRangeToOutput(segments, r.start, r.end);
    return o ? [{ ...r, start: o[0], end: o[1] }] : [];
  });
}

/** Source span for an output span. An end landing on a cut maps to the end of the segment before it. */
export function outputSpanToSource(segments: Segment[], start: number, end: number): [number, number] {
  const a = outputToSource(segments, start).source;
  const offsets = segmentOffsets(segments);
  const i = offsets.findIndex((o, k) => end <= o + (segments[k].end - segments[k].start) / segments[k].speed + 1e-9);
  const k = i === -1 ? segments.length - 1 : i;
  const s = segments[k];
  const b = s.start + Math.min(Math.max(end - offsets[k], 0), (s.end - s.start) / s.speed) * s.speed;
  return [a, b];
}

/** Play the given source ranges at `speed`, splitting segments at range boundaries. */
export function speedUpRanges(segments: Segment[], ranges: readonly { start: number; end: number }[], speed: number, newId: () => string): Segment[] {
  const inside = (t: number) => ranges.some((r) => t >= r.start && t < r.end);
  return segments.flatMap((s) => {
    const cuts = ranges
      .flatMap((r) => [r.start, r.end])
      .filter((c) => c - s.start >= MIN_SEGMENT && s.end - c >= MIN_SEGMENT)
      .sort((a, b) => a - b);
    const bounds = [s.start, ...cuts, s.end];
    return bounds.slice(0, -1).map((start, i) => {
      const end = bounds[i + 1];
      return { ...s, id: i === 0 ? s.id : newId(), start, end, speed: inside((start + end) / 2) ? speed : s.speed };
    });
  });
}

/** Output span covering what remains of a source range after cuts, or null if it was cut entirely. */
export function sourceRangeToOutput(segments: Segment[], start: number, end: number): [number, number] | null {
  const kept = segments
    .map((s, i) => ({ i, a: Math.max(start, s.start), b: Math.min(end, s.end) }))
    .filter((k) => k.b > k.a);
  if (!kept.length) return null;
  const first = kept[0], last = kept[kept.length - 1];
  return [sourceToOutput(segments, first.i, first.a), sourceToOutput(segments, last.i, last.b)];
}
