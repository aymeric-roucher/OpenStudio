/** Procedural wallpapers: a base gradient plus soft color blobs. No image assets needed. */
export type Wallpaper = { name: string; group: string; base: [string, string]; blobs: [string, number, number, number][] };

// blob: [color, x, y, radius] normalized
export const WALLPAPERS: Wallpaper[] = [
  { name: "Midnight", group: "Abstract", base: ["#0f1024", "#2a2350"], blobs: [["#6c5ce7", 0.2, 0.3, 0.6], ["#00b4d8", 0.85, 0.8, 0.5]] },
  { name: "Sunset", group: "Abstract", base: ["#ff7e5f", "#feb47b"], blobs: [["#ff3d7f", 0.15, 0.85, 0.6], ["#ffd56b", 0.85, 0.15, 0.5]] },
  { name: "Ocean", group: "Abstract", base: ["#0a2a6b", "#1e66d0"], blobs: [["#3ad1ff", 0.8, 0.3, 0.55], ["#0b1a4a", 0.2, 0.9, 0.6]] },
  { name: "Aurora", group: "Abstract", base: ["#0b3d2e", "#0e1a2b"], blobs: [["#38ef7d", 0.3, 0.2, 0.55], ["#7f5af0", 0.8, 0.7, 0.6]] },
  { name: "Peach", group: "Abstract", base: ["#ffd3a5", "#fd6585"], blobs: [["#ffecd2", 0.2, 0.2, 0.5], ["#c471f5", 0.9, 0.9, 0.55]] },
  { name: "Radiant", group: "Abstract", base: ["#3a1c71", "#d76d77"], blobs: [["#ffaf7b", 0.85, 0.85, 0.6], ["#4e54c8", 0.1, 0.1, 0.5]] },
  { name: "Mint", group: "Abstract", base: ["#d4fc79", "#96e6a1"], blobs: [["#43e97b", 0.2, 0.8, 0.55], ["#38f9d7", 0.85, 0.2, 0.5]] },
  { name: "Lava", group: "Abstract", base: ["#200122", "#6f0000"], blobs: [["#ff512f", 0.75, 0.75, 0.6], ["#dd2476", 0.2, 0.3, 0.5]] },
  { name: "Sky", group: "Abstract", base: ["#a1c4fd", "#c2e9fb"], blobs: [["#ffffff", 0.2, 0.2, 0.45], ["#6a85b6", 0.85, 0.9, 0.55]] },
  { name: "Grape", group: "Abstract", base: ["#41295a", "#2f0743"], blobs: [["#c86dd7", 0.3, 0.7, 0.55], ["#3023ae", 0.8, 0.2, 0.55]] },
  { name: "Sand", group: "Abstract", base: ["#e6dada", "#c9b79c"], blobs: [["#f7e8d0", 0.25, 0.25, 0.5], ["#a68b6d", 0.85, 0.85, 0.5]] },
  { name: "Graphite", group: "Abstract", base: ["#232526", "#414345"], blobs: [["#5d6d7e", 0.8, 0.2, 0.5], ["#111111", 0.2, 0.9, 0.55]] },
  { name: "Rose", group: "Abstract", base: ["#f857a6", "#ff5858"], blobs: [["#ffb199", 0.2, 0.2, 0.5], ["#8e2de2", 0.9, 0.85, 0.55]] },
  { name: "Lagoon", group: "Abstract", base: ["#134e5e", "#71b280"], blobs: [["#00d2ff", 0.85, 0.25, 0.5], ["#0b2f3a", 0.15, 0.85, 0.5]] },
  { name: "Citrus", group: "Abstract", base: ["#f7971e", "#ffd200"], blobs: [["#ff6a00", 0.15, 0.8, 0.55], ["#fff6b7", 0.85, 0.15, 0.45]] },
  { name: "Nebula", group: "Abstract", base: ["#000428", "#004e92"], blobs: [["#ff00cc", 0.8, 0.25, 0.45], ["#333399", 0.2, 0.75, 0.55]] },
];

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawWallpaper(ctx: Ctx, w: Wallpaper, W: number, H: number): void {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, w.base[0]);
  g.addColorStop(1, w.base[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const D = Math.max(W, H);
  for (const [color, x, y, r] of w.blobs) {
    const rg = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * D);
    rg.addColorStop(0, color);
    rg.addColorStop(1, color + "00");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }
}

/** CSS approximation used for swatches. */
export function wallpaperCss(w: Wallpaper): string {
  const blobs = w.blobs.map(([c, x, y]) => `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${c} 0%, ${c}00 60%)`);
  return [...blobs, `linear-gradient(135deg, ${w.base[0]}, ${w.base[1]})`].join(", ");
}
