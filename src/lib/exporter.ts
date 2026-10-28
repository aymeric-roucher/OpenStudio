import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type Quality,
  type VideoCodec,
  type VideoSample,
} from "mediabunny";
// @ts-expect-error gifenc ships no type declarations
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { outputSize } from "./layout";
import { renderFrame } from "./render";
import { outputDuration, outputToSource, segmentOffsets } from "./timeline";
import type { Project, Recording } from "./types";

export type ExportFormat = "mp4" | "webm" | "gif";
export type ExportSettings = {
  format: ExportFormat;
  /** Long side of the output, in pixels. */
  long: number;
  fps: number;
  quality: "low" | "medium" | "high";
};

type GifEncoder = {
  writeFrame(index: Uint8Array, w: number, h: number, opts: { palette: number[][]; delay: number }): void;
  finish(): void;
  bytes(): Uint8Array<ArrayBuffer>;
};
const gifenc = { GIFEncoder, applyPalette, quantize } as {
  GIFEncoder: () => GifEncoder;
  quantize: (rgba: Uint8ClampedArray, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8ClampedArray, palette: number[][]) => Uint8Array;
};

const GIF_MAX_FPS = 15;
const GIF_MAX_LONG = 960;
const SAMPLE_RATE = 48000;
const MUSIC_FADE = 1;

const QUALITY: Record<ExportSettings["quality"], Quality> = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH };
const VIDEO_CODECS: Record<"mp4" | "webm", VideoCodec[]> = { mp4: ["avc", "hevc", "av1", "vp9"], webm: ["vp9", "vp8", "av1"] };
const AUDIO_CODECS: Record<"mp4" | "webm", AudioCodec[]> = { mp4: ["aac", "opus"], webm: ["opus"] };

/** Output canvas size, frame rate and frame count for an export, with GIF caps applied. */
export function exportPlan(rec: Pick<Recording, "width" | "height">, project: Pick<Project, "aspect" | "crop" | "segments">, settings: ExportSettings) {
  const gif = settings.format === "gif";
  const fps = gif ? Math.min(settings.fps, GIF_MAX_FPS) : settings.fps;
  const long = gif ? Math.min(settings.long, GIF_MAX_LONG) : settings.long;
  const contentAspect = (project.crop.w * rec.width) / (project.crop.h * rec.height);
  const [width, height] = outputSize(project.aspect, long, contentAspect);
  const frames = Math.max(1, Math.round(outputDuration(project.segments) * fps));
  return { width, height, fps, frames };
}

/** GIF delay of frame i in ms, on the 10 ms grid, so the cumulative duration never drifts from i / fps. */
export function gifDelay(i: number, fps: number): number {
  return (Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)) * 10;
}

const aborted = () => new DOMException("Export aborted", "AbortError");

/** Decoded frames, one per output frame, at the source time each output frame maps to. */
async function* framesFor(input: Input, project: Project, fps: number, frames: number): AsyncGenerator<VideoSample> {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("Recording has no video track");
  if (!(await track.canDecode())) throw new Error(`Cannot decode ${track.codec} video in this browser`);
  // MediaRecorder files can start slightly after 0: clamp so the first frames are not before the first sample.
  const first = await track.getFirstTimestamp();
  function* times() {
    for (let i = 0; i < frames; i++) yield Math.max(first, outputToSource(project.segments, i / fps).source);
  }
  for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(times())) {
    if (!sample) throw new Error("Missing video frame");
    yield sample;
  }
}

/** The whole audio track as one AudioBuffer whose sample 0 is source time 0, or null if there is no audio. */
async function sourceAudio(input: Input): Promise<AudioBuffer | null> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  if (!(await track.canDecode())) throw new Error(`Cannot decode ${track.codec} audio in this browser`);
  const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
  for await (const c of new AudioBufferSink(track).buffers()) chunks.push(c);
  if (chunks.length === 0) return null;
  const sr = track.sampleRate;
  const last = chunks[chunks.length - 1];
  const length = Math.ceil((last.timestamp + last.buffer.duration) * sr);
  const out = new AudioBuffer({ length, numberOfChannels: track.numberOfChannels, sampleRate: sr });
  for (const { buffer, timestamp } of chunks) {
    const at = Math.round(timestamp * sr);
    for (let ch = 0; ch < out.numberOfChannels; ch++) {
      const data = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
      out.copyToChannel(at < 0 ? data.subarray(-at) : data, ch, Math.max(at, 0));
    }
  }
  return out;
}

