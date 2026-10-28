import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat } from "mediabunny";
import type { Recording } from "./types";

/**
 * MediaRecorder WebM files have no duration nor seek index. Remuxing (no re-encode) fixes both,
 * which makes scrubbing in the editor fast and reliable.
 */
async function remuxWebm(blob: Blob): Promise<Blob> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const conversion = await Conversion.init({ input, output });
  if (!conversion.isValid) throw new Error(`Cannot remux recording: ${JSON.stringify(conversion.discardedTracks.map((t) => t.reason))}`);
  await conversion.execute();
  return new Blob([target.buffer!], { type: "video/webm" });
}

async function probe(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("This file has no video track");
  const audio = await input.getPrimaryAudioTrack();
  return { duration: await input.computeDuration(), width: video.displayWidth, height: video.displayHeight, hasAudio: audio !== null };
}

/** Build a Recording from raw blobs. `remux` should be true for MediaRecorder output. */
export async function loadRecording(screen: Blob, camera: Blob | null, flags: number[], remux: boolean): Promise<Recording> {
  const s = remux ? await remuxWebm(screen) : screen;
  const c = camera && remux ? await remuxWebm(camera) : camera;
  const info = await probe(s);
  return {
    screen: s,
    screenUrl: URL.createObjectURL(s),
    camera: c,
    cameraUrl: c ? URL.createObjectURL(c) : null,
    ...info,
    flags,
  };
}

/** Peak amplitude per bucket, for the timeline waveform. */
export async function audioPeaks(blob: Blob, bucketsPerSecond: number): Promise<{ peaks: Float32Array; rate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 8000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(buf.sampleRate / bucketsPerSecond));
  const peaks = new Float32Array(Math.ceil(data.length / step));
  let max = 0;
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    for (let j = i * step, e = Math.min(j + step, data.length); j < e; j++) m = Math.max(m, Math.abs(data[j]));
    peaks[i] = m;
    max = Math.max(max, m);
  }
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  return { peaks, rate: buf.sampleRate / step };
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
