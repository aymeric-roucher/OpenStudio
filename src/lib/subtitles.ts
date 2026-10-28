import { sourceRangeToOutput } from "./timeline";
import type { Caption, Segment } from "./types";

function stamp(t: number, sep: "," | "."): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** Subtitle file for the edited video: captions are placed on the output timeline, cut ones are dropped. */
export function toSubtitles(captions: Caption[], segments: Segment[], format: "srt" | "vtt"): string {
  const sep = format === "srt" ? "," : ".";
  const cues = captions.flatMap((c) => {
    const r = sourceRangeToOutput(segments, c.start, c.end);
    return r ? [`${stamp(r[0], sep)} --> ${stamp(r[1], sep)}\n${c.text.trim()}\n`] : [];
  });
  if (format === "vtt") return `WEBVTT\n\n${cues.join("\n")}`;
  return cues.map((c, i) => `${i + 1}\n${c}`).join("\n");
}
