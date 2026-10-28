import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Crop, Dices, Download, ImagePlus, Trash2, Upload, Wand2 } from "lucide-react";
import { CAMERA_PRESETS, DEFAULT_STYLE, normalizeStyle, styleOf, uid } from "../lib/defaults";
import { loadPrefs, savePrefs, type Prefs } from "../lib/prefs";
import { sourceRangeToOutput, speedUpRanges } from "../lib/timeline";
import { WALLPAPERS, wallpaperCss } from "../lib/wallpapers";
import { analyzeActivity, findIdleRanges, findTypingRanges, suggestZooms, type ActivitySample } from "../lib/autozoom";
import { inferClicks, suggestClickZooms, trackCursor } from "../lib/cursor";
import { transcribe, type TranscribeProgress, type WhisperModel } from "../lib/transcribe";
import { outputSize } from "../lib/layout";
import { frameRect } from "../lib/render";
import { download } from "../lib/media";
import { toSubtitles } from "../lib/subtitles";
import type { Background, CameraCorner, CameraSettings, Project, Style, ZoomRegion } from "../lib/types";
import type { EditorApi } from "./Editor";
import { Field, Segmented, Slider, Toggle } from "./ui";

export type Tab = "background" | "camera" | "captions" | "audio" | "smart" | "layouts";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8];
const GRADIENTS: [string, string][] = [
  ["#2f7cf6", "#22d3ee"], ["#7c5cff", "#ff6ec7"], ["#f7971e", "#ffd200"], ["#11998e", "#38ef7d"],
  ["#fc466b", "#3f5efb"], ["#232526", "#414345"], ["#ee9ca7", "#ffdde1"], ["#0f2027", "#2c5364"],
];
const COLORS = ["#0b0b0f", "#1b1b22", "#ffffff", "#f4f1ea", "#2f7cf6", "#ff4d5e", "#19b6a5", "#ffb020"];
const LANGUAGES: [string | null, string][] = [
  [null, "Detect automatically"], ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["de", "German"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["tr", "Turkish"],
  ["ar", "Arabic"], ["hi", "Hindi"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];

function Header(props: { title: string; onDelete?: () => void }) {
  return (
    <h3>
      <span className="grow">{props.title}</span>
      {props.onDelete && <button className="icon-btn" title="Delete (⌫)" onClick={props.onDelete}><Trash2 size={16} /></button>}
    </h3>
  );
}

/** Small unzoomed preview: click to choose where a zoom focuses. */
function FocusPicker(props: { api: EditorApi; zoom: ZoomRegion }) {
  const { api, zoom } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const [ok, setOk] = useState(false);
  const mid = (zoom.start + zoom.end) / 2;
  useEffect(() => {
    if (api.player.screen.readyState < 2) return;
    const snap = api.snapshot(480, { zooms: [] });
    const c = ref.current!;
    Object.assign(c, { width: snap.width, height: snap.height });
    c.getContext("2d")!.drawImage(snap, 0, 0);
    setOk(true);
    // Redraw when the frame or the look changes, not on every playback tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.player.version, api.p.background, api.p.padding, api.p.aspect, api.p.crop, mid]);
  const set = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
    api.update((p) => ({ ...p, zooms: p.zooms.map((z) => (z.id === zoom.id ? { ...z, x, y } : z)) }), `focus-${zoom.id}`);
  };
  const ratio = ref.current && ok ? ref.current.width / ref.current.height : 16 / 9;
  return (
    <div
      className="focus-picker"
      style={{ aspectRatio: ratio }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(e);
      }}
      onPointerMove={(e) => e.buttons && set(e)}
    >
      <canvas ref={ref} />
      <div style={{ position: "absolute", left: `${(zoom.x - 0.5 / zoom.scale) * 100}%`, top: `${(zoom.y - 0.5 / zoom.scale) * 100}%`, width: `${100 / zoom.scale}%`, height: `${100 / zoom.scale}%`, border: "2px solid #fff", borderRadius: 4, boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)", pointerEvents: "none" }} />
      <div className="focus-dot" style={{ left: `${zoom.x * 100}%`, top: `${zoom.y * 100}%` }} />
    </div>
  );
}

function SelectionPanel({ api, deleteSelected }: { api: EditorApi; deleteSelected: () => void }) {
  const { p, sel, update } = api;
  if (!sel) return null;
  if (sel.kind === "segment") {
    const s = p.segments.find((x) => x.id === sel.id);
    if (!s) return null;
    const set = (speed: number) => update((x) => ({ ...x, segments: x.segments.map((y) => (y.id === s.id ? { ...y, speed } : y)) }), `speed-${s.id}`);
    return (
      <>
        <Header title="Clip" onDelete={p.segments.length > 1 ? deleteSelected : undefined} />
        <Field label="Speed">
          <Segmented value={s.speed} onChange={set} options={SPEEDS.map((v) => ({ value: v, label: `${v}x` }))} />
        </Field>
        <Field label="Custom speed">
          <Slider value={s.speed} min={0.25} max={8} step={0.05} onChange={set} format={(v) => `${v.toFixed(2)}x`} />
        </Field>
        <Field label="Clip volume">
          <Slider value={s.volume} min={0} max={2} onChange={(volume) => update((x) => ({ ...x, segments: x.segments.map((y) => (y.id === s.id ? { ...y, volume } : y)) }), `clip-volume-${s.id}`)} format={pct} />
        </Field>
        <p className="muted" style={{ lineHeight: 1.5 }}>
          Plays {(s.end - s.start).toFixed(1)} s of the recording in {((s.end - s.start) / s.speed).toFixed(1)} s. Drag the clip edges on the timeline to trim, press C to split at the playhead.
        </p>
      </>
    );
  }
  if (sel.kind === "zoom") {
    const z = p.zooms.find((x) => x.id === sel.id);
    if (!z) return null;
    const set = (patch: Partial<ZoomRegion>, key: string) => update((x) => ({ ...x, zooms: x.zooms.map((y) => (y.id === z.id ? { ...y, ...patch } : y)) }), `${key}-${z.id}`);
    return (
      <>
        <Header title="Zoom" onDelete={deleteSelected} />
        <Field label="Zoom level">
          <Slider value={z.scale} min={1.1} max={4} step={0.05} onChange={(scale) => set({ scale }, "scale")} format={(v) => `${v.toFixed(2)}x`} />
        </Field>
        <Field label="Focus point" extra={<span className="dim">click to move</span>}>
          <FocusPicker api={api} zoom={z} />
        </Field>
        <Toggle label="Instant zoom (no animation)" value={z.instant} onChange={(instant) => set({ instant }, "instant")} />
        {p.cursor.length > 0 ? (
          <Toggle label="Follow the cursor" value={z.follow} onChange={(follow) => set({ follow }, "follow")} />
        ) : (
          <p className="dim" style={{ lineHeight: 1.5 }}>To make zooms follow the cursor, run Analyze recording in Smart edits first.</p>
        )}
      </>
    );
  }
  if (sel.kind === "mask") {
    const m = p.masks.find((x) => x.id === sel.id);
    if (!m) return null;
    const set = (patch: Partial<typeof m>, key: string) => update((x) => ({ ...x, masks: x.masks.map((y) => (y.id === m.id ? { ...y, ...patch } : y)) }), `${key}-${m.id}`);
    return (
      <>
        <Header title="Mask" onDelete={deleteSelected} />
        <Field label="Effect">
          <Segmented value={m.kind} onChange={(kind) => set({ kind }, "kind")} options={[{ value: "blur", label: "Blur" }, { value: "pixelate", label: "Pixelate" }, { value: "highlight", label: "Highlight" }]} />
        </Field>
        <Field label={m.kind === "highlight" ? "Dim the rest" : "Strength"}>
          <Slider value={m.strength} min={0} max={1} onChange={(strength) => set({ strength }, "strength")} format={pct} />
        </Field>
        <p className="muted" style={{ lineHeight: 1.5 }}>Drag the box on the preview to choose the area. Blur and pixelate hide sensitive information, highlight dims everything else.</p>
      </>
    );
  }
  if (sel.kind === "layout") {
    const l = p.cameraLayouts.find((x) => x.id === sel.id);
    if (!l) return null;
    return (
      <>
        <Header title="Camera layout" onDelete={deleteSelected} />
        <Field label="During this section">
          <Segmented
            value={l.layout}
            onChange={(layout) => update((x) => ({ ...x, cameraLayouts: x.cameraLayouts.map((y) => (y.id === l.id ? { ...y, layout } : y)) }))}
            options={[{ value: "fullscreen", label: "Camera fullscreen" }, { value: "side", label: "Side by side" }, { value: "hidden", label: "Hide camera" }]}
          />
        </Field>
        <p className="muted" style={{ lineHeight: 1.5 }}>Outside of layout sections, the camera uses its default bubble from the Camera settings.</p>
      </>
    );
  }
  const c = p.captions.find((x) => x.id === sel.id);
  if (!c) return null;
  return (
    <>
      <Header title="Caption" onDelete={deleteSelected} />
      <textarea className="input" rows={3} value={c.text} onChange={(e) => update((x) => ({ ...x, captions: x.captions.map((y) => (y.id === c.id ? { ...y, text: e.target.value } : y)) }), `caption-${c.id}`)} />
    </>
  );
}

function BackgroundPanel({ api }: { api: EditorApi }) {
  const { p, update } = api;
  const b = p.background;
  const setBg = (patch: Partial<Background>, key = "bg") => update((x) => ({ ...x, background: { ...x.background, ...patch } }), key);
  const set = (patch: Partial<Project>, key: string) => update((x) => ({ ...x, ...patch }), key);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <h3>Background</h3>
      <div className="field">
        <Segmented value={b.kind} onChange={(kind) => setBg({ kind })} options={[{ value: "wallpaper", label: "Wallpaper" }, { value: "gradient", label: "Gradient" }, { value: "color", label: "Color" }, { value: "image", label: "Image" }]} />
      </div>
      {b.kind === "wallpaper" && (
        <>
          <button className="btn block" style={{ marginBottom: 12 }} onClick={() => setBg({ wallpaper: Math.floor(Math.random() * WALLPAPERS.length) })}><Dices size={15} /> Pick random wallpaper</button>
          <div className="swatches field">
            {WALLPAPERS.map((w, i) => (
              <button key={w.name} title={w.name} className={`swatch ${b.wallpaper === i ? "on" : ""}`} style={{ background: wallpaperCss(w) }} onClick={() => setBg({ wallpaper: i })} />
            ))}
          </div>
        </>
      )}
      {b.kind === "gradient" && (
        <>
          <div className="swatches field">
            {GRADIENTS.map(([from, to]) => (
              <button key={from + to} className={`swatch ${b.gradient.from === from && b.gradient.to === to ? "on" : ""}`} style={{ background: `linear-gradient(135deg, ${from}, ${to})` }} onClick={() => setBg({ gradient: { ...b.gradient, from, to } })} />
            ))}
          </div>
          <Field label="Colors">
            <div className="row">
              <input type="color" className="color-input" value={b.gradient.from} onChange={(e) => setBg({ gradient: { ...b.gradient, from: e.target.value } }, "grad-from")} />
              <input type="color" className="color-input" value={b.gradient.to} onChange={(e) => setBg({ gradient: { ...b.gradient, to: e.target.value } }, "grad-to")} />
            </div>
          </Field>
          <Field label="Angle">
            <Slider value={b.gradient.angle} min={0} max={360} step={1} onChange={(angle) => setBg({ gradient: { ...b.gradient, angle } }, "grad-angle")} format={(v) => `${v}°`} />
          </Field>
        </>
      )}
      {b.kind === "color" && (
        <Field label="Color">
          <div className="row" style={{ flexWrap: "wrap" }}>
            {COLORS.map((c) => <button key={c} className={`swatch ${b.color === c ? "on" : ""}`} style={{ background: c, width: 30 }} onClick={() => setBg({ color: c })} />)}
            <input type="color" className="color-input" value={b.color} onChange={(e) => setBg({ color: e.target.value }, "color")} />
          </div>
        </Field>
      )}
      {b.kind === "image" && (
        <Field label="Image">
          {b.image && <img src={b.image} style={{ width: "100%", borderRadius: 8, aspectRatio: "16/9", objectFit: "cover" }} />}
          <button className="btn block" onClick={() => fileRef.current!.click()}><ImagePlus size={15} /> {b.image ? "Replace image" : "Choose an image"}</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setBg({ image: URL.createObjectURL(e.target.files[0]) })} />
        </Field>
      )}
      <Field label="Background blur">
        <Slider value={b.blur} min={0} max={1} onChange={(blur) => setBg({ blur }, "blur")} format={pct} />
      </Field>
      <div className="divider" />
      <h3>Frame</h3>
      <Field label="Padding" extra={<button className="btn ghost small" onClick={() => set({ padding: DEFAULT_STYLE.padding }, "padding")}>Reset</button>}>
        <Slider value={p.padding} min={0} max={0.3} step={0.005} onChange={(padding) => set({ padding }, "padding")} format={(v) => pct(v / 0.3)} />
      </Field>
      <Field label="Roundness">
        <Slider value={p.radius} min={0} max={0.12} step={0.002} onChange={(radius) => set({ radius }, "radius")} format={(v) => pct(v / 0.12)} />
      </Field>
      <Field label="Shadow">
        <Slider value={p.shadow} min={0} max={1} onChange={(shadow) => set({ shadow }, "shadow")} format={pct} />
      </Field>
      <Field label="Inset border">
        <Slider value={p.inset} min={0} max={6} step={0.5} onChange={(inset) => set({ inset }, "inset")} format={(v) => `${v}px`} />
      </Field>
      <Toggle label="Keep zoomed in (fill the canvas)" value={p.keepZoomedIn} onChange={(keepZoomedIn) => set({ keepZoomedIn }, "keep-zoomed")} />
      <div className="divider" />
      <h3>Animations</h3>
      <Field label="Zoom speed">
        <Segmented value={p.zoomSpeed} onChange={(zoomSpeed) => set({ zoomSpeed }, "zoom-speed")} options={[{ value: "slow", label: "Slow" }, { value: "mellow", label: "Mellow" }, { value: "quick", label: "Quick" }, { value: "rapid", label: "Rapid" }]} />
      </Field>
      <Field label="Motion blur" extra={<span className="dim">applied on export</span>}>
        <Slider value={p.motionBlur} min={0} max={1} onChange={(motionBlur) => set({ motionBlur }, "motion-blur")} format={pct} />
      </Field>
    </>
  );
}

const CORNERS: [CameraCorner, typeof ArrowUpLeft, string][] = [
  ["top-left", ArrowUpLeft, "Top left"], ["top-right", ArrowUpRight, "Top right"],
  ["bottom-left", ArrowDownLeft, "Bottom left"], ["bottom-right", ArrowDownRight, "Bottom right"],
];

/** Ratio label for a camera crop, e.g. "1:1" or "Original". */
export function cropLabel(aspect: number | null): string {
  if (aspect === null) return "Original";
  const known: [number, string][] = [[1, "1:1"], [4 / 3, "4:3"], [3 / 4, "3:4"], [16 / 9, "16:9"], [9 / 16, "9:16"]];
  return known.find(([v]) => Math.abs(v - aspect) < 0.01)?.[1] ?? aspect.toFixed(2);
}

function CameraPanel({ api }: { api: EditorApi }) {
  const { p, rec, update } = api;
  if (!rec.camera) return (<><h3>Camera</h3><p className="muted">This recording has no camera track. Pick a camera before recording to get a movable camera bubble.</p></>);
  const c = p.camera;
  const set = (patch: Partial<CameraSettings>, key = "cam") => update((x) => ({ ...x, camera: { ...x.camera, ...patch } }), key);
  const active = (Object.keys(CAMERA_PRESETS) as (keyof typeof CAMERA_PRESETS)[]).find(
    (k) => CAMERA_PRESETS[k].crop.aspect === c.crop.aspect && Math.abs(CAMERA_PRESETS[k].roundness - c.roundness) < 0.01,
  );
  return (
    <>
      <h3>Camera</h3>
      <Toggle label="Show camera" value={c.visible} onChange={(visible) => set({ visible })} />
      <Field label="Shape presets">
        <div className="seg">
          {([["circle", "Circle"], ["rounded", "Rounded"], ["rectangle", "Rectangle"]] as const).map(([k, label]) => (
            <button key={k} className={active === k ? "on" : ""} onClick={() => set({ ...structuredClone(CAMERA_PRESETS[k]), crop: { ...c.crop, aspect: CAMERA_PRESETS[k].crop.aspect } })}>{label}</button>
          ))}
        </div>
      </Field>
      <Field label="Roundness">
        <Slider value={c.roundness} min={0} max={1} onChange={(roundness) => set({ roundness }, "cam-roundness")} format={pct} />
      </Field>
      <Field label="Crop" extra={<span className="dim">{cropLabel(c.crop.aspect)}{c.crop.zoom > 1.01 ? `, ${c.crop.zoom.toFixed(1)}x` : ""}</span>}>
        <button className="btn block" onClick={api.openCameraCrop}><Crop size={15} /> Crop camera</button>
      </Field>
      <Field label="Size">
        <Slider value={c.size} min={0.1} max={0.7} onChange={(size) => set({ size }, "cam-size")} format={pct} />
      </Field>
      <Field label="Position" extra={<span className="dim">or drag it on the preview</span>}>
        <div className="row">
          {CORNERS.map(([corner, Icon, label]) => (
            <button key={corner} className={`btn ${c.corner === corner ? "primary" : ""}`} title={label} onClick={() => set({ corner })}><Icon size={15} /></button>
          ))}
        </div>
      </Field>
      <Field label="Distance from edges">
        <Slider value={c.margin} min={0} max={0.15} step={0.002} onChange={(margin) => set({ margin }, "cam-margin")} format={(v) => pct(v / 0.15)} />
      </Field>
      <Toggle label="Mirror" value={c.mirror} onChange={(mirror) => set({ mirror })} />
      <Toggle label="Shrink while zoomed in" value={c.shrinkOnZoom} onChange={(shrinkOnZoom) => set({ shrinkOnZoom })} />
      <Field label="Shadow">
        <Slider value={c.shadow} min={0} max={1} onChange={(shadow) => set({ shadow }, "cam-shadow")} format={pct} />
      </Field>
      <Field label="Border">
        <Slider value={c.border} min={0} max={12} step={0.5} onChange={(border) => set({ border }, "cam-border")} format={(v) => `${v}px`} />
      </Field>
      <p className="muted" style={{ lineHeight: 1.5 }}>Use the camera track on the timeline to switch to fullscreen camera, side by side, or hide it for a section.</p>
    </>
  );
}

function CaptionsPanel({ api }: { api: EditorApi }) {
  const { p, rec, update } = api;
  const [model, setModel] = useState<WhisperModel>("base");
  const [language, setLanguage] = useState<string | null>(null);
  const [progress, setProgress] = useState<TranscribeProgress | null>(null);
  const s = p.captionStyle;
  const setStyle = (patch: Partial<typeof s>, key: string) => update((x) => ({ ...x, captionStyle: { ...x.captionStyle, ...patch } }), key);
  const generate = async () => {
    setProgress({ stage: "decoding", progress: 0 });
    const captions = await transcribe(rec.screen, { model, language }, setProgress).finally(() => setProgress(null));
    update((x) => ({ ...x, captions, captionStyle: { ...x.captionStyle, enabled: true } }));
    api.notify(captions.length ? `${captions.length} captions generated` : "No speech found");
  };
  const stageLabel = { decoding: "Reading audio", "loading-model": "Downloading speech model (first time only)", transcribing: "Transcribing on your device" };
  return (
    <>
      <h3>Captions</h3>
      {!rec.hasAudio && <p className="muted">This recording has no audio, so there is nothing to transcribe.</p>}
      {rec.hasAudio && (
        <>
          <Field label="Speech model">
            <Segmented value={model} onChange={setModel} options={[{ value: "tiny", label: "Fast", title: "Whisper tiny, about 40 MB" }, { value: "base", label: "Balanced", title: "Whisper base, about 80 MB" }, { value: "small", label: "Accurate", title: "Whisper small, about 250 MB" }]} />
          </Field>
          <Field label="Language">
            <select className="select" value={language ?? ""} onChange={(e) => setLanguage(e.target.value || null)}>
              {LANGUAGES.map(([code, name]) => <option key={name} value={code ?? ""}>{name}</option>)}
            </select>
          </Field>
          {progress ? (
            <div className="field">
              <span className="muted">{stageLabel[progress.stage]}… {pct(progress.progress)}</span>
              <div className="progress"><div style={{ width: pct(progress.progress) }} /></div>
            </div>
          ) : (
            <button className="btn primary block" style={{ marginBottom: 18 }} onClick={generate}><Wand2 size={15} /> {p.captions.length ? "Regenerate captions" : "Generate captions"}</button>
          )}
          <p className="dim" style={{ lineHeight: 1.5, marginTop: -6 }}>Transcription runs locally with Whisper. Your audio never leaves the browser.</p>
        </>
      )}
      {p.captions.length > 0 && (
        <>
          <div className="divider" />
          <Toggle label="Show captions" value={s.enabled} onChange={(enabled) => setStyle({ enabled }, "cap-enabled")} />
          <Field label="Text size">
            <Slider value={s.size} min={0.025} max={0.09} step={0.001} onChange={(size) => setStyle({ size }, "cap-size")} format={(v) => pct(v / 0.09)} />
          </Field>
          <Field label="Vertical position">
            <Slider value={s.y} min={0.08} max={0.95} onChange={(y) => setStyle({ y }, "cap-y")} format={pct} />
          </Field>
          <div className="row field">
            {(["srt", "vtt"] as const).map((f) => (
              <button key={f} className="btn grow" onClick={() => download(new Blob([toSubtitles(p.captions, p.segments, f)], { type: "text/plain" }), `${p.name.replace(/[^\w\- ]+/g, "").trim() || "captions"}.${f}`)}>
                <Download size={15} /> {f.toUpperCase()}
              </button>
            ))}
          </div>
          <Field label="Transcript" extra={<button className="btn ghost small" onClick={() => update((x) => ({ ...x, captions: [] }))}>Clear</button>}>
            <div className="caption-list">
              {p.captions.map((c) => (
                <div key={c.id} className="caption-item">
                  <button className="btn ghost small mono" onClick={() => { const r = sourceRangeToOutput(p.segments, c.start, c.end); if (r) api.player.seek(r[0]); }}>{c.start.toFixed(1)}s</button>
                  <textarea className="input" rows={1} value={c.text} onChange={(e) => update((x) => ({ ...x, captions: x.captions.map((y) => (y.id === c.id ? { ...y, text: e.target.value } : y)) }), `caption-${c.id}`)} />
                </div>
              ))}
            </div>
          </Field>
        </>
      )}
    </>
  );
}

function AudioPanel({ api }: { api: EditorApi }) {
  const { p, update } = api;
  const fileRef = useRef<HTMLInputElement>(null);
  const m = p.music;
  return (
    <>
      <h3>Audio</h3>
      <Toggle label="Mute recording" value={p.muted} onChange={(muted) => update((x) => ({ ...x, muted }))} />
      <Field label="Recording volume">
        <Slider value={p.volume} min={0} max={2} onChange={(volume) => update((x) => ({ ...x, volume }), "volume")} format={pct} />
      </Field>
      <div className="divider" />
      <h3>Background music</h3>
      {m ? (
        <>
          <div className="row field"><span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span><button className="icon-btn" title="Remove music" onClick={() => update((x) => ({ ...x, music: null }))}><Trash2 size={15} /></button></div>
          <Field label="Music volume">
            <Slider value={m.volume} min={0} max={1} onChange={(volume) => update((x) => ({ ...x, music: { ...x.music!, volume } }), "music-volume")} format={pct} />
          </Field>
          <Toggle label="Fade in and out" value={m.fade} onChange={(fade) => update((x) => ({ ...x, music: { ...x.music!, fade } }))} />
        </>
      ) : (
        <button className="btn block" onClick={() => fileRef.current!.click()}><Upload size={15} /> Add a music file</button>
      )}
      <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) update((x) => ({ ...x, music: { url: URL.createObjectURL(f), name: f.name, volume: 0.25, fade: true } }));
      }} />
      <p className="dim" style={{ lineHeight: 1.5, marginTop: 10 }}>Music loops for the whole video and is mixed into the export.</p>
    </>
  );
}

