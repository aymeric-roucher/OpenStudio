import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";

export type Box = { x: number; y: number; w: number; h: number };
/** Visual change between the previous analyzed frame and the frame at source time `t`. */
export type ActivitySample = { t: number; box: Box | null; amount: number };
export type ZoomSuggestion = { start: number; end: number; x: number; y: number; scale: number };
export type TimeRange = { start: number; end: number };

const ANALYSIS_WIDTH = 160;
const SAMPLE_INTERVAL = 0.2;
const COLS = 32;
const ROWS = 18;
/** Per-pixel luma difference (0..255) above which a pixel counts as changed; below is compression noise. */
const LUMA_THRESHOLD = 24;
/** A changed cell with no changed neighbour needs at least this many changed pixels, otherwise it is noise. */
const ISOLATED_MIN_PIXELS = 3;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function luma(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return out;
}

/** Compares two luma frames on a COLS x ROWS grid. */
function diffFrames(prev: Float32Array, cur: Float32Array, width: number, height: number): Omit<ActivitySample, "t"> {
  const counts = new Uint16Array(COLS * ROWS);
  for (let y = 0; y < height; y++) {
    const row = Math.min(ROWS - 1, Math.floor((y * ROWS) / height));
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (Math.abs(cur[i] - prev[i]) > LUMA_THRESHOLD) counts[row * COLS + Math.min(COLS - 1, Math.floor((x * COLS) / width))]++;
    }
  }
  let changed = 0;
  let [x0, y0, x1, y1] = [COLS, ROWS, -1, -1];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const n = counts[r * COLS + c];
      if (n === 0) continue;
      let hasNeighbour = false;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && counts[rr * COLS + cc] > 0) hasNeighbour = true;
        }
      if (!hasNeighbour && n < ISOLATED_MIN_PIXELS) continue;
      changed++;
      x0 = Math.min(x0, c);
      y0 = Math.min(y0, r);
      x1 = Math.max(x1, c);
      y1 = Math.max(y1, r);
    }
  }
  if (changed === 0) return { box: null, amount: 0 };
  return {
    box: { x: x0 / COLS, y: y0 / ROWS, w: (x1 - x0 + 1) / COLS, h: (y1 - y0 + 1) / ROWS },
    amount: changed / (COLS * ROWS),
  };
}

/** Decodes the recording at low resolution, about 5 frames per second, and measures where pixels change. Browser only. */
export async function analyzeActivity(video: Blob, onProgress: (p: number) => void, signal: AbortSignal): Promise<ActivitySample[]> {
  const input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("The recording has no video track");
  if (!(await track.canDecode())) throw new Error(`This browser cannot decode the ${track.codec} video track`);
  const duration = await input.computeDuration();
  const width = ANALYSIS_WIDTH;
  const height = Math.max(ROWS, Math.round((ANALYSIS_WIDTH * track.displayHeight) / track.displayWidth));
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");

  const samples: ActivitySample[] = [];
  let prev: Float32Array | null = null;
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
    const cur = luma(ctx.getImageData(0, 0, width, height).data);
    if (prev) samples.push({ t, ...diffFrames(prev, cur, width, height) });
    prev = cur;
    nextT = t + SAMPLE_INTERVAL * 0.9;
    onProgress(clamp(t / duration, 0, 1));
  }
  input.dispose();
  onProgress(1);
  return samples;
}

/** Start of the change measured by sample `i`: the time of the previous analyzed frame. */
const changeStart = (samples: ActivitySample[], i: number) => (i > 0 ? samples[i - 1].t : samples[i].t);

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Maximal ranges where consecutive analyzed frames show no visual change at all. */
export function findIdleRanges(samples: ActivitySample[], minDuration: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  let start: number | null = null;
  samples.forEach((s, i) => {
    if (s.box === null) {
      start ??= changeStart(samples, i);
      return;
    }
    if (start !== null) ranges.push({ start, end: samples[i - 1].t });
    start = null;
  });
  if (start !== null) ranges.push({ start, end: samples[samples.length - 1].t });
  return ranges.filter((r) => r.end - r.start >= minDuration);
}

