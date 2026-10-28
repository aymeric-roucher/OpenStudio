import type { Rect, ZoomRegion, ZoomSpeed } from "./types";

/** Zoom in/out animation duration in seconds. */
export const ZOOM_TRANSITION: Record<ZoomSpeed, number> = { slow: 1, mellow: 0.65, quick: 0.4, rapid: 0.22 };

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Visible part of the composition at output time `t`, normalized. Zoom times must be in output seconds here.
 * `base` is the view outside of zooms (the full canvas, or a permanent zoom such as "keep zoomed in").
 */
export function zoomViewport(zooms: ZoomRegion[], t: number, transition: number, base: Rect = FULL): Rect {
  const z = zooms.find((r) => t >= r.start && t <= r.end);
  if (!z) return base;
  const tr = Math.min(transition, (z.end - z.start) / 2);
  const p = z.instant ? 1 : easeInOut(clamp(Math.min(t - z.start, z.end - t) / tr, 0, 1));
  const from = 1 / base.w;
  const to = from * z.scale;
  const w = 1 / (from + (to - from) * p);
  const bx = base.x + base.w / 2, by = base.y + base.h / 2;
  const cx = clamp(bx + (z.x - bx) * p, w / 2, 1 - w / 2);
  const cy = clamp(by + (z.y - by) * p, w / 2, 1 - w / 2);
  return { x: cx - w / 2, y: cy - w / 2, w, h: w };
}
