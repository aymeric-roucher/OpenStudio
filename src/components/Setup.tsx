import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Crop, FileVideo, Monitor, PanelTop, Video } from "lucide-react";
import { adoptStyles, Field, Segmented, Slider, Toggle } from "./ui";
import { cameraStream, captureDisplay, micStream, type Captured, type SurfaceKind } from "../lib/recorder";
import { loadPrefs, savePrefs, type Prefs } from "../lib/prefs";
import { WALLPAPERS, wallpaperCss } from "../lib/wallpapers";
import type { CameraSettings } from "../lib/types";

export type StartRequest = {
  cap: Captured;
  pip: Window | null;
  countdown: number;
  notes: string;
  surface: Prefs["surface"];
};

const SOURCES: { value: Prefs["surface"]; label: string; hint: string; icon: typeof Monitor }[] = [
  { value: "monitor", label: "Entire screen", hint: "A whole display", icon: Monitor },
  { value: "window", label: "Window", hint: "A single app window", icon: AppWindow },
  { value: "browser", label: "Browser tab", hint: "Also captures tab audio", icon: PanelTop },
  { value: "area", label: "Area", hint: "Record the screen, then pick the area to keep", icon: Crop },
];

type Pip = { requestWindow(o: { width: number; height: number }): Promise<Window> };
const pipApi = (): Pip | null => (window as unknown as { documentPictureInPicture?: Pip }).documentPictureInPicture ?? null;

/** Whether a device can be used, and if not, why, in words the user can act on. */
type Access = { ok: true } | { ok: false; reason: string };
type Perm = { camera: Access; mic: Access };

function explain(e: unknown, device: "camera" | "microphone"): string {
  // Anything other than a media DOMException is a bug, not a permission problem.
  if (!(e instanceof DOMException)) throw e;
  const settingsPane = device === "camera" ? "Camera" : "Microphone";
  if (e.name === "NotAllowedError" && /system/i.test(e.message))
    return `Your operating system blocks the browser from using the ${device}. On macOS: System Settings, Privacy & Security, ${settingsPane}, turn your browser on, then quit and reopen the browser.`;
  if (e.name === "NotAllowedError")
    return `Blocked for this site. Click the icon at the left of the address bar, allow the ${device}, then press Retry.`;
  if (e.name === "NotFoundError") return `No ${device} found. Plug one in, then press Retry.`;
  if (e.name === "NotReadableError") return `The ${device} is busy in another app (Zoom, FaceTime, Teams, Photo Booth…). Close it, then press Retry.`;
  return `${e.name}: ${e.message}`;
}

/** Ask for camera and microphone access so device labels are available, keeping the real reason when it fails. */
async function requestPermissions(): Promise<Perm> {
  const ask = async (c: MediaStreamConstraints, device: "camera" | "microphone"): Promise<Access> => {
    const [r] = await Promise.allSettled([navigator.mediaDevices.getUserMedia(c)]);
    if (r.status === "rejected") return { ok: false, reason: explain(r.reason, device) };
    r.value.getTracks().forEach((t) => t.stop());
    return { ok: true };
  };
  return { camera: await ask({ video: true }, "camera"), mic: await ask({ audio: true }, "microphone") };
}

