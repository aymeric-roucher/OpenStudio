/** WSOLA frame length and alignment search tolerance, in seconds. */
const FRAME = 0.04;
const TOLERANCE = 0.012;
/** Coarse search step (in offsets and in correlated samples) before a fine refinement around the best offset. */
const COARSE = 4;

function dot(x: Float32Array, a: number, b: number, len: number, step: number): number {
  let s = 0;
  for (let i = 0; i < len; i += step) s += x[a + i] * x[b + i];
  return s;
}

/** Offset in [-tol, tol] around `nominal` whose first `len` samples best match the ones at `target`. */
function bestOffset(x: Float32Array, target: number, nominal: number, tol: number, len: number): number {
  let best = 0;
  let bestScore = -Infinity;
  const scan = (from: number, to: number, step: number, sampleStep: number) => {
    for (let d = from; d <= to; d += step) {
      const score = dot(x, nominal + d, target, len, sampleStep);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
  };
  scan(-tol, tol, COARSE, COARSE);
  const coarse = best;
  bestScore = -Infinity;
  scan(Math.max(-tol, coarse - COARSE + 1), Math.min(tol, coarse + COARSE - 1), 1, 1);
  return best;
}

/**
 * Pitch-preserving time stretch (WSOLA). Plays `channels` `rate` times faster: the output has
 * round(length / rate) samples per channel. All channels share the same alignment, searched on their mix.
 */
export function timeStretch(channels: Float32Array[], rate: number, sampleRate: number): Float32Array<ArrayBuffer>[] {
  if (channels.length === 0) throw new Error("timeStretch needs at least one channel");
  if (!(rate > 0)) throw new Error(`Invalid time stretch rate ${rate}`);
  const len = channels[0].length;
  const n = 2 * Math.round((FRAME * sampleRate) / 2);
  const hop = n / 2;
  const tol = Math.round(TOLERANCE * sampleRate);
  const outLen = Math.round(len / rate);

  // Zero padding on both sides so frames and the search never read out of bounds.
  const pad = n + tol;
  const padded = channels.map((c) => {
    const p = new Float32Array(len + 2 * pad + Math.ceil(rate * hop));
    p.set(c, pad);
    return p;
  });
  const mix = new Float32Array(padded[0].length);
  for (const p of padded) for (let i = 0; i < mix.length; i++) mix[i] += p[i];

  // Periodic Hann: overlapping by half, the windows sum to exactly 1.
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);

  // Frame k is centered on output sample k * hop and on input sample k * hop * rate.
  const frames = Math.ceil(outLen / hop) + 1;
  const out = channels.map(() => new Float32Array(frames * hop + n));
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const nominal = pad - hop + Math.round(k * hop * rate);
    // Pick the frame that best continues the previous one (its natural continuation starts at prev + hop).
    const pos = k === 0 ? nominal : nominal + bestOffset(mix, prev + hop, nominal, tol, hop);
    for (let ch = 0; ch < out.length; ch++) {
      const src = padded[ch], dst = out[ch], at = k * hop;
      for (let i = 0; i < n; i++) dst[at + i] += src[pos + i] * win[i];
    }
    prev = pos;
  }
  return out.map((c) => c.slice(hop, hop + outLen));
}
