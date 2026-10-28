import { outputDuration, outputToSource, sourceToOutput } from "./timeline";
import type { Project, Recording } from "./types";

const DRIFT = 0.12;
const MUSIC_FADE = 1;

/**
 * Plays the edited timeline in real time with hidden media elements:
 * jumps over cuts, applies per-segment speed, keeps camera and music in sync.
 */
export class Player {
  readonly screen: HTMLVideoElement;
  readonly camera: HTMLVideoElement | null;
  private music: HTMLAudioElement | null = null;
  private musicUrl: string | null = null;
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private seg = 0;
  project: Project;
  time = 0;
  playing = false;
  /** Bumped whenever a new frame may be visible, so the preview knows to redraw. */
  version = 0;
  private listeners = new Set<() => void>();

  /** Be told whenever the time or the play state changes. Returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  constructor(rec: Recording, project: Project) {
    this.project = project;
    this.screen = this.video(rec.screenUrl);
    this.camera = rec.cameraUrl ? this.video(rec.cameraUrl) : null;
    this.camera && (this.camera.muted = true);
  }

  private video(url: string): HTMLVideoElement {
    const v = document.createElement("video");
    v.src = url;
    v.preload = "auto";
    v.playsInline = true;
    v.addEventListener("seeked", () => this.version++);
    v.addEventListener("loadeddata", () => this.version++);
    return v;
  }

  get duration() {
    return outputDuration(this.project.segments);
  }

  setProject(p: Project) {
    const segmentsChanged = p.segments !== this.project.segments;
    this.project = p;
    if (p.music?.url !== this.musicUrl) {
      this.music?.pause();
      this.musicUrl = p.music?.url ?? null;
      this.music = p.music ? Object.assign(new Audio(p.music.url), { loop: true }) : null;
      if (this.playing) this.syncMusic();
    }
    if (segmentsChanged) {
      // Clips changed under us: re-anchor on the current output time.
      this.time = Math.min(this.time, this.duration);
      if (!this.playing) this.seek(this.time);
      else {
        this.seg = outputToSource(p.segments, this.time).index;
        this.setRate();
      }
    }
    this.applyVolume();
    this.version++;
  }

  private applyVolume() {
    const v = this.project.muted ? 0 : this.project.volume * this.project.segments[this.seg].volume;
    if (this.gain) this.gain.gain.value = v;
    else this.screen.volume = Math.min(v, 1);
  }

  async play() {
    if (this.playing) return;
    // Route audio through Web Audio so volume can go above 100%.
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.gain = this.audioCtx.createGain();
      this.audioCtx.createMediaElementSource(this.screen).connect(this.gain).connect(this.audioCtx.destination);
      this.applyVolume();
    }
    if (this.time >= this.duration - 0.02) this.seek(0);
    const { index, source } = outputToSource(this.project.segments, this.time);
    this.seg = index;
    this.screen.currentTime = source;
    this.setRate();
    this.playing = true;
    this.notify();
    await Promise.all([this.screen.play(), this.camera?.play(), this.audioCtx.resume()]);
    this.syncMusic();
  }

  pause() {
    this.playing = false;
    this.screen.pause();
    this.camera?.pause();
    this.music?.pause();
    this.version++;
    this.notify();
  }

  seek(t: number) {
    this.time = Math.min(Math.max(t, 0), this.duration);
    const { index, source } = outputToSource(this.project.segments, this.time);
    this.seg = index;
    this.screen.currentTime = source;
    if (this.camera) this.camera.currentTime = source;
    this.setRate();
    if (this.playing) this.syncMusic();
    this.version++;
    this.notify();
  }

  private setRate() {
    this.applyVolume();
    const speed = this.project.segments[this.seg].speed;
    this.screen.playbackRate = speed;
    if (this.camera) this.camera.playbackRate = speed;
  }

  private syncMusic() {
    if (!this.music) return;
    const d = this.music.duration;
    this.music.currentTime = Number.isFinite(d) && d > 0 ? this.time % d : 0;
    this.music.play();
  }

  /** Advance playback; call once per animation frame. */
  tick() {
    if (!this.playing) return;
    const segs = this.project.segments;
    const s = segs[this.seg];
    if (this.screen.currentTime >= s.end - 0.01 || this.screen.ended) {
      if (this.seg === segs.length - 1) {
        this.time = this.duration;
        this.pause();
        return;
      }
      this.seg++;
      this.screen.currentTime = segs[this.seg].start;
      if (this.camera) this.camera.currentTime = segs[this.seg].start;
      this.setRate();
    }
    this.time = sourceToOutput(segs, this.seg, Math.max(this.screen.currentTime, segs[this.seg].start));
    if (this.camera && Math.abs(this.camera.currentTime - this.screen.currentTime) > DRIFT) this.camera.currentTime = this.screen.currentTime;
    if (this.music && this.project.music) {
      const m = this.project.music;
      const fade = m.fade ? Math.min(1, this.time / MUSIC_FADE, (this.duration - this.time) / MUSIC_FADE) : 1;
      this.music.volume = Math.max(0, Math.min(1, m.volume * fade));
    }
    this.version++;
    this.notify();
  }

  destroy() {
    this.pause();
    for (const v of [this.screen, this.camera]) v?.removeAttribute("src");
    this.audioCtx?.close();
  }
}
