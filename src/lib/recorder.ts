export type SurfaceKind = "monitor" | "window" | "browser";

export type CaptureConfig = {
  surface: SurfaceKind;
  cameraId: string | null;
  micId: string | null;
  systemAudio: boolean;
};

export type Captured = { display: MediaStream; camera: MediaStream | null; mic: MediaStream | null };

const pickMime = (candidates: string[]) => {
  const m = candidates.find((c) => MediaRecorder.isTypeSupported(c));
  if (!m) throw new Error("This browser cannot record WebM video. Use a recent Chrome, Edge, Arc, Brave or Firefox.");
  return m;
};

/** Ask the user what to share. Must be called from a user gesture. */
export async function captureDisplay(cfg: CaptureConfig): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: cfg.surface, frameRate: { ideal: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: cfg.systemAudio ? { suppressLocalAudioPlayback: false } : false,
    // Chrome hints: offer the chosen surface first and allow sharing this tab too.
    selfBrowserSurface: "include",
    surfaceSwitching: "include",
    systemAudio: cfg.systemAudio ? "include" : "exclude",
    monitorTypeSurfaces: "include",
  } as DisplayMediaStreamOptions);
}

export function cameraStream(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
}

export function micStream(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/**
 * Records the screen (with mixed mic + system audio) and the camera as two separate files,
 * so the camera can be repositioned freely in the editor.
 */
export class SessionRecorder {
  private screenRec: MediaRecorder;
  private cameraRec: MediaRecorder | null;
  private chunks: { screen: Blob[]; camera: Blob[] } = { screen: [], camera: [] };
  private audioCtx: AudioContext | null = null;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  flags: number[] = [];

  constructor(private cap: Captured) {
    const tracks: MediaStreamTrack[] = [...cap.display.getVideoTracks()];
    const audioSources = [cap.mic, cap.display].filter((s): s is MediaStream => !!s && s.getAudioTracks().length > 0);
    if (audioSources.length === 1) tracks.push(audioSources[0].getAudioTracks()[0]);
    if (audioSources.length > 1) {
      this.audioCtx = new AudioContext();
      const dest = this.audioCtx.createMediaStreamDestination();
      for (const s of audioSources) this.audioCtx.createMediaStreamSource(s).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    this.screenRec = new MediaRecorder(new MediaStream(tracks), {
      mimeType: pickMime(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]),
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 160_000,
    });
    this.screenRec.ondataavailable = (e) => this.chunks.screen.push(e.data);
    this.cameraRec = cap.camera
      ? new MediaRecorder(cap.camera, { mimeType: pickMime(["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]), videoBitsPerSecond: 4_000_000 })
      : null;
    if (this.cameraRec) this.cameraRec.ondataavailable = (e) => this.chunks.camera.push(e.data);
  }

  start() {
    this.screenRec.start(1000);
    this.cameraRec?.start(1000);
    this.startedAt = performance.now();
  }

  get paused() {
    return this.screenRec.state === "paused";
  }

  /** Recorded seconds, excluding pauses. */
  elapsed(): number {
    const now = this.paused ? this.pausedAt : performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  pause() {
    this.screenRec.pause();
    this.cameraRec?.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    this.pausedTotal += performance.now() - this.pausedAt;
    this.screenRec.resume();
    this.cameraRec?.resume();
  }

  flag() {
    this.flags.push(this.elapsed());
  }

  async stop(): Promise<{ screen: Blob; camera: Blob | null; flags: number[] }> {
    const done = (r: MediaRecorder) => new Promise<void>((res) => r.addEventListener("stop", () => res(), { once: true }));
    const waits = [done(this.screenRec), ...(this.cameraRec ? [done(this.cameraRec)] : [])];
    this.screenRec.stop();
    this.cameraRec?.stop();
    await Promise.all(waits);
    this.release();
    return {
      screen: new Blob(this.chunks.screen, { type: "video/webm" }),
      camera: this.cameraRec ? new Blob(this.chunks.camera, { type: "video/webm" }) : null,
      flags: this.flags,
    };
  }

  /** Stop recording and drop the data, keeping the input streams alive (for restart). */
  discard() {
    for (const r of [this.screenRec, this.cameraRec]) if (r && r.state !== "inactive") r.stop();
    this.audioCtx?.close();
    this.audioCtx = null;
  }

  /** Stop the captured input streams. */
  release() {
    releaseCapture(this.cap);
    this.audioCtx?.close();
    this.audioCtx = null;
  }
}

export function releaseCapture(cap: Captured) {
  for (const s of [cap.display, cap.camera, cap.mic]) s?.getTracks().forEach((t) => t.stop());
}