function SmartPanel({ api }: { api: EditorApi }) {
  const { p, rec, update } = api;
  const [samples, setSamples] = useState<ActivitySample[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [speed, setSpeed] = useState(4);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const [stage, setStage] = useState("");
  const analyze = async () => {
    abort.current = new AbortController();
    const signal = abort.current.signal;
    setProgress(0);
    setStage("Finding activity");
    const s = await analyzeActivity(rec.screen, (v) => setProgress(v * 0.4), signal).catch((e) => { setProgress(null); throw e; });
    setStage("Tracking the cursor");
    const cursor = await trackCursor(rec.screen, (v) => setProgress(0.4 + v * 0.6), signal).finally(() => setProgress(null));
    setSamples(s);
    update((x) => ({ ...x, cursor }));
  };

  const clicks = samples ? inferClicks(p.cursor, samples) : [];
  const clickZooms = samples ? suggestClickZooms(clicks, rec.duration) : [];
  const zooms = samples ? suggestZooms(samples) : [];
  const idle = samples ? findIdleRanges(samples, 1.5) : [];
  const typing = samples ? findTypingRanges(samples, 2) : [];

  const addZooms = (list: typeof zooms, follow: boolean) => {
    const [W, H] = outputSize(p, 1920, (p.crop.w * rec.width) / (p.crop.h * rec.height));
    update((x) => {
      const added: ZoomRegion[] = [];
      for (const z of list) {
        const r = sourceRangeToOutput(x.segments, z.start, z.end);
        if (!r || r[1] - r[0] < 1) continue;
        if ([...x.zooms, ...added].some((o) => z.start < o.end && z.end > o.start)) continue;
        // Focus is given on the source frame: map it through the crop onto the composition.
        const f = frameRect(x, W, H, rec.width, rec.height, r[0]);
        const fx = (z.x - x.crop.x) / x.crop.w, fy = (z.y - x.crop.y) / x.crop.h;
        added.push({ id: uid(), start: z.start, end: z.end, scale: z.scale, x: (f.x + fx * f.w) / W, y: (f.y + fy * f.h) / H, instant: false, follow });
      }
      api.notify(added.length ? `Added ${added.length} zooms` : "No free spot for the suggested zooms");
      return { ...x, zooms: [...x.zooms, ...added].sort((a, b) => a.start - b.start) };
    });
  };

  const speedUp = (ranges: { start: number; end: number }[]) => update((x) => ({ ...x, segments: speedUpRanges(x.segments, ranges, speed, uid) }));

  return (
    <>
      <h3>Smart edits</h3>
      <p className="muted" style={{ lineHeight: 1.5, marginTop: -6 }}>
        Analyze the pixels of your recording to find the cursor, its clicks, and where things change. A browser cannot read the mouse directly, so this replaces Screen Studio's click tracking.
      </p>
      {progress !== null ? (
        <div className="field"><span className="muted">{stage}… {pct(progress)}</span><div className="progress"><div style={{ width: pct(progress) }} /></div></div>
      ) : (
        <button className="btn primary block" style={{ marginBottom: 18 }} onClick={analyze}><Wand2 size={15} /> {samples ? "Analyze again" : "Analyze recording"}</button>
      )}
      {samples && (
        <>
          <Field label="Click zooms" extra={<span className="dim">{p.cursor.length ? `${clicks.length} clicks found` : "cursor not found"}</span>}>
            <button className="btn block" disabled={!clickZooms.length} onClick={() => addZooms(clickZooms, true)}>Add {clickZooms.length} zooms on clicks</button>
          </Field>
          <Field label="Activity zooms">
            <button className="btn block" disabled={!zooms.length} onClick={() => addZooms(zooms, false)}>Add {zooms.length} zooms where things change</button>
          </Field>
          <Field label="Speed for idle and typing parts">
            <Segmented value={speed} onChange={setSpeed} options={[2, 4, 8].map((v) => ({ value: v, label: `${v}x` }))} />
          </Field>
          <Field label="Idle parts">
            <button className="btn block" disabled={!idle.length} onClick={() => speedUp(idle)}>Speed up {idle.length} idle parts</button>
          </Field>
          <Field label="Typing parts">
            <button className="btn block" disabled={!typing.length} onClick={() => speedUp(typing)}>Speed up {typing.length} typing parts</button>
          </Field>
        </>
      )}
      <div className="divider" />
      <button className="btn block" disabled={!p.zooms.length} onClick={() => update((x) => ({ ...x, zooms: [] }))}><Trash2 size={15} /> Remove all zooms</button>
    </>
  );
}

function PresetsPanel({ api }: { api: EditorApi }) {
  const { p, update } = api;
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = (patch: Partial<Prefs>) => setPrefs(savePrefs(patch));
  const apply = (style: Style) => update((x) => ({ ...x, ...structuredClone(style) }));
  return (
    <>
      <h3>Presets</h3>
      <p className="muted" style={{ lineHeight: 1.5, marginTop: -6 }}>A preset stores the look: background, frame, camera and captions style. Presets are kept in this browser only.</p>
      <button className="btn primary block" style={{ marginBottom: 18 }} onClick={() => {
        const name = prompt("Preset name", `Preset ${prefs.presets.length + 1}`);
        if (name) save({ presets: [...prefs.presets.filter((x) => x.name !== name), { name, style: styleOf(p) }] });
      }}>Save current look as preset</button>
      <div className="field">
        {prefs.presets.length === 0 && <span className="dim">No presets yet.</span>}
        {prefs.presets.map((pr) => (
          <div key={pr.name} className="row" style={{ marginBottom: 6 }}>
            <button className="btn grow" style={{ justifyContent: "flex-start" }} onClick={() => apply(pr.style)}>{pr.name}</button>
            <button className="icon-btn" title="Delete preset" onClick={() => save({ presets: prefs.presets.filter((x) => x.name !== pr.name) })}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <div className="row field">
        <button className="btn grow" disabled={!prefs.presets.length} onClick={() => download(new Blob([JSON.stringify(prefs.presets, null, 2)], { type: "application/json" }), "openstudio-presets.json")}><Download size={15} /> Share</button>
        <button className="btn grow" onClick={() => fileRef.current!.click()}><Upload size={15} /> Import</button>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const incoming = JSON.parse(await f.text()) as Prefs["presets"];
          if (!Array.isArray(incoming) || incoming.some((x) => typeof x.name !== "string" || typeof x.style !== "object")) throw new Error("This file is not an OpenStudio presets file");
          const names = new Set(incoming.map((x) => x.name));
          save({ presets: [...prefs.presets.filter((x) => !names.has(x.name)), ...incoming.map((x) => ({ name: x.name, style: normalizeStyle(x.style) }))] });
        }} />
      </div>
      <div className="divider" />
      <Toggle label="Use the last look for new recordings" value={prefs.useLastStyle} onChange={(useLastStyle) => save({ useLastStyle })} />
      <button className="btn block" onClick={() => apply(DEFAULT_STYLE)}>Reset look to default</button>
    </>
  );
}

export default function Inspector(props: { api: EditorApi; tab: Tab; deleteSelected: () => void }) {
  const { api, tab } = props;
  return (
    <div className="inspector">
      {api.sel ? (
        <SelectionPanel api={api} deleteSelected={props.deleteSelected} />
      ) : (
        <>
          {tab === "background" && <BackgroundPanel api={api} />}
          {tab === "camera" && <CameraPanel api={api} />}
          {tab === "captions" && <CaptionsPanel api={api} />}
          {tab === "audio" && <AudioPanel api={api} />}
          {tab === "smart" && <SmartPanel api={api} />}
          {tab === "layouts" && <PresetsPanel api={api} />}
        </>
      )}
    </div>
  );
}
