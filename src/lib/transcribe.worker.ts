import { Tensor, WhisperTextStreamer, pipeline, type WhisperTokenizer, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { TranscribeProgress, WhisperModel, WorkerRequest, WorkerResponse } from "./transcribe";

/** Must match the rate `transcribe.ts` resamples to (Whisper expects 16 kHz). */
const SAMPLE_RATE = 16000;
const CHUNK_S = 30;
const STRIDE_S = 5;

type Device = "webgpu" | "wasm";
// WebGPU: fp32 encoder and 4-bit decoder (the setup used by whisper-web). Wasm: 8-bit for both.
const DTYPES = {
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
} as const;

let devicePromise: Promise<Device> | null = null;
const pipelines = new Map<WhisperModel, Promise<AutomaticSpeechRecognitionPipeline>>();

async function pickDevice(): Promise<Device> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<object | null> } }).gpu;
  return gpu && (await gpu.requestAdapter()) ? "webgpu" : "wasm";
}

async function loadPipeline(model: WhisperModel, report: (p: TranscribeProgress) => void) {
  const device = await (devicePromise ??= pickDevice());
  // The "_timestamped" exports also output cross attentions, which word-level timestamps require.
  return pipeline("automatic-speech-recognition", `onnx-community/whisper-${model}_timestamped`, {
    device,
    dtype: DTYPES[device],
    progress_callback: (info) => {
      if (info.status === "progress_total") report({ stage: "loading-model", progress: info.progress / 100 });
    },
  });
}

/** Whisper's language identification: the most likely language token right after <|startoftranscript|>, on the first 30 s. */
async function detectLanguage(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array): Promise<string> {
  const { input_features } = await asr.processor(audio.subarray(0, CHUNK_S * SAMPLE_RATE));
  const config = asr.model.generation_config as unknown as { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  const decoder_input_ids = new Tensor("int64", [BigInt(config.decoder_start_token_id)], [1, 1]);
  const { logits } = await asr.model({ input_features, decoder_input_ids });
  const scores = logits.data as Float32Array;
  const [token] = Object.entries(config.lang_to_id).reduce((best, entry) => (scores[entry[1]] > scores[best[1]] ? entry : best));
  return token.slice(2, -2);
}

async function run({ id, audio, model, language }: WorkerRequest): Promise<WorkerResponse> {
  const report = (progress: TranscribeProgress) => self.postMessage({ id, type: "progress", progress } satisfies WorkerResponse);
  report({ stage: "loading-model", progress: 0 });
  let asr = pipelines.get(model);
  if (!asr) {
    asr = loadPipeline(model, report);
    pipelines.set(model, asr);
    asr.catch(() => pipelines.delete(model));
  }
  const loaded = await asr;
  report({ stage: "loading-model", progress: 1 });

  report({ stage: "transcribing", progress: 0 });
  const lang = language ?? (await detectLanguage(loaded, audio));
  // Same windowing as the pipeline's `chunk_length_s` loop, to turn finished passes into a fraction.
  const window = CHUNK_S * SAMPLE_RATE;
  const passes = audio.length <= window ? 1 : Math.ceil((audio.length - window) / ((CHUNK_S - 2 * STRIDE_S) * SAMPLE_RATE)) + 1;
  let done = 0;
  const streamer = new WhisperTextStreamer(loaded.tokenizer as WhisperTokenizer, {
    callback_function: () => {}, // Only the pass count is needed, not the streamed text.
    on_finalize: () => report({ stage: "transcribing", progress: Math.min(++done / passes, 1) }),
  });
  const output = await loaded(audio, {
    language: lang,
    task: "transcribe",
    return_timestamps: "word",
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    streamer,
  });
  // Whisper's alignment can place the last word's end past the audio: clamp to the real duration.
  const duration = audio.length / SAMPLE_RATE;
  const words = (output.chunks ?? []).map((c) => ({ text: c.text, start: Math.min(c.timestamp[0], duration), end: Math.min(c.timestamp[1], duration) }));
  return { id, type: "done", words };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  run(e.data).then(
    (response) => self.postMessage(response),
    (err: unknown) => self.postMessage({ id: e.data.id, type: "error", message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse),
  );
};
