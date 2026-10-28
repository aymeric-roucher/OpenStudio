import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { ActivitySample, Box, ZoomSuggestion } from "./autozoom";
import type { CursorSample } from "./types";

/** A likely mouse click: source seconds, position normalized to the full source frame. */
export type Click = { t: number; x: number; y: number };

/** Tracking resolution: a 1080p cursor (about 20 px tall) is 8 px tall here. */
const TRACK_WIDTH = 800;
const SAMPLE_INTERVAL = 1 / 12;
/** Cursor heights searched, as fractions of the frame height (1x and 1.5x cursors on common displays). */
const CURSOR_HEIGHTS = [0.016, 0.019, 0.022, 0.026, 0.031, 0.036];
/** Sub-pixel offsets of the hotspot: a few-pixel cursor looks different at each phase once downscaled. */
const PHASES = [0, 0.5];
/** Minimum absolute normalized cross-correlation for a detection. */
const MIN_SCORE = 0.8;
/** Minimum luma gap between the bright and dark key pixels of a template, to skip flat patches cheaply. */
const KEY_CONTRAST = 50;
const CELL = 16;
/** Tracking window around the previous position, in tracking pixels (fast moves are found by frame differencing). */
const SEARCH_RADIUS = 24;
const LUMA_THRESHOLD = 24;

/** Template pixels: offsets to the hotspot in a frame row-major array, zero-mean unit-norm values, and a few key pixels for a cheap pre-check. */
type Template = { off: Int32Array; v: Float32Array; dark: number[]; bright: number[]; box: [number, number, number, number] };
type Shape = { fill: string; outline: string; width: number; draw: (ctx: OffscreenCanvasRenderingContext2D) => void };

/** Shapes in units of the cursor height, hotspot at the origin. */
const SHAPES: Shape[] = [
  {
    // Arrow: macOS (black, white outline); Windows (white, black outline) is the same shape inverted.
    fill: "#000",
    outline: "#fff",
    width: 0.1,
    draw: (ctx) => {
      ctx.moveTo(0, 0);
      for (const [x, y] of [[0, 0.84], [0.22, 0.65], [0.36, 0.98], [0.5, 0.92], [0.36, 0.6], [0.62, 0.6]]) ctx.lineTo(x, y);
      ctx.closePath();
    },
  },
  {
    // I-beam, hotspot at its center.
    fill: "#000",
    outline: "#fff",
    width: 0.12,
    draw: (ctx) => {
      ctx.rect(-0.03, -0.5, 0.06, 1);
      ctx.rect(-0.18, -0.5, 0.36, 0.05);
      ctx.rect(-0.18, 0.45, 0.36, 0.05);
    },
  },
  {
    // Pointing hand, hotspot at the index fingertip.
    fill: "#fff",
    outline: "#000",
    width: 0.07,
    draw: (ctx) => {
      ctx.roundRect(-0.09, 0, 0.18, 0.6, 0.09);
      ctx.roundRect(-0.3, 0.38, 0.75, 0.62, 0.15);
    },
  },
];

const luma = (rgba: Uint8ClampedArray, i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

function renderTemplate(shape: Shape, height: number, phaseX: number, phaseY: number, frameWidth: number): Template {
  const margin = Math.ceil(height * 0.6);
  const size = Math.ceil(height * 1.2) + 2 * margin;
  const ctx = new OffscreenCanvas(size, size).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  ctx.translate(margin + phaseX, margin + phaseY);
  ctx.scale(height, height);
  ctx.beginPath();
  shape.draw(ctx);
  ctx.lineJoin = "round";
  ctx.lineWidth = 2 * shape.width;
  ctx.strokeStyle = shape.outline;
  ctx.stroke();
  ctx.fillStyle = shape.fill;
  ctx.fill();
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const px: { dx: number; dy: number; v: number }[] = [];
  for (let i = 0; i < size * size; i++) if (rgba[i * 4 + 3] >= 128) px.push({ dx: (i % size) - margin, dy: Math.floor(i / size) - margin, v: luma(rgba, i) });
  const mean = px.reduce((s, p) => s + p.v, 0) / px.length;
  const norm = Math.sqrt(px.reduce((s, p) => s + (p.v - mean) ** 2, 0));
  const v = Float32Array.from(px, (p) => (p.v - mean) / norm);
  const keys = (sign: number) => {
    const idx = [...v.keys()].filter((i) => v[i] * sign > 0).sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]));
    const strong = idx.slice(0, Math.max(1, Math.ceil(idx.length / 2))).sort((a, b) => a - b);
    return [0, 1, 2, 3].map((k) => strong[Math.floor((k * strong.length) / 4)]);
  };
  const dx = Int16Array.from(px, (p) => p.dx);
  const dy = Int16Array.from(px, (p) => p.dy);
  const off = Int32Array.from(px, (p) => p.dy * frameWidth + p.dx);
  return { off, v, dark: keys(-1), bright: keys(1), box: [Math.min(...dx), Math.min(...dy), Math.max(...dx), Math.max(...dy)] };
}

