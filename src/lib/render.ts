import { fitFrame } from "./layout";
import { outputToSource } from "./timeline";
import type { CameraLayout, Project, Rect } from "./types";
import { drawWallpaper, WALLPAPERS } from "./wallpapers";
import { zoomViewport } from "./zoom";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type FrameSources = {
  screen: CanvasImageSource;
  screenW: number;
  screenH: number;
  camera: CanvasImageSource | null;
  cameraW: number;
  cameraH: number;
  /** Decoded background image, required when background.kind === "image". */
  bgImage: CanvasImageSource | null;
};

const LAYOUT_TRANSITION = 0.4;
const MASK_FADE = 0.25;
const SIDE_SHARE = 0.36;

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const lerpRect = (a: Rect, b: Rect, p: number): Rect => ({
  x: lerp(a.x, b.x, p),
  y: lerp(a.y, b.y, p),
  w: lerp(a.w, b.w, p),
  h: lerp(a.h, b.h, p),
});

function roundRect(ctx: Ctx2D, r: Rect, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)));
}

// ---------- background ----------

const bgCache = new Map<string, OffscreenCanvas>();

function backgroundCanvas(p: Project, W: number, H: number, bgImage: CanvasImageSource | null): OffscreenCanvas {
  const b = p.background;
  const key = JSON.stringify([b, W, H]);
  const hit = bgCache.get(key);
  if (hit) return hit;
  if (bgCache.size > 8) bgCache.clear();

  const raw = new OffscreenCanvas(W, H);
  const rc = raw.getContext("2d")!;
  if (b.kind === "wallpaper") drawWallpaper(rc, WALLPAPERS[b.wallpaper], W, H);
  if (b.kind === "color") {
    rc.fillStyle = b.color;
    rc.fillRect(0, 0, W, H);
  }
  if (b.kind === "gradient") {
    const a = (b.gradient.angle * Math.PI) / 180;
    const d = (Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a))) / 2;
    const cx = W / 2, cy = H / 2, dx = Math.sin(a) * d, dy = -Math.cos(a) * d;
    const g = rc.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    g.addColorStop(0, b.gradient.from);
    g.addColorStop(1, b.gradient.to);
    rc.fillStyle = g;
    rc.fillRect(0, 0, W, H);
  }
  if (b.kind === "image") {
    if (!bgImage) throw new Error("Background image selected but not loaded");
    const iw = (bgImage as HTMLImageElement).naturalWidth || (bgImage as ImageBitmap).width;
    const ih = (bgImage as HTMLImageElement).naturalHeight || (bgImage as ImageBitmap).height;
    const s = Math.max(W / iw, H / ih);
    rc.drawImage(bgImage, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  }
  if (b.blur <= 0) {
    bgCache.set(key, raw);
    return raw;
  }
  const out = new OffscreenCanvas(W, H);
  const oc = out.getContext("2d")!;
  oc.filter = `blur(${b.blur * Math.min(W, H) * 0.04}px)`;
  // Overdraw so blurred edges do not fade to transparent.
  oc.drawImage(raw, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
  bgCache.set(key, out);
  return out;
}

// ---------- camera layout ----------

/** Progress (0..1) toward each layout at output time t, eased in and out at region edges. */
function layoutAt(p: Project, t: number): { layout: CameraLayout | null; progress: number } {
  const r = p.cameraLayouts.find((l) => t >= l.start && t <= l.end);
  if (!r) return { layout: null, progress: 0 };
  const tr = Math.min(LAYOUT_TRANSITION, (r.end - r.start) / 2);
  return { layout: r.layout, progress: ease(clamp01(Math.min(t - r.start, r.end - t) / tr)) };
}

type CamState = { rect: Rect; radius: number; alpha: number };

function bubbleState(p: Project, W: number, H: number, zoomW: number, camAspect: number): CamState {
  const c = p.camera;
  const m = Math.min(W, H);
  const shrink = c.shrinkOnZoom ? 0.65 + 0.35 * zoomW : 1;
  const h = c.size * m * shrink;
  const w = c.shape === "square" ? h * camAspect : h;
  const cx = Math.min(Math.max(c.x * W, w / 2), W - w / 2);
  const cy = Math.min(Math.max(c.y * H, h / 2), H - h / 2);
  const radius = c.shape === "circle" ? h / 2 : c.shape === "rounded" ? h * 0.22 : h * 0.06;
  return { rect: { x: cx - w / 2, y: cy - h / 2, w, h }, radius, alpha: c.visible ? 1 : 0 };
}

function layoutState(layout: CameraLayout, bubble: CamState, W: number, H: number, pad: number): CamState {
  if (layout === "hidden") {
    const r = bubble.rect;
    return { rect: { x: r.x + r.w * 0.1, y: r.y + r.h * 0.1, w: r.w * 0.8, h: r.h * 0.8 }, radius: bubble.radius, alpha: 0 };
  }
  if (layout === "fullscreen") return { rect: { x: 0, y: 0, w: W, h: H }, radius: 0, alpha: 1 };
  const x = W * (1 - SIDE_SHARE);
  return { rect: { x, y: pad, w: W * SIDE_SHARE - pad, h: H - 2 * pad }, radius: Math.min(W, H) * 0.03, alpha: 1 };
}

function drawCover(ctx: Ctx2D, img: CanvasImageSource, iw: number, ih: number, r: Rect, mirror: boolean) {
  const s = Math.max(r.w / iw, r.h / ih);
  const sw = r.w / s, sh = r.h / s;
  ctx.save();
  if (mirror) {
    ctx.translate(r.x * 2 + r.w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
  ctx.restore();
}

// ---------- masks ----------

let scratch: OffscreenCanvas | null = null;

function drawMasks(ctx: Ctx2D, p: Project, src: FrameSources, frame: Rect, radius: number, t: number) {
  const { crop } = p;
  for (const m of p.masks) {
    if (t < m.start || t > m.end) continue;
    const alpha = clamp01(Math.min(t - m.start, m.end - t) / MASK_FADE);
    const r: Rect = { x: frame.x + m.rect.x * frame.w, y: frame.y + m.rect.y * frame.h, w: m.rect.w * frame.w, h: m.rect.h * frame.h };
    // Source pixels under the mask rect.
    const sx = (crop.x + m.rect.x * crop.w) * src.screenW;
    const sy = (crop.y + m.rect.y * crop.h) * src.screenH;
    const sw = m.rect.w * crop.w * src.screenW;
    const sh = m.rect.h * crop.h * src.screenH;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (m.kind === "highlight") {
      roundRect(ctx, frame, radius);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = `rgba(0,0,0,${0.35 + 0.5 * m.strength})`;
      ctx.fill("evenodd");
    } else if (m.kind === "blur") {
      roundRect(ctx, r, Math.min(r.w, r.h) * 0.08);
      ctx.clip();
      ctx.filter = `blur(${4 + m.strength * 24}px)`;
      ctx.drawImage(src.screen, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    } else {
      const cells = Math.max(2, Math.round(r.w / (6 + m.strength * 40)));
      const rows = Math.max(2, Math.round((cells * r.h) / r.w));
      if (!scratch || scratch.width < cells || scratch.height < rows) scratch = new OffscreenCanvas(Math.max(cells, 64), Math.max(rows, 64));
      const sc = scratch.getContext("2d")!;
      sc.drawImage(src.screen, sx, sy, sw, sh, 0, 0, cells, rows);
      roundRect(ctx, r, Math.min(r.w, r.h) * 0.08);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, cells, rows, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }
}

// ---------- captions ----------

function drawCaption(ctx: Ctx2D, p: Project, W: number, H: number, sourceTime: number) {
  if (!p.captionStyle.enabled) return;
  const c = p.captions.find((x) => sourceTime >= x.start && sourceTime <= x.end);
  if (!c) return;
  const m = Math.min(W, H);
  const size = p.captionStyle.size * m;
  ctx.save();
  ctx.font = `600 ${size}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxW = W * 0.8;
  const lines: string[] = [];
  let line = "";
  for (const word of c.text.trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  const lh = size * 1.3;
  const padX = size * 0.6, padY = size * 0.35;
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const boxH = lines.length * lh + padY * 2;
  const cy = p.captionStyle.y * H;
  ctx.fillStyle = "rgba(10,10,14,0.82)";
  ctx.beginPath();
  ctx.roundRect(W / 2 - boxW / 2, cy - boxH / 2, boxW, boxH, size * 0.4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, cy - boxH / 2 + padY + lh * (i + 0.5)));
  ctx.restore();
}

// ---------- frame geometry ----------

/** Where the screen frame sits at output time t, before zoom. Exported for UI hit-testing. */
export function frameRect(p: Project, W: number, H: number, screenW: number, screenH: number, t: number): Rect {
  const contentAspect = (p.crop.w * screenW) / (p.crop.h * screenH);
  const { layout, progress } = layoutAt(p, t);
  const side = layout === "side" ? progress : 0;
  const availW = W * (1 - SIDE_SHARE * side) + p.padding * Math.min(W, H) * side;
  const r = fitFrame(availW, H, contentAspect, p.padding);
  return r;
}

/** Draw one fully composited output frame at output time t. */
export function renderFrame(ctx: Ctx2D, W: number, H: number, p: Project, src: FrameSources, t: number): void {
  const m = Math.min(W, H);
  const view = zoomViewport(p.zooms, t);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Zoom acts like a camera over background + screen frame.
  ctx.scale(1 / view.w, 1 / view.h);
  ctx.translate(-view.x * W, -view.y * H);
  ctx.drawImage(backgroundCanvas(p, W, H, src.bgImage), 0, 0);

  const frame = frameRect(p, W, H, src.screenW, src.screenH, t);
  const radius = p.radius * Math.min(frame.w, frame.h);
  if (p.shadow > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.25 + 0.45 * p.shadow})`;
    ctx.shadowBlur = p.shadow * m * 0.06;
    ctx.shadowOffsetY = p.shadow * m * 0.015;
    ctx.fillStyle = "#000";
    roundRect(ctx, frame, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRect(ctx, frame, radius);
  ctx.clip();
  const { crop } = p;
  ctx.drawImage(
    src.screen,
    crop.x * src.screenW, crop.y * src.screenH, crop.w * src.screenW, crop.h * src.screenH,
    frame.x, frame.y, frame.w, frame.h,
  );
  drawMasks(ctx, p, src, frame, radius, t);
  ctx.restore();
  if (p.inset > 0) {
    ctx.save();
    ctx.lineWidth = (p.inset * W) / 1920;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    const i = ctx.lineWidth / 2;
    roundRect(ctx, { x: frame.x + i, y: frame.y + i, w: frame.w - 2 * i, h: frame.h - 2 * i }, radius - i);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  if (src.camera) {
    const camAspect = src.cameraW / src.cameraH;
    const bubble = bubbleState(p, W, H, view.w, camAspect);
    const { layout, progress } = layoutAt(p, t);
    const target = layout ? layoutState(layout, bubble, W, H, p.padding * m) : bubble;
    const s: CamState = {
      rect: lerpRect(bubble.rect, target.rect, progress),
      radius: lerp(bubble.radius, target.radius, progress),
      alpha: lerp(bubble.alpha, target.alpha, progress),
    };
    if (s.alpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = s.alpha;
      if (p.camera.shadow > 0) {
        ctx.save();
        ctx.shadowColor = `rgba(0,0,0,${0.3 + 0.4 * p.camera.shadow})`;
        ctx.shadowBlur = p.camera.shadow * m * 0.04;
        ctx.shadowOffsetY = p.camera.shadow * m * 0.01;
        ctx.fillStyle = "#000";
        roundRect(ctx, s.rect, s.radius);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      roundRect(ctx, s.rect, s.radius);
      ctx.clip();
      drawCover(ctx, src.camera, src.cameraW, src.cameraH, s.rect, p.camera.mirror);
      ctx.restore();
      if (p.camera.border > 0) {
        ctx.lineWidth = (p.camera.border * W) / 1920;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        roundRect(ctx, s.rect, s.radius);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawCaption(ctx, p, W, H, outputToSource(p.segments, t).source);
}

/** Map a point on the output canvas (normalized) to a point on the screen frame (normalized), or null if outside. */
export function canvasToFrame(p: Project, W: number, H: number, screenW: number, screenH: number, t: number, nx: number, ny: number) {
  const f = frameRect(p, W, H, screenW, screenH, t);
  const fx = (nx * W - f.x) / f.w;
  const fy = (ny * H - f.y) / f.h;
  return { x: fx, y: fy, inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
}
