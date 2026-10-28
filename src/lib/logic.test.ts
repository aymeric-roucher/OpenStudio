import { describe, expect, it } from "vitest";
import { freeSlot, moveRegion, outputSpanToSource, regionsToOutput, sourceRangeToOutput, speedUpRanges, outputDuration, outputToSource, sourceToOutput, splitAt, trimEdge } from "./timeline";
import { zoomViewport } from "./zoom";
import { cursorAt, inferClicks, suggestClickZooms } from "./cursor";
import { toSubtitles } from "./subtitles";
import { fitFrame, outputSize } from "./layout";
import { exportPlan, gifDelay } from "./exporter";
import { groupWords } from "./transcribe";
import { timeStretch } from "./timestretch";
import type { CameraCorner, CameraSettings, Project, Segment, ZoomRegion } from "./types";
import { DEFAULT_STYLE, normalizeStyle } from "./defaults";
import { cameraCropRect, cameraState } from "./render";

const segs: Segment[] = [
  { id: "a", start: 0, end: 4, speed: 1, volume: 1 },
  { id: "b", start: 6, end: 10, speed: 2, volume: 1 },
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

  const regions = [
    { id: "r1", start: 1, end: 3 },
    { id: "r2", start: 5, end: 6 },
  ];
  it.each([
    ["move is blocked by next region", "r1", "move", 3, 5, [3, 5]],
    ["move is blocked by timeline start", "r2", "move", -1, 0, [3, 4]],
    ["resize start blocked by previous region", "r2", "start", 2, 6, [3, 6]],
    ["resize end blocked by total duration", "r2", "end", 5, 20, [5, 10]],
  ] as const)("region: %s", (_name, id, mode, start, end, expected) => {
    const r = moveRegion(regions, id, start, end, 10, mode).find((x) => x.id === id)!;
    expect([r.start, r.end]).toEqual(expected);
  });

  it.each([
    ["free space", 7, [7, 9]],
    ["shortened by next region", 4, [4, 5]],
    ["no room inside a region", 2, null],
    ["at the end, placed before the playhead", 10, [8, 10]],
  ] as const)("free slot: %s", (_name, t, expected) => {
    expect(freeSlot(regions, t, 2, 10)).toEqual(expected);
  });

  it.each([
    ["range inside one segment", [{ start: 1, end: 2 }], [[0, 1, 1], [1, 2, 4], [2, 4, 1], [6, 10, 2]]],
    ["range across a cut", [{ start: 3, end: 7 }], [[0, 3, 1], [3, 4, 4], [6, 7, 4], [7, 10, 2]]],
    ["range covering a whole segment", [{ start: 5, end: 11 }], [[0, 4, 1], [6, 10, 4]]],
  ] as const)("speed up ranges: %s", (_name, ranges, expected) => {
    const result = speedUpRanges(segs, ranges, 4, () => "n");
    expect(result.map((s) => [s.start, s.end, s.speed])).toEqual(expected);
  });

  it.each([
    ["inside first segment", 1, 3, [1, 3]],
    ["starts in a cut", 5, 8, [4, 5]],
    ["entirely in a cut", 4.5, 5.5, null],
    ["spans the cut", 3, 7, [3, 4.5]],
  ] as const)("source range to output: %s", (_name, s, e, expected) => {
    expect(sourceRangeToOutput(segs, s, e)).toEqual(expected);
  });

  it("maps source-time regions onto the output, dropping the ones that were cut", () => {
    const regions = [{ id: "x", start: 1, end: 3 }, { id: "y", start: 5, end: 8 }, { id: "z", start: 4.5, end: 5.5 }];
    expect(regionsToOutput(segs, regions).map((r) => [r.id, r.start, r.end])).toEqual([["x", 1, 3], ["y", 4, 5]]);
  });

  it.each([
    ["inside one segment", 1, 3, [1, 3]],
    ["ends on a cut", 3, 4, [3, 4]],
    ["crosses a cut", 3, 5, [3, 8]],
  ] as const)("output span to source: %s", (_name, a, b, expected) => {
    expect(outputSpanToSource(segs, a, b)).toEqual(expected);
  });
});

