import type { PresetAspect, Rect, Style } from "./types";

export const ASPECTS: Record<PresetAspect, { label: string; ratio: number; hint: string }> = {
  wide: { label: "Wide", ratio: 16 / 9, hint: "16:9" },
  vertical: { label: "Vertical", ratio: 9 / 16, hint: "9:16" },
  square: { label: "Square", ratio: 1, hint: "1:1" },
  classic: { label: "Classic", ratio: 4 / 3, hint: "4:3" },
  tall: { label: "Tall", ratio: 3 / 4, hint: "3:4" },
};

const even = (v: number) => Math.round(v / 2) * 2;

/** Output canvas size whose long side is `long` pixels. */
export function outputSize(style: Pick<Style, "aspect" | "customSize">, long: number, contentAspect: number): [number, number] {
  const { aspect, customSize } = style;
  const ratio = aspect === "auto" ? contentAspect : aspect === "custom" ? customSize.w / customSize.h : ASPECTS[aspect].ratio;
  return ratio >= 1 ? [even(long), even(long / ratio)] : [even(long * ratio), even(long)];
}

/** Rectangle of the screen frame inside a W x H canvas, centered, after padding. */
export function fitFrame(W: number, H: number, contentAspect: number, padding: number): Rect {
  const pad = padding * Math.min(W, H);
  const aw = W - 2 * pad;
  const ah = H - 2 * pad;
  const w = Math.min(aw, ah * contentAspect);
  const h = w / contentAspect;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
