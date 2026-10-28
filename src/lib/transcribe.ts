import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { uid } from "./defaults";
import type { Caption } from "./types";

export type WhisperModel = "tiny" | "base" | "small";
export type TranscribeProgress = { stage: "decoding" | "loading-model" | "transcribing"; progress: number };
export type Word = { text: string; start: number; end: number };

/** Messages exchanged with `transcribe.worker.ts`. */
export type WorkerRequest = { id: number; audio: Float32Array; model: WhisperModel; language: string | null };
export type WorkerResponse =
  | { id: number; type: "progress"; progress: TranscribeProgress }
  | { id: number; type: "done"; words: Word[] }
  | { id: number; type: "error"; message: string };

const SAMPLE_RATE = 16000;
const SENTENCE_END = /[.!?…。！？]["')\]»”]*$/;

/** Group word timestamps into short captions: at most `maxWords` words, split on pauses longer than `maxGap` seconds and after sentence punctuation. */
export function groupWords(words: Word[], maxWords: number, maxGap: number): Caption[] {
  const captions: Caption[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length === 0) return;
    captions.push({ id: uid(), start: current[0].start, end: current[current.length - 1].end, text: current.map((w) => w.text).join("").trim() });
    current = [];
  };
  for (const word of words) {
    const last = current[current.length - 1];
    if (last && (current.length >= maxWords || word.start - last.end > maxGap)) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text.trim())) flush();
  }
  flush();
  return captions;
}

/** Decode the audio track of a recording to 16 kHz mono samples. */
async function decodeAudio(media: Blob): Promise<Float32Array> {
  const track = await new Input({ source: new BlobSource(media), formats: ALL_FORMATS }).getPrimaryAudioTrack();
  if (!track) throw new Error("This recording has no audio track, so there is nothing to transcribe.");
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await media.arrayBuffer());
  await ctx.close();
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

let worker: Worker | null = null;
let nextId = 0;

/** Transcribe a recording locally with Whisper. `language` is a Whisper language code or name, or null to auto-detect. */
export async function transcribe(
  media: Blob,
  opts: { model: WhisperModel; language: string | null },
  onProgress: (p: TranscribeProgress) => void,
): Promise<Caption[]> {
  onProgress({ stage: "decoding", progress: 0 });
  const audio = await decodeAudio(media);
  onProgress({ stage: "decoding", progress: 1 });

  worker ??= new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  const id = nextId++;
  const words = await new Promise<Word[]>((resolve, reject) => {
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") return onProgress(msg.progress);
      cleanup();
      if (msg.type === "done") resolve(msg.words);
      else reject(new Error(msg.message));
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      // A crashed worker is unusable: drop it so the next call starts a fresh one.
      w.terminate();
      if (worker === w) worker = null;
      reject(new Error(`Transcription worker failed: ${e.message}`));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    const request: WorkerRequest = { id, audio, model: opts.model, language: opts.language };
    w.postMessage(request, [audio.buffer]);
  });
  return groupWords(words, 7, 0.6);
}