type Match = { x: number; y: number; score: number };

/** Best template match with its hotspot inside the marked cells. */
function search(img: Float32Array, width: number, height: number, cells: Uint8Array, cols: number, templates: Template[]): Match | null {
  let best: Match | null = null;
  for (let c = 0; c < cells.length; c++) {
    if (!cells[c]) continue;
    const cx = (c % cols) * CELL;
    const cy = Math.floor(c / cols) * CELL;
    for (const tp of templates) {
      const { off } = tp;
      const [bx0, by0, bx1, by1] = tp.box;
      const xs = Math.max(cx, -bx0);
      const xe = Math.min(cx + CELL, width - bx1);
      const ys = Math.max(cy, -by0);
      const ye = Math.min(cy + CELL, height - by1);
      const n = off.length;
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const p = y * width + x;
          let key = 0;
          for (let k = 0; k < 4; k++) key += img[p + off[tp.bright[k]]] - img[p + off[tp.dark[k]]];
          if (Math.abs(key) < 4 * KEY_CONTRAST) continue;
          let s1 = 0;
          let s2 = 0;
          let dot = 0;
          for (let k = 0; k < n; k++) {
            const val = img[p + off[k]];
            s1 += val;
            s2 += val * val;
            dot += tp.v[k] * val;
          }
          const score = Math.abs(dot) / Math.sqrt(s2 - (s1 * s1) / n);
          if (!best || score > best.score) best = { x, y, score };
        }
      }
    }
  }
  return best;
}

/** Marks cells with changed pixels, dilated by one cell so hotspots of cursors overlapping a change are searched. */
function markChanged(prev: Float32Array, cur: Float32Array, width: number, cells: Uint8Array, cols: number) {
  const rows = cells.length / cols;
  const changed = new Uint8Array(cells.length);
  for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - prev[i]) > LUMA_THRESHOLD) changed[Math.floor(Math.floor(i / width) / CELL) * cols + Math.floor((i % width) / CELL)] = 1;
  for (let c = 0; c < changed.length; c++) {
    if (!changed[c]) continue;
    const r = Math.floor(c / cols);
    const k = c % cols;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++)
      for (let kk = Math.max(0, k - 1); kk <= Math.min(cols - 1, k + 1); kk++) cells[rr * cols + kk] = 1;
  }
}

/**
 * Finds the system cursor baked into the recorded pixels, about 12 times per second, by matching templates of common
 * cursors (arrow in both polarities, I-beam, pointing hand) at a few sizes. Each frame searches a window around the
 * previous position plus the regions that changed since the previous frame; the first frame is searched fully.
 * Only confident detections are returned. Browser only.
 */