export default function Setup(props: { onStart: (r: StartRequest) => void; onImport: (f: File) => void }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [perm, setPerm] = useState<Perm | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [dragging, setDragging] = useState(false);
  const micRef = useRef<MediaStream | null>(null);
  const handedOff = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState({ w: 711, h: 400 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(stageRef.current!);
    return () => ro.disconnect();
  }, []);

  const update = (patch: Partial<Prefs>) => setPrefs(savePrefs(patch));
  const cam = prefs.lastStyle.camera;
  const setCam = (patch: Partial<CameraSettings>) => update({ lastStyle: { ...prefs.lastStyle, camera: { ...cam, ...patch } } });

  const checkAccess = async () => {
    const p = await requestPermissions();
    const list = await navigator.mediaDevices.enumerateDevices();
    setPerm(p);
    setDevices(list);
    const cams = list.filter((d) => d.kind === "videoinput");
    const mics = list.filter((d) => d.kind === "audioinput");
    const cur = loadPrefs();
    setPrefs(savePrefs({
      cameraId: p.camera.ok && cams.length ? (cams.some((d) => d.deviceId === cur.cameraId) ? cur.cameraId : cams[0].deviceId) : null,
      micId: p.mic.ok && mics.length ? (mics.some((d) => d.deviceId === cur.micId) ? cur.micId : mics[0].deviceId) : null,
    }));
  };

  useEffect(() => {
    checkAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After fixing access in the address bar or system settings, coming back to the tab checks again.
  const blocked = perm !== null && (!perm.camera.ok || !perm.mic.ok);
  useEffect(() => {
    if (!blocked) return;
    const onFocus = () => checkAccess();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  const accessError = (a: Access | undefined) =>
    a && !a.ok ? (
      <div className="access-error">
        <span>{a.reason}</span>
        <button className="btn small" onClick={checkAccess}>Retry</button>
      </div>
    ) : null;

  // Live camera preview, once devices are known (a stored id may be stale).
  useEffect(() => {
    if (!prefs.cameraId || !perm) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    cameraStream(prefs.cameraId).then((s) => {
      if (cancelled) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      setCamStream(s);
    });
    return () => {
      cancelled = true;
      if (stream && !handedOff.current) stream.getTracks().forEach((t) => t.stop());
      setCamStream(null);
    };
  }, [prefs.cameraId, perm]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camStream;
  }, [camStream]);

  // Microphone level meter.
  useEffect(() => {
    if (!prefs.micId || !perm) return;
    let raf = 0;
    let cancelled = false;
    let ctx: AudioContext | null = null;
    micStream(prefs.micId).then((s) => {
      if (cancelled) return s.getTracks().forEach((t) => t.stop());
      micRef.current = s;
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
        setMicLevel(Math.min(1, peak * 1.6));
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      ctx?.close();
      if (micRef.current && !handedOff.current) micRef.current.getTracks().forEach((t) => t.stop());
      micRef.current = null;
      setMicLevel(0);
    };
  }, [prefs.micId, perm]);

  const [pip, setPip] = useState<Window | null>(null);

  /** Open the share picker. Must run inside a click (in this page or in the floating window). */
  const share = async (win: Window | null) => {
    const surface: SurfaceKind = prefs.surface === "area" ? "monitor" : prefs.surface;
    const shared = await Promise.allSettled([captureDisplay({ surface, cameraId: prefs.cameraId, micId: prefs.micId, systemAudio: prefs.systemAudio })]);
    if (shared[0].status === "rejected") {
      win?.close();
      setPip(null);
      // Closing the share picker is a normal cancel, anything else is a real error.
      if (shared[0].reason instanceof DOMException && shared[0].reason.name === "NotAllowedError") return;
      throw shared[0].reason;
    }
    handedOff.current = true;
    props.onStart({
      cap: { display: shared[0].value, camera: camStream, mic: micRef.current },
      pip: win,
      countdown: prefs.countdown,
      notes: prefs.notes,
      surface: prefs.surface,
    });
  };

  const start = async () => {
    const api = prefs.floatingControls ? pipApi() : null;
    if (!api) return share(null);
    // Open the floating controls first, then pick the source from a click inside it:
    // a click there activates this page too, so the share picker always has a fresh user gesture.
    const win = await api.requestWindow({ width: 340, height: prefs.notes.trim() ? 380 : 130 });
    adoptStyles(win);
    win.addEventListener("pagehide", () => setPip(null), { once: true });
    setPip(win);
  };

  // Drag the camera bubble around the stage.
  const onCamDown = (e: React.PointerEvent) => {
    const stage = stageRef.current!.getBoundingClientRect();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setCam({ x: Math.min(Math.max((ev.clientX - stage.left) / stage.width, 0), 1), y: Math.min(Math.max((ev.clientY - stage.top) / stage.height, 0), 1) });
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const cams = devices.filter((d) => d.kind === "videoinput");
  const mics = devices.filter((d) => d.kind === "audioinput");
  const stageH = stage.h;
  const stageW = stage.w;
  const bubbleH = cam.size * stageH;
  const bubbleW = cam.shape === "square" ? bubbleH * (16 / 9) * 0.75 : bubbleH;
  const radius = cam.shape === "circle" ? "50%" : cam.shape === "rounded" ? `${bubbleH * 0.22}px` : `${bubbleH * 0.06}px`;
  const left = Math.min(Math.max(cam.x * stageW - bubbleW / 2, 0), stageW - bubbleW);
  const top = Math.min(Math.max(cam.y * stageH - bubbleH / 2, 0), stageH - bubbleH);
  const bg = prefs.lastStyle.background;

  return (
    <div
      className="setup"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) props.onImport(f);
      }}
    >
      <div className="setup-stage">
        <div className="row">
          <div className="brand"><span className="brand-dot" /> OpenStudio</div>
          <span className="dim" style={{ marginLeft: 8 }}>Beautiful screen recordings, entirely in your browser.</span>
        </div>
        <div className="stage-preview">
          <div className="stage-canvas" ref={stageRef} style={{ background: bg.kind === "wallpaper" ? wallpaperCss(WALLPAPERS[bg.wallpaper]) : bg.kind === "color" ? bg.color : `linear-gradient(${bg.gradient.angle}deg, ${bg.gradient.from}, ${bg.gradient.to})` }}>
            <div className="stage-screen">
              <Monitor size={34} strokeWidth={1.5} />
              <div style={{ fontWeight: 600 }}>{SOURCES.find((s) => s.value === prefs.surface)!.label}</div>
              <div className="muted" style={{ fontSize: 12 }}>You will choose exactly what to share after clicking record.</div>
            </div>
            {camStream && cam.visible && (
              <div className="stage-cam" onPointerDown={onCamDown} style={{ left, top, width: bubbleW, height: bubbleH, borderRadius: radius }} title="Drag to position your camera">
                <video ref={videoRef} autoPlay muted playsInline style={{ transform: cam.mirror ? "scaleX(-1)" : undefined }} />
              </div>
            )}
          </div>
          {dragging && <div className="drop-hint">Drop a video to edit it</div>}
        </div>
        <div className="row muted" style={{ justifyContent: "center", gap: 6, fontSize: 12 }}>
          <span>Everything stays on your device. Nothing is uploaded.</span>
        </div>
      </div>

      <div className="setup-side">
        <Field label="What to record">
          <div className="source-grid">
            {SOURCES.map((s) => (
              <button key={s.value} className={`source-card ${prefs.surface === s.value ? "on" : ""}`} onClick={() => update({ surface: s.value })}>
                <s.icon size={18} />
                <span style={{ fontWeight: 600 }}>{s.label}</span>
                <small>{s.hint}</small>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Camera">
          <select className="select" value={prefs.cameraId ?? ""} onChange={(e) => update({ cameraId: e.target.value || null })}>
            <option value="">No camera</option>
            {cams.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
          </select>
          {accessError(perm?.camera)}
        </Field>
        {prefs.cameraId && (
          <>
            <Field label="Camera shape">
              <Segmented value={cam.shape} onChange={(shape) => setCam({ shape })} options={[{ value: "circle", label: "Circle" }, { value: "rounded", label: "Rounded" }, { value: "square", label: "Rectangle" }]} />
            </Field>
            <Field label="Camera size">
              <Slider value={cam.size} min={0.12} max={0.6} onChange={(size) => setCam({ size })} format={(v) => `${Math.round(v * 100)}%`} />
            </Field>
          </>
        )}

        <Field label="Microphone">
          <select className="select" value={prefs.micId ?? ""} onChange={(e) => update({ micId: e.target.value || null })}>
            <option value="">No microphone</option>
            {mics.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
          </select>
          {accessError(perm?.mic)}
          {prefs.micId && <div className="meter"><div style={{ width: `${micLevel * 100}%` }} /></div>}
        </Field>

        <Toggle label="Record system audio" value={prefs.systemAudio} onChange={(systemAudio) => update({ systemAudio })} />
        {pipApi() && <Toggle label="Floating controls window" value={prefs.floatingControls} onChange={(floatingControls) => update({ floatingControls })} />}

        <Field label="Countdown">
          <Segmented value={prefs.countdown} onChange={(countdown) => update({ countdown })} options={[0, 3, 5, 10].map((v) => ({ value: v, label: v ? `${v}s` : "Off" }))} />
        </Field>

        <Field label="Speaker notes" extra={<span className="dim">shown while recording</span>}>
          <textarea className="input" rows={3} placeholder="Talking points…" value={prefs.notes} onChange={(e) => update({ notes: e.target.value })} />
        </Field>

        <div className="grow" />
        <button className="record-btn" onClick={start}>
          <Video size={18} /> Start recording
        </button>
        <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => fileRef.current!.click()}>
          <FileVideo size={15} /> Edit an existing video
        </button>
        <input ref={fileRef} type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && props.onImport(e.target.files[0])} />
      </div>
      {pip &&
        createPortal(
          <div className="pip" style={{ justifyContent: "center" }}>
            <button className="record-btn" onClick={() => share(pip)}><Video size={18} /> Choose what to share</button>
            <button className="btn ghost block" onClick={() => pip.close()}>Cancel</button>
          </div>,
          pip.document.body,
        )}
    </div>
  );
}