describe("zoom", () => {
  const zooms: ZoomRegion[] = [{ id: "z", start: 2, end: 6, scale: 2, x: 0.9, y: 0.5, instant: false, follow: false }];
  it.each([
    ["before region: full view", 0, { x: 0, y: 0, w: 1, h: 1 }],
    ["fully zoomed: focus clamped inside frame", 4, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }],
    ["after region: full view", 7, { x: 0, y: 0, w: 1, h: 1 }],
    ["base view outside zooms", 0, { x: 0.25, y: 0, w: 0.5, h: 0.5 }, { x: 0.25, y: 0, w: 0.5, h: 0.5 }],
    ["zoom is relative to the base view", 4, { x: 0.75, y: 0.375, w: 0.25, h: 0.25 }, { x: 0.25, y: 0, w: 0.5, h: 0.5 }],
  ])("%s", (_name, t, expected, base?: { x: number; y: number; w: number; h: number }) => {
    const v = zoomViewport(zooms, t, 0.6, base);
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
    ["custom keeps the typed ratio", "custom", 1350, 1, [1080, 1350]],
  ] as const)("output size %s", (_name, aspect, long, contentAspect, expected) => {
    expect(outputSize({ aspect, customSize: { w: 1080, h: 1350 } }, long, contentAspect)).toEqual(expected);
  });

  it("fits a 16:9 frame inside a square canvas with padding", () => {
    const r = fitFrame(1000, 1000, 16 / 9, 0.1);
    expect(r.w).toBeCloseTo(800);
    expect(r.h).toBeCloseTo(450);
    expect(r.x).toBeCloseTo(100);
    expect(r.y).toBeCloseTo(275);
  });
});

describe("camera", () => {
  const square = { aspect: 1, zoom: 1, x: 0.5, y: 0.5 };
  const project = (corner: CameraCorner): Project => ({
    ...DEFAULT_STYLE,
    camera: { ...DEFAULT_STYLE.camera, corner, margin: 0.05, crop: square },
    name: "t", segments: segs, zooms: [], masks: [], cameraLayouts: [], captions: [], crop: { x: 0, y: 0, w: 1, h: 1 },
    volume: 1, muted: false, music: null, cursor: [],
  });
  it.each([
    ["bottom-right", 1920, 1080],
    ["bottom-left", 1920, 1080],
    ["top-right", 1080, 1920],
    ["top-left", 1080, 1080],
  ] as const)("%s bubble keeps the same gap to both edges on %i x %i", (corner, W, H) => {
    const r = cameraState(project(corner), W, H, 16 / 9, 0).rect;
    const gap = 0.05 * Math.min(W, H);
    const gx = corner.endsWith("right") ? W - (r.x + r.w) : r.x;
    const gy = corner.startsWith("bottom") ? H - (r.y + r.h) : r.y;
    expect(gx).toBeCloseTo(gap);
    expect(gy).toBeCloseTo(gap);
    expect(r.w).toBeCloseTo(r.h);
  });

  it.each([
    ["square crop of a 16:9 camera", square, { x: 0.21875, y: 0, w: 0.5625, h: 1 }],
    ["original ratio keeps the whole frame", { aspect: null, zoom: 1, x: 0.5, y: 0.5 }, { x: 0, y: 0, w: 1, h: 1 }],
    ["zoomed crop is clamped inside the frame", { aspect: 1, zoom: 2, x: 0, y: 0.5 }, { x: 0, y: 0.25, w: 0.28125, h: 0.5 }],
  ] as const)("camera crop: %s", (_name, crop, expected) => {
    const r = cameraCropRect(crop, 16 / 9);
    expect(r.x).toBeCloseTo(expected.x);
    expect(r.y).toBeCloseTo(expected.y);
    expect(r.w).toBeCloseTo(expected.w);
    expect(r.h).toBeCloseTo(expected.h);
  });

  it.each([
    ["old rounded bubble at bottom left", { x: 0.12, y: 0.8, shape: "rounded" }, { corner: "bottom-left", aspect: 1, roundness: 0.44 }],
    ["old rectangle at top right", { x: 0.9, y: 0.1, shape: "square" }, { corner: "top-right", aspect: null, roundness: 0.12 }],
    ["old circle", { x: 0.9, y: 0.9, shape: "circle" }, { corner: "bottom-right", aspect: 1, roundness: 1 }],
    ["missing camera gets the default", undefined, { corner: "bottom-right", aspect: 1, roundness: DEFAULT_STYLE.camera.roundness }],
  ] as const)("stored looks are upgraded: %s", (_name, camera, expected) => {
    const style = normalizeStyle({ padding: 0.1, ...(camera ? { camera: camera as unknown as CameraSettings } : {}) });
    expect(style.padding).toBe(0.1);
    expect(style.zoomSpeed).toBe(DEFAULT_STYLE.zoomSpeed);
    expect({ corner: style.camera.corner, aspect: style.camera.crop.aspect, roundness: style.camera.roundness }).toEqual(expected);
  });
});