/**
 * Typing-like ranges: a sustained stream of small changes (a few characters per frame) that stay within a band of
 * a few text lines, with pauses shorter than `maxPause`. Any large change (scroll, window switch) ends the range.
 */
export function findTypingRanges(
  samples: ActivitySample[],
  minDuration: number,
  opts: { maxPause?: number; maxKeystrokeSize?: number; maxBandHeight?: number } = {},
): TimeRange[] {
  const { maxPause = 1, maxKeystrokeSize = 0.15, maxBandHeight = 0.2 } = opts;
  const ranges: TimeRange[] = [];
  let run: { start: number; end: number; band: Box } | null = null;
  const close = () => {
    if (run && run.end - run.start >= minDuration) ranges.push({ start: run.start, end: run.end });
    run = null;
  };
  samples.forEach((s, i) => {
    if (s.box === null) {
      if (run && s.t - run.end > maxPause) close();
      return;
    }
    if (s.box.w > maxKeystrokeSize || s.box.h > maxKeystrokeSize) return close();
    const band: Box | null = run ? union(run.band, s.box) : null;
    if (run && band && band.h <= maxBandHeight) run = { start: run.start, end: s.t, band };
    else {
      close();
      run = { start: changeStart(samples, i), end: s.t, band: s.box };
    }
  });
  close();
  return ranges;
}

export type ZoomOptions = {
  /** Changes whose box is larger than this (normalized, on either axis) are not localized: no zoom. */
  maxBoxSize?: number;
  /** Minimum number of localized change samples to justify a zoom. */
  minHits?: number;
  minDuration?: number;
  /** Seconds the zoom starts before the first change. */
  lead?: number;
  /** Seconds the zoom holds after the last change. */
  hold?: number;
  /** Minimum gap between consecutive zooms. */
  gap?: number;
  skipStart?: number;
  minScale?: number;
  maxScale?: number;
  /** Fraction of the zoomed viewport the change box should fill. */
  fill?: number;
};

/** Zoom regions centered on localized activity, non-overlapping, in source seconds. */
export function suggestZooms(samples: ActivitySample[], opts: ZoomOptions = {}): ZoomSuggestion[] {
  const {
    maxBoxSize = 0.5,
    minHits = 2,
    minDuration = 1.5,
    lead = 0.4,
    hold = 1,
    gap = 0.5,
    skipStart = 0.5,
    minScale = 1.4,
    maxScale = 2.5,
    fill = 0.5,
  } = opts;
  if (samples.length === 0) return [];
  const duration = samples[samples.length - 1].t;
  const zooms: ZoomSuggestion[] = [];
  let group: { first: number; last: number; box: Box; hits: number } | null = null;

  /** `cut`: time of a large change (scroll, window switch) the zoom must not hold over. */
  const flush = (cut = duration) => {
    if (!group || group.hits < minHits) return void (group = null);
    const prevEnd = zooms.length ? zooms[zooms.length - 1].end + gap : -Infinity;
    const start = Math.max(skipStart, group.first - lead, prevEnd);
    const end = Math.min(cut, Math.max(group.last + hold, start + minDuration));
    const { box } = group;
    group = null;
    if (end - start < minDuration) return;
    const scale = clamp(Math.min(fill / box.w, fill / box.h), minScale, maxScale);
    zooms.push({ start, end, x: box.x + box.w / 2, y: box.y + box.h / 2, scale });
  };

  samples.forEach((s, i) => {
    if (s.box === null) return;
    if (s.box.w > maxBoxSize || s.box.h > maxBoxSize) return flush(changeStart(samples, i));
    const first = changeStart(samples, i);
    if (first < skipStart) return;
    if (group) {
      const merged = union(group.box, s.box);
      const near = first - lead <= group.last + hold + gap;
      if (near && merged.w <= maxBoxSize && merged.h <= maxBoxSize) {
        group = { first: group.first, last: s.t, box: merged, hits: group.hits + 1 };
        return;
      }
      flush();
    }
    group = { first, last: s.t, box: s.box, hits: 1 };
  });
  flush();
  return zooms;
}
