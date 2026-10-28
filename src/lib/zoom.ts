import type { Rect, ZoomRegion } from "./types";

export const ZOOM_TRANSITION = 0.6;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Visible part of the composition at output time `t`, normalized. */
export function zoomViewport(zooms: ZoomRegion[], t: number): Rect {
  const z = zooms.find((r) => t >= r.start && t <= r.end);
  if (!z) return { x: 0, y: 0, w: 1, h: 1 };
  const tr = Math.min(ZOOM_TRANSITION, (z.end - z.start) / 2);
  const p = z.instant ? 1 : easeInOut(clamp(Math.min(t - z.start, z.end - t) / tr, 0, 1));
  const w = 1 / (1 + (z.scale - 1) * p);
  const cx = clamp(0.5 + (z.x - 0.5) * p, w / 2, 1 - w / 2);
  const cy = clamp(0.5 + (z.y - 0.5) * p, w / 2, 1 - w / 2);
  return { x: cx - w / 2, y: cy - w / 2, w, h: w };
}