describe("subtitles", () => {
  const caps = [
    { id: "1", start: 1, end: 2.5, text: "Hello there" },
    { id: "2", start: 4.2, end: 5, text: "cut away" },
    { id: "3", start: 6, end: 8, text: "Fast part" },
  ];
  it.each([
    ["srt", "1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:04,000 --> 00:00:05,000\nFast part\n"],
    ["vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there\n\n00:00:04.000 --> 00:00:05.000\nFast part\n"],
  ] as const)("%s follows the edited timeline", (format, expected) => {
    expect(toSubtitles(caps, segs, format)).toBe(expected);
  });
});

describe("captions", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  it.each([
    ["splits at max words", [w(" a", 0, 0.2), w(" b", 0.2, 0.4), w(" c", 0.4, 0.6)], 2, [["a b", 0, 0.4], ["c", 0.4, 0.6]]],
    ["splits on long gaps", [w(" a", 0, 0.2), w(" b", 1, 1.2)], 7, [["a", 0, 0.2], ["b", 1, 1.2]]],
    ["splits after sentence punctuation", [w(" Hi.", 0, 0.3), w(" Yes?", 0.3, 0.5), w(" ok", 0.5, 0.7)], 7, [["Hi.", 0, 0.3], ["Yes?", 0.3, 0.5], ["ok", 0.5, 0.7]]],
    ["keeps unspaced scripts intact", [w("你", 0, 0.2), w("好", 0.2, 0.4)], 7, [["你好", 0, 0.4]]],
  ] as const)("%s", (_name, words, maxWords, expected) => {
    const captions = groupWords([...words], maxWords, 0.6);
    expect(captions.map((c) => [c.text, c.start, c.end])).toEqual(expected);
  });
});

describe("export", () => {
  const rec = { width: 1920, height: 1080 };
  const base = { crop: { x: 0, y: 0, w: 1, h: 1 }, segments: segs, customSize: { w: 1080, h: 1350 } };
  it.each([
    ["mp4 keeps settings", "wide", { format: "mp4", long: 1920, fps: 60, quality: "high" }, { width: 1920, height: 1080, fps: 60, frames: 360 }],
    ["gif caps fps and size", "wide", { format: "gif", long: 3840, fps: 30, quality: "low" }, { width: 960, height: 540, fps: 15, frames: 90 }],
    ["custom size is exported exactly", "custom", { format: "mp4", long: 3840, fps: 60, quality: "high" }, { width: 1080, height: 1350, fps: 60, frames: 360 }],
    ["custom gif is scaled down to the gif cap", "custom", { format: "gif", long: 1920, fps: 30, quality: "low" }, { width: 768, height: 960, fps: 15, frames: 90 }],
  ] as const)("plan: %s", (_name, aspect, settings, expected) => {
    expect(exportPlan(rec, { ...base, aspect }, settings)).toEqual(expected);
  });

  it.each([15, 24, 30])("gif delays at %i fps add up to the exact duration", (fps) => {
    const total = Array.from({ length: fps * 3 }, (_, i) => gifDelay(i, fps)).reduce((a, b) => a + b, 0);
    expect(total).toBe(3000);
  });
});