export async function trackCursor(video: Blob, onProgress: (p: number) => void, signal: AbortSignal): Promise<CursorSample[]> {
  const input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("The recording has no video track");
  if (!(await track.canDecode())) throw new Error(`This browser cannot decode the ${track.codec} video track`);
  const duration = await input.computeDuration();
  const width = Math.min(TRACK_WIDTH, track.displayWidth);
  const height = Math.round((width * track.displayHeight) / track.displayWidth);
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  // Area-averaged downscaling keeps the thin cursor outline; the default bilinear sampling skips pixels.
  ctx.imageSmoothingQuality = "high";
  const templates = SHAPES.flatMap((shape) =>
    CURSOR_HEIGHTS.flatMap((h) => PHASES.flatMap((px) => PHASES.map((py) => renderTemplate(shape, h * height, px, py, width)))),
  );
  const cols = Math.ceil(width / CELL);
  const cells = new Uint8Array(cols * Math.ceil(height / CELL));

  const out: CursorSample[] = [];
  let prev: Float32Array | null = null;
  /** Last confident position: the window stays there while the cursor is lost, as it usually stops where it vanished. */
  let last: Match | null = null;
  let nextT = -Infinity;
  for await (const sample of new VideoSampleSink(track).samples()) {
    if (signal.aborted) sample.close();
    signal.throwIfAborted();
    const t = sample.timestamp;
    if (t < nextT) {
      sample.close();
      continue;
    }
    sample.drawWithFit(ctx, { fit: "fill" });
    sample.close();
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const cur = new Float32Array(width * height);
    for (let i = 0; i < cur.length; i++) cur[i] = luma(rgba, i);
    cells.fill(prev ? 0 : 1);
    if (prev) markChanged(prev, cur, width, cells, cols);
    if (last) {
      for (let y = Math.max(0, last.y - SEARCH_RADIUS); y <= Math.min(height - 1, last.y + SEARCH_RADIUS); y += CELL / 2)
        for (let x = Math.max(0, last.x - SEARCH_RADIUS); x <= Math.min(width - 1, last.x + SEARCH_RADIUS); x += CELL / 2)
          cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
    const best = search(cur, width, height, cells, cols, templates);
    if (best && best.score >= MIN_SCORE) {
      out.push({ t, x: best.x / width, y: best.y / height });
      last = best;
    }
    prev = cur;
    nextT = t + SAMPLE_INTERVAL * 0.9;
    onProgress(Math.min(Math.max(t / duration, 0), 1));
  }
  input.dispose();
  onProgress(1);
  return out;
}

/** Cursor moves smaller than this (normalized to the frame width or height) count as standing still. */
const STILL_DIST = 0.004;
/** Larger gaps between cursor samples break a pause (the cursor was lost). */
const MAX_SAMPLE_GAP = 0.3;
const MIN_PAUSE = 0.15;
/** A click's visual change must start within this many seconds of the cursor stopping. */
const CLICK_DELAY = 0.6;
/** Changes larger than this on either axis (scroll, window switch) are not clicks. */
const MAX_CLICK_BOX = 0.4;
/** How far from the change box the cursor may be. */
const NEAR = 0.03;
/** Area around a moving cursor's path where its own pixels change: cursor size plus the activity grid cell. */
const CURSOR_REACH = { x: 0.05, y: 0.08 };

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Maximal runs where the cursor stays within STILL_DIST of where it stopped. */
function findPauses(cursor: CursorSample[]): { start: number; end: number; x: number; y: number }[] {
  const pauses: { start: number; end: number; x: number; y: number }[] = [];
  let anchor = 0;
  for (let i = 1; i <= cursor.length; i++) {
    const s = cursor[i];
    if (s && s.t - cursor[i - 1].t <= MAX_SAMPLE_GAP && dist(s, cursor[anchor]) <= STILL_DIST) continue;
    const end = cursor[i - 1].t;
    if (end - cursor[anchor].t >= MIN_PAUSE) pauses.push({ start: cursor[anchor].t, end, x: cursor[anchor].x, y: cursor[anchor].y });
    anchor = i;
  }
  return pauses;
}

/**
 * Likely clicks: the cursor stops, and within CLICK_DELAY a localized visual change appears near it that the cursor's
 * own motion does not explain. One click per pause, at the cursor position. `cursor` and `activity` must be sorted by time.
 */
export function inferClicks(cursor: CursorSample[], activity: ActivitySample[]): Click[] {
  const clicks: Click[] = [];
  for (const pause of findPauses(cursor)) {
    for (let i = 1; i < activity.length; i++) {
      const { box, t: a1 } = activity[i];
      const a0 = activity[i - 1].t;
      if (a1 <= pause.start) continue;
      if (a0 > pause.start + CLICK_DELAY) break;
      if (!box || box.w > MAX_CLICK_BOX || box.h > MAX_CLICK_BOX) continue;
      if (pause.x < box.x - NEAR || pause.x > box.x + box.w + NEAR || pause.y < box.y - NEAR || pause.y > box.y + box.h + NEAR) continue;
      // The cursor must be known when the change starts: a cursor appearing (after typing, say) is not a click.
      if (!cursor.some((s) => s.t <= a0 && s.t >= a0 - MAX_SAMPLE_GAP)) continue;
      const path = cursor.filter((s) => s.t >= a0 - SAMPLE_INTERVAL && s.t <= a1);
      const moved = path.some((s) => dist(s, pause) > STILL_DIST);
      if (moved) {
        const x0 = Math.min(...path.map((s) => s.x)) - CURSOR_REACH.x;
        const x1 = Math.max(...path.map((s) => s.x)) + CURSOR_REACH.x;
        const y0 = Math.min(...path.map((s) => s.y)) - CURSOR_REACH.y;
        const y1 = Math.max(...path.map((s) => s.y)) + CURSOR_REACH.y;
        if (box.x >= x0 && box.x + box.w <= x1 && box.y >= y0 && box.y + box.h <= y1) continue;
      }
      clicks.push({ t: Math.max(pause.start, a0), x: pause.x, y: pause.y });
      break;
    }
  }
  return clicks;
}

const CLICK_LEAD = 0.5;
const CLICK_HOLD = 1.2;
/** Clicks closer than this in time, and within a CLICK_SPAN box, share one zoom. */
const CLICK_MERGE_GAP = 3;
const CLICK_SPAN = 0.3;
const CLICK_SCALE = 2;
const MIN_ZOOM = 1.5;
const ZOOM_GAP = 0.5;

/** Screen Studio-like zooms: start shortly before a click, hold while nearby clicks follow, non-overlapping. */
export function suggestClickZooms(clicks: Click[], duration: number): ZoomSuggestion[] {
  const groups: { first: number; last: number; box: Box }[] = [];
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) {
    const g = groups[groups.length - 1];
    if (g && c.t - g.last <= CLICK_MERGE_GAP) {
      const x = Math.min(g.box.x, c.x);
      const y = Math.min(g.box.y, c.y);
      const box = { x, y, w: Math.max(g.box.x + g.box.w, c.x) - x, h: Math.max(g.box.y + g.box.h, c.y) - y };
      if (box.w <= CLICK_SPAN && box.h <= CLICK_SPAN) {
        groups[groups.length - 1] = { first: g.first, last: c.t, box };
        continue;
      }
    }
    groups.push({ first: c.t, last: c.t, box: { x: c.x, y: c.y, w: 0, h: 0 } });
  }
  const zooms: ZoomSuggestion[] = [];
  for (const g of groups) {
    const prev = zooms[zooms.length - 1];
    const wanted = Math.max(0, g.first - CLICK_LEAD);
    if (prev) prev.end = Math.max(prev.start + MIN_ZOOM, Math.min(prev.end, wanted - ZOOM_GAP));
    const start = Math.max(wanted, prev ? prev.end + ZOOM_GAP : 0);
    const end = Math.min(duration, Math.max(g.last + CLICK_HOLD, start + MIN_ZOOM));
    if (end - start < MIN_ZOOM) continue;
    zooms.push({ start, end, x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2, scale: CLICK_SCALE });
  }
  return zooms;
}