/** Mix the edited recording audio and the music into the output soundtrack, or null if there is nothing to hear. */
async function renderAudio(screenAudio: AudioBuffer | null, project: Project): Promise<AudioBuffer | null> {
  if (!screenAudio && !project.music) return null;
  const duration = outputDuration(project.segments);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(duration * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  if (screenAudio) {
    const gain = new GainNode(ctx, { gain: project.muted ? 0 : project.volume });
    gain.connect(ctx.destination);
    const offsets = segmentOffsets(project.segments);
    project.segments.forEach((s, i) => {
      const src = new AudioBufferSourceNode(ctx, { buffer: screenAudio, playbackRate: s.speed });
      src.connect(gain);
      src.start(offsets[i], s.start, s.end - s.start);
    });
  }
  if (project.music) {
    const res = await fetch(project.music.url);
    if (!res.ok) throw new Error(`Cannot load music ${project.music.name}: HTTP ${res.status}`);
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    const v = project.music.volume;
    const gain = new GainNode(ctx, { gain: v });
    if (project.music.fade) {
      const fade = Math.min(MUSIC_FADE, duration / 2);
      gain.gain.setValueAtTime(0, 0);
      gain.gain.linearRampToValueAtTime(v, fade);
      gain.gain.setValueAtTime(v, duration - fade);
      gain.gain.linearRampToValueAtTime(0, duration);
    }
    gain.connect(ctx.destination);
    const src = new AudioBufferSourceNode(ctx, { buffer, loop: true });
    src.connect(gain);
    src.start(0);
  }
  return ctx.startRendering();
}

export async function exportVideo(
  rec: Recording,
  project: Project,
  bgImage: CanvasImageSource | null,
  settings: ExportSettings,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const { width, height, fps, frames } = exportPlan(rec, project, settings);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: settings.format === "gif" });
  if (!ctx) throw new Error("Cannot create a 2D canvas context");

  const screenInput = new Input({ source: new BlobSource(rec.screen), formats: ALL_FORMATS });
  const cameraInput = rec.camera ? new Input({ source: new BlobSource(rec.camera), formats: ALL_FORMATS }) : null;
  const screenFrames = framesFor(screenInput, project, fps, frames);
  const cameraFrames = cameraInput ? framesFor(cameraInput, project, fps, frames) : null;
  const dispose = async () => {
    await screenFrames.return(undefined);
    await cameraFrames?.return(undefined);
    screenInput.dispose();
    cameraInput?.dispose();
  };

  /** Render each output frame and hand it to `emit`. Returns false if aborted. */
  const renderAll = async (emit: (i: number) => Promise<void>): Promise<boolean> => {
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) return false;
      const screen = (await screenFrames.next()).value;
      const camera = cameraFrames ? (await cameraFrames.next()).value : null;
      if (!screen || (cameraFrames && !camera)) throw new Error(`Ran out of source frames at output frame ${i}`);
      renderFrame(ctx, width, height, project, {
        screen: screen.toCanvasImageSource(),
        screenW: screen.displayWidth,
        screenH: screen.displayHeight,
        camera: camera ? camera.toCanvasImageSource() : null,
        cameraW: camera ? camera.displayWidth : 0,
        cameraH: camera ? camera.displayHeight : 0,
        bgImage,
      }, i / fps);
      screen.close();
      camera?.close();
      await emit(i);
      onProgress((i + 1) / frames);
    }
    return true;
  };

  if (settings.format === "gif") {
    const gif = gifenc.GIFEncoder();
    const done = await renderAll(async (i) => {
      const { data } = ctx.getImageData(0, 0, width, height);
      const palette = gifenc.quantize(data, 256);
      gif.writeFrame(gifenc.applyPalette(data, palette), width, height, { palette, delay: gifDelay(i, fps) });
    });
    await dispose();
    if (!done) throw aborted();
    gif.finish();
    return new Blob([gif.bytes()], { type: "image/gif" });
  }

  const format = settings.format === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
  const quality = QUALITY[settings.quality];
  const videoCodec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs().filter((c) => VIDEO_CODECS[settings.format as "mp4" | "webm"].includes(c)),
    { width, height, quality, frameRate: fps },
  );
  if (!videoCodec) throw new Error(`This browser cannot encode ${settings.format.toUpperCase()} video at ${width}x${height}`);

  const audio = await renderAudio(await sourceAudio(screenInput), project);
  if (signal.aborted) {
    await dispose();
    throw aborted();
  }

  const target = new BufferTarget();
  const output = new Output({ format, target });
  const video = new CanvasSource(canvas, { codec: videoCodec, quality });
  output.addVideoTrack(video, { frameRate: fps });
  let audioSource: AudioBufferSource | null = null;
  if (audio) {
    const audioCodec = await getFirstEncodableAudioCodec(
      format.getSupportedAudioCodecs().filter((c) => AUDIO_CODECS[settings.format as "mp4" | "webm"].includes(c)),
      { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate, quality },
    );
    if (!audioCodec) throw new Error(`This browser cannot encode ${settings.format.toUpperCase()} audio`);
    audioSource = new AudioBufferSource({ codec: audioCodec, quality });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  if (audio && audioSource) {
    await audioSource.add(audio);
    audioSource.close();
  }

  const done = await renderAll((i) => video.add(i / fps, 1 / fps));
  await dispose();
  if (!done) {
    await output.cancel();
    throw aborted();
  }
  await output.finalize();
  const mime = settings.format === "mp4" ? "video/mp4" : "video/webm";
  return new Blob([target.buffer!], { type: mime });
}