describe("autozoom", async () => {
  const { findIdleRanges, findTypingRanges, suggestZooms } = await import("./autozoom");
  type Sample = import("./autozoom").ActivitySample;
  const small = { x: 0.8, y: 0.1, w: 0.1, h: 0.1 };
  const full = { x: 0, y: 0, w: 1, h: 1 };
  /** Samples every 0.2 s over [0.2, end]; `at` gives the change box at time t (null for none). */
  const track = (end: number, at: (t: number) => Sample["box"]): Sample[] =>
    Array.from({ length: Math.round(end / 0.2) }, (_, i) => {
      const t = Math.round((i + 1) * 2) / 10;
      const box = at(t);
      return { t, box, amount: box ? box.w * box.h : 0 };
    });
  const within = (t: number, a: number, b: number) => t >= a - 1e-9 && t <= b + 1e-9;

  // Static scene, typing in a corner (1..4 s), full-screen switch at 5 s, idle until 10 s.
  const scenario = track(10, (t) => (within(t, 1, 4) ? small : within(t, 5, 5) ? full : null));

  it.each([
    ["typing corner then switch", scenario, [{ start: 0.5, end: 4.8, x: 0.85, y: 0.15, scale: 2.5 }]],
    ["a window switch cuts the hold short", track(8, (t) => (within(t, 1, 3) ? small : within(t, 3.6, 3.6) ? full : null)), [{ start: 0.5, end: 3.4, x: 0.85, y: 0.15, scale: 2.5 }]],
    ["full-screen changes only", track(6, () => full), []],
    ["activity only in the first 0.5 s", track(6, (t) => (t <= 0.4 ? small : null)), []],
    ["single isolated change", track(6, (t) => (within(t, 3, 3) ? small : null)), []],
    [
      "two distant moments in different places",
      track(10, (t) =>
        within(t, 1, 1.6) ? { x: 0, y: 0, w: 0.4, h: 0.2 } : within(t, 6, 6.6) ? { x: 0.5, y: 0.5, w: 0.25, h: 0.25 } : null,
      ),
      [
        { start: 0.5, end: 2.6, x: 0.2, y: 0.1, scale: 1.4 },
        { start: 5.4, end: 7.6, x: 0.625, y: 0.625, scale: 2 },
      ],
    ],
  ] as const)("suggestZooms: %s", (_name, samples, expected) => {
    const zooms = suggestZooms(samples);
    expect(zooms).toHaveLength(expected.length);
    zooms.forEach((z, i) => {
      for (const k of ["start", "end", "x", "y", "scale"] as const) expect(z[k]).toBeCloseTo(expected[i][k]);
      if (i > 0) expect(z.start).toBeGreaterThan(zooms[i - 1].end);
    });
  });

  it.each([
    ["idle after the switch", findIdleRanges(scenario, 2), [{ start: 5, end: 10 }]],
    ["idle with a shorter minimum", findIdleRanges(scenario, 0.5), [{ start: 0.2, end: 0.8 }, { start: 4, end: 4.8 }, { start: 5, end: 10 }]],
    ["typing in the corner", findTypingRanges(scenario, 1), [{ start: 0.8, end: 4 }]],
    [
      "typing with short pauses stays one range",
      findTypingRanges(track(6, (t) => (within(t, 1, 4) && Math.round(t * 5) % 3 !== 0 ? small : null)), 1),
      [{ start: 0.8, end: 4 }],
    ],
    ["full-screen changes are not typing", findTypingRanges(track(6, () => full), 1), []],
    [
      "a cursor sweeping across lines is not typing",
      findTypingRanges(track(6, (t) => ({ x: 0.1, y: t / 3, w: 0.05, h: 0.05 })), 1),
      [],
    ],
  ])("ranges: %s", (_name, ranges, expected) => {
    expect(ranges).toHaveLength(expected.length);
    ranges.forEach((r, i) => {
      expect(r.start).toBeCloseTo(expected[i].start);
      expect(r.end).toBeCloseTo(expected[i].end);
    });
  });
});

describe("timeStretch", () => {
  const sr = 48000;
  const crossings = (x: Float32Array) => x.reduce((n, v, i) => n + (i > 0 && (x[i - 1] < 0) !== (v < 0) ? 1 : 0), 0);
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

  it.each([
    [440, 2, 1],
    [440, 0.5, 2],
    [150, 1.5, 2],
  ])("a %d Hz sine stretched at rate %d keeps its frequency and level (%d channels)", (freq, rate, channels) => {
    const sine = Float32Array.from({ length: 2 * sr }, (_, i) => Math.sin((2 * Math.PI * freq * i) / sr));
    const out = timeStretch(Array.from({ length: channels }, () => sine), rate, sr);
    expect(out).toHaveLength(channels);
    for (const c of out) {
      expect(c.length).toBe(Math.round(sine.length / rate));
      expect(crossings(c) / 2 / (c.length / sr)).toBeCloseTo(freq, -0.5);
      expect(rms(c)).toBeCloseTo(Math.SQRT1_2, 1);
    }
  });
});