/** Samples farther than this from `t` are ignored; none left means the cursor is unknown at `t`. */
const MAX_CURSOR_AGE = 1;

/**
 * Cursor position at source time `t`, smoothed with a Gaussian time window of `smoothing` seconds (0: nearest sample).
 * `cursor` must be sorted by time. Null when no sample lies within MAX_CURSOR_AGE of `t`.
 */
export function cursorAt(cursor: CursorSample[], t: number, smoothing: number): { x: number; y: number } | null {
  let lo = 0;
  let hi = cursor.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cursor[mid].t < t - MAX_CURSOR_AGE) lo = mid + 1;
    else hi = mid;
  }
  let nearest = -1;
  for (let i = lo; i < cursor.length && cursor[i].t <= t + MAX_CURSOR_AGE; i++)
    if (nearest < 0 || Math.abs(cursor[i].t - t) < Math.abs(cursor[nearest].t - t)) nearest = i;
  if (nearest < 0) return null;
  if (smoothing <= 0) return { x: cursor[nearest].x, y: cursor[nearest].y };
  // Weights relative to the nearest sample, so they never all underflow to zero.
  const d0 = (cursor[nearest].t - t) ** 2;
  let [w, x, y] = [0, 0, 0];
  for (let i = lo; i < cursor.length && cursor[i].t <= t + MAX_CURSOR_AGE; i++) {
    const wi = Math.exp(-((cursor[i].t - t) ** 2 - d0) / (2 * smoothing * smoothing));
    w += wi;
    x += wi * cursor[i].x;
    y += wi * cursor[i].y;
  }
  return { x: x / w, y: y / w };
}