describe("cursor", () => {
  type Way = [number, number, number][];
  const at = (way: Way, t: number) => {
    const i = way.findIndex((w) => w[0] >= t);
    if (i <= 0) return { x: way[Math.max(i, 0)][1], y: way[Math.max(i, 0)][2] };
    const [t0, x0, y0] = way[i - 1];
    const [t1, x1, y1] = way[i];
    const p = (t - t0) / (t1 - t0);
    return { x: x0 + (x1 - x0) * p, y: y0 + (y1 - y0) * p };
  };
  /** Cursor samples every 0.1 s from `visibleFrom`, and activity every 0.2 s: the cursor's own motion plus `changes`. */
  const scene = (way: Way, changes: [number, number, number][], visibleFrom = 0) => {
    const end = way[way.length - 1][0];
    const cursor = Array.from({ length: Math.round(end * 10) + 1 }, (_, i) => ({ t: i / 10, ...at(way, i / 10) })).filter((s) => s.t >= visibleFrom);
    const activity = Array.from({ length: Math.round(end * 5) + 1 }, (_, i) => {
      const t = i / 5;
      const pts = [at(way, t - 0.2), at(way, t)];
      const boxes = changes.filter(([c]) => c > t - 0.2 && c <= t).map(([, x, y]) => ({ x: x - 0.04, y: y - 0.03, w: 0.08, h: 0.06 }));
      if (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) > 1e-9) {
        const x = Math.min(pts[0].x, pts[1].x) - 0.02;
        const y = Math.min(pts[0].y, pts[1].y) - 0.02;
        boxes.push({ x, y, w: Math.abs(pts[0].x - pts[1].x) + 0.04, h: Math.abs(pts[0].y - pts[1].y) + 0.06 });
      }
      if (i === 0 || boxes.length === 0) return { t, box: null, amount: 0 };
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      const box = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
      return { t, box, amount: box.w * box.h };
    });
    return { cursor, activity, duration: end };
  };
  const move: Way = [[0, 0.8, 0.8], [1, 0.2, 0.3], [3, 0.2, 0.3]];
  const tour: Way = [[0, 0.5, 0.5], [1, 0.2, 0.3], [2, 0.2, 0.3], [2.5, 0.3, 0.35], [3.5, 0.3, 0.35], [5, 0.8, 0.8], [7, 0.8, 0.8]];

  it.each([
    ["a change next to the stopped cursor is a click", scene(move, [[1.3, 0.21, 0.31]]), [[1.2, 0.2, 0.3]], [[0.7, 2.4, 0.2, 0.3]]],
    ["a change far from the cursor is not", scene(move, [[1.3, 0.7, 0.7]]), [], []],
    ["a cursor appearing after typing is not", scene(move, [[1.1, 0.2, 0.3]], 1.1), [], []],
    [
      "nearby clicks share a zoom, a far one gets its own",
      scene(tour, [[1.3, 0.21, 0.31], [2.7, 0.31, 0.36], [5.5, 0.81, 0.81]]),
      [[1.2, 0.2, 0.3], [2.6, 0.3, 0.35], [5.4, 0.8, 0.8]],
      [[0.7, 3.8, 0.25, 0.325], [4.9, 6.6, 0.8, 0.8]],
    ],
  ])("clicks: %s", (_name, { cursor, activity, duration }, expectedClicks, expectedZooms) => {
    const clicks = inferClicks(cursor, activity);
    expect(clicks).toHaveLength(expectedClicks.length);
    clicks.forEach((c, i) => [c.t, c.x, c.y].forEach((v, k) => expect(v).toBeCloseTo(expectedClicks[i][k])));
    const zooms = suggestClickZooms(clicks, duration);
    expect(zooms).toHaveLength(expectedZooms.length);
    zooms.forEach((z, i) => {
      [z.start, z.end, z.x, z.y].forEach((v, k) => expect(v).toBeCloseTo(expectedZooms[i][k]));
      expect(z.scale).toBe(2);
    });
  });

  const path = [...Array.from({ length: 21 }, (_, i) => ({ t: i / 10, x: i / 20, y: 0.5 })), { t: 5, x: 0.9, y: 0.1 }];
  it.each([
    ["nearest sample without smoothing", 0.52, 0, { x: 0.25, y: 0.5 }],
    ["a symmetric window keeps a straight path", 1, 0.2, { x: 0.5, y: 0.5 }],
    ["a lone sample within a second", 4.5, 0.2, { x: 0.9, y: 0.1 }],
    ["no sample within a second", 3.5, 0.2, null],
    ["before the first sample", -2, 0.2, null],
  ])("cursorAt: %s", (_name, t, smoothing, expected) => {
    const p = cursorAt(path, t, smoothing);
    if (expected === null) return expect(p).toBeNull();
    expect(p?.x).toBeCloseTo(expected.x);
    expect(p?.y).toBeCloseTo(expected.y);
  });
});
