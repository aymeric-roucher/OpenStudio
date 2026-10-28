import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions, ChevronDown, Clipboard, Command, Crop, Download, FilePlus2, LayoutTemplate, Music, Palette, Redo2, Sparkles, Undo2, Upload, Video, WandSparkles,
} from "lucide-react";
import { defaultProject, styleOf, uid } from "../lib/defaults";
import { useHistory } from "../lib/history";
import { ASPECTS, outputSize } from "../lib/layout";
import { download } from "../lib/media";
import { Player } from "../lib/player";
import { loadPrefs, savePrefs } from "../lib/prefs";
import { cameraState, frameRect, onTimeline, renderFrame, viewAt, type FrameSources } from "../lib/render";
import { freeSlot, outputDuration, outputSpanToSource, splitAt } from "../lib/timeline";
import type { Aspect, MaskRegion, Project, Recording, Rect, Style } from "../lib/types";
import { Dropdown } from "./ui";
import Timeline from "./Timeline";
import Inspector, { type Tab } from "./Inspector";
import { CommandMenu, CropModal, ExportDialog, type Action } from "./Dialogs";

export type Selection = { kind: "segment" | "zoom" | "mask" | "layout" | "caption"; id: string } | null;

export type EditorApi = {
  p: Project;
  rec: Recording;
  update: (fn: (p: Project) => Project, coalesce?: string) => void;
  player: Player;
  time: number;
  sel: Selection;
  setSel: (s: Selection) => void;
  notify: (msg: string) => void;
  /** Render the current frame into a canvas of the given long side, optionally overriding the project. */
  snapshot: (long: number, override?: Partial<Project>) => HTMLCanvasElement;
};

const TABS: { id: Tab; label: string; icon: typeof Palette }[] = [
  { id: "background", label: "Background", icon: Palette },
  { id: "camera", label: "Camera", icon: Video },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "audio", label: "Audio and music", icon: Music },
  { id: "smart", label: "Smart edits", icon: WandSparkles },
  { id: "layouts", label: "Presets", icon: LayoutTemplate },
];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not load the background image"));
    img.src = url;
  });
}

export default function Editor(props: { rec: Recording; initialStyle: Style; cropOnOpen: boolean; onNew: () => void }) {
  const { rec } = props;
  const h = useHistory(() => defaultProject(rec, props.initialStyle));
  const p = h.state;
  const [player] = useState(() => new Player(rec, p));
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [tab, setTab] = useState<Tab>("background");
  const [modal, setModal] = useState<"crop" | "export" | "command" | null>(props.cropOnOpen ? "crop" : null);
  const [quality, setQuality] = useState<1 | 0.5>(1);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 800, h: 450 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawn = useRef({ version: -1, project: null as Project | null, bg: null as HTMLImageElement | null, w: 0, h: 0 });

  useEffect(() => () => player.destroy(), [player]);
  useEffect(() => player.setProject(p), [p, player]);

  // Remember the look for the next recording.
  useEffect(() => {
    if (loadPrefs().useLastStyle) savePrefs({ lastStyle: styleOf(p) });
  }, [p]);

  useEffect(() => {
    if (p.background.kind !== "image" || !p.background.image) return setBgImage(null);
    let live = true;
    loadImage(p.background.image).then((img) => live && setBgImage(img));
    return () => {
      live = false;
    };
  }, [p.background.kind, p.background.image]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrapRef.current!);
    return () => ro.disconnect();
  }, []);

  const contentAspect = (p.crop.w * rec.width) / (p.crop.h * rec.height);
  const [ow, oh] = outputSize(p.aspect, 1920, contentAspect);
  const ratio = ow / oh;
  const display = box.w / box.h > ratio ? { w: box.h * ratio, h: box.h } : { w: box.w, h: box.w / ratio };
  const scale = Math.min(window.devicePixelRatio * quality, 1920 / Math.max(display.w, display.h));
  const cw = Math.round(display.w * scale);
  const ch = Math.round(display.h * scale);

  const sources = useCallback((): FrameSources | null => {
    if (player.screen.readyState < 2) return null;
    const cam = player.camera && player.camera.readyState >= 2 ? player.camera : null;
    return {
      screen: player.screen,
      screenW: player.screen.videoWidth,
      screenH: player.screen.videoHeight,
      camera: cam,
      cameraW: cam?.videoWidth ?? 0,
      cameraH: cam?.videoHeight ?? 0,
      bgImage,
    };
  }, [player, bgImage]);

  const imageNotReady = p.background.kind === "image" && !bgImage;

  // Render loop.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      player.tick();
      const c = canvasRef.current;
      const d = drawn.current;
      if (c && !imageNotReady && (d.version !== player.version || d.project !== p || d.bg !== bgImage || d.w !== cw || d.h !== ch)) {
        const src = sources();
        if (src) {
          if (c.width !== cw || c.height !== ch) Object.assign(c, { width: cw, height: ch });
          renderFrame(c.getContext("2d")!, cw, ch, p, src, player.time);
          drawn.current = { version: player.version, project: p, bg: bgImage, w: cw, h: ch };
        }
      }
      setTime(player.time);
      setPlaying(player.playing);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [player, p, bgImage, cw, ch, sources, imageNotReady]);

  const snapshot = useCallback(
    (long: number, override?: Partial<Project>) => {
      const proj = { ...p, ...override };
      const [w, hh] = outputSize(proj.aspect, long, contentAspect);
      const c = document.createElement("canvas");
      Object.assign(c, { width: w, height: hh });
      const src = sources();
      if (!src) throw new Error("The video is not ready yet");
      renderFrame(c.getContext("2d")!, w, hh, proj, src, player.time);
      return c;
    },
    [p, contentAspect, sources, player],
  );

  const duration = outputDuration(p.segments);
  const api: EditorApi = { p, rec, update: h.update, player, time, sel, setSel, notify: setNotice, snapshot };

  // ---------- actions ----------

  const togglePlay = () => (player.playing ? player.pause() : player.play());

  const split = () => {
    const before = p.segments.length;
    const next = splitAt(p.segments, player.time, uid);
    if (next.length === before) return setNotice("Too close to a cut to split here");
    h.update((x) => ({ ...x, segments: next }));
  };

  const addRegion = (kind: "zoom" | "mask" | "layout", at = player.time) => {
    const tl = onTimeline(p);
    const list = kind === "zoom" ? tl.zooms : kind === "mask" ? tl.masks : tl.cameraLayouts;
    const slot = freeSlot(list, at, kind === "zoom" ? 2.5 : 3, duration);
    if (!slot) return setNotice("No room here: move the playhead to an empty spot on that track");
    const id = uid();
    const [start, end] = outputSpanToSource(p.segments, slot[0], slot[1]);
    h.update((x) => {
      if (kind === "zoom") return { ...x, zooms: [...x.zooms, { id, start, end, scale: 2, x: 0.5, y: 0.5, instant: false, follow: false }] };
      if (kind === "mask") {
        const m: MaskRegion = { id, start, end, kind: "blur", rect: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, strength: 0.6 };
        return { ...x, masks: [...x.masks, m] };
      }
      return { ...x, cameraLayouts: [...x.cameraLayouts, { id, start, end, layout: "fullscreen" }] };
    });
    setSel({ kind, id });
  };

  const deleteSelected = () => {
    if (!sel) return;
    if (sel.kind === "segment" && p.segments.length === 1) return setNotice("Cannot delete the only clip. Split it first.");
    h.update((x) => {
      if (sel.kind === "segment") return { ...x, segments: x.segments.filter((s) => s.id !== sel.id) };
      if (sel.kind === "zoom") return { ...x, zooms: x.zooms.filter((s) => s.id !== sel.id) };
      if (sel.kind === "mask") return { ...x, masks: x.masks.filter((s) => s.id !== sel.id) };
      if (sel.kind === "layout") return { ...x, cameraLayouts: x.cameraLayouts.filter((s) => s.id !== sel.id) };
      return { ...x, captions: x.captions.filter((s) => s.id !== sel.id) };
    });
    setSel(null);
  };

  const copyFrame = async () => {
    const c = snapshot(1920);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the frame"))), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setNotice("Frame copied to clipboard");
  };

  const downloadRaw = () => {
    const base = p.name.replace(/[^\w\- ]+/g, "").trim() || "recording";
    download(rec.screen, `${base} screen.${rec.screen.type.includes("mp4") ? "mp4" : "webm"}`);
    if (rec.camera) download(rec.camera, `${base} camera.webm`);
  };

  const newRecording = () => {
    if (confirm("Start a new recording? This project is not saved and will be lost.")) props.onNew();
  };

  const actions: Action[] = [
    { id: "play", label: playing ? "Pause" : "Play", keys: "Space", run: togglePlay },
    { id: "split", label: "Split clip at playhead", keys: "C or S", run: split },
    { id: "zoom", label: "Add zoom at playhead", keys: "Z", run: () => addRegion("zoom") },
    { id: "mask", label: "Add blur or highlight mask", keys: "M", run: () => addRegion("mask") },
    { id: "layout", label: "Add camera layout change", keys: "L", run: () => addRegion("layout") },
    { id: "delete", label: "Delete selected item", keys: "⌫", run: deleteSelected },
    { id: "undo", label: "Undo", keys: "⌘Z", run: h.undo },
    { id: "redo", label: "Redo", keys: "⇧⌘Z", run: h.redo },
    { id: "crop", label: "Crop recording", keys: "R", run: () => setModal("crop") },
    { id: "copy", label: "Copy current frame as image", keys: "⌘C", run: copyFrame },
    { id: "export", label: "Export video", keys: "⌘E", run: () => setModal("export") },
    { id: "raw", label: "Download raw recording files", run: downloadRaw },
    { id: "start", label: "Go to start", keys: "Home", run: () => player.seek(0) },
    { id: "end", label: "Go to end", keys: "End", run: () => player.seek(duration) },
    ...TABS.map((t) => ({ id: `tab-${t.id}`, label: `Open ${t.label} settings`, run: () => { setSel(null); setTab(t.id); } })),
    ...(Object.keys(ASPECTS) as Exclude<Aspect, "auto">[]).map((a) => ({ id: `aspect-${a}`, label: `Aspect ratio: ${ASPECTS[a].label} ${ASPECTS[a].hint}`, run: () => h.update((x) => ({ ...x, aspect: a })) })),
    { id: "new", label: "New recording", run: newRecording },
  ];

  // ---------- keyboard ----------

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const run = (fn: () => unknown) => {
      e.preventDefault();
      fn();
    };
    if (mod && k === "k") return run(() => setModal("command"));
    if (modal) return;
    if (mod && k === "z") return run(e.shiftKey ? h.redo : h.undo);
    if (mod && k === "y") return run(h.redo);
    if (mod && k === "e") return run(() => setModal("export"));
    if (mod && k === "c" && !window.getSelection()?.toString()) return run(copyFrame);
    if (mod) return;
    if (k === " ") return run(togglePlay);
    if (k === "s" || k === "c") return run(split);
    if (k === "z") return run(() => addRegion("zoom"));
    if (k === "m") return run(() => addRegion("mask"));
    if (k === "l") return run(() => addRegion("layout"));
    if (k === "r") return run(() => setModal("crop"));
    if (k === "backspace" || k === "delete") return run(deleteSelected);
    if (k === "escape") return run(() => setSel(null));
    if (k === "home") return run(() => player.seek(0));
    if (k === "end") return run(() => player.seek(duration));
    if (k === "arrowleft") return run(() => player.seek(player.time - (e.shiftKey ? 1 : 1 / 30)));
    if (k === "arrowright") return run(() => player.seek(player.time + (e.shiftKey ? 1 : 1 / 30)));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- preview interactions ----------

  const view = viewAt(p, time, { W: ow, H: oh, screenW: rec.width, screenH: rec.height });
  const toDisplay = (x: number, y: number) => ({ x: ((x - view.x) / view.w) * display.w, y: ((y - view.y) / view.h) * display.h });
  const selZoom = sel?.kind === "zoom" ? p.zooms.find((z) => z.id === sel.id) : undefined;
  const selMask = sel?.kind === "mask" ? p.masks.find((m) => m.id === sel.id) : undefined;
  const frame = frameRect(p, ow, oh, rec.width, rec.height, time);

  const onPreviewDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const toComp = (ev: { clientX: number; clientY: number }) => ({
      x: view.x + ((ev.clientX - r.left) / r.width) * view.w,
      y: view.y + ((ev.clientY - r.top) / r.height) * view.h,
    });
    const drag = (onMove: (pt: { x: number; y: number }, ev: PointerEvent) => void) => {
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => onMove(toComp(ev), ev);
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    };
    const pt = toComp(e);
    if (selZoom) {
      const set = (q: { x: number; y: number }) =>
        h.update((x) => ({ ...x, zooms: x.zooms.map((z) => (z.id === selZoom.id ? { ...z, x: Math.min(Math.max(q.x, 0), 1), y: Math.min(Math.max(q.y, 0), 1) } : z)) }), `focus-${selZoom.id}`);
      set(pt);
      return drag(set);
    }
    if (player.camera && player.camera.videoWidth) {
      const cs = cameraState(p, ow, oh, player.camera.videoWidth / player.camera.videoHeight, time);
      const px = pt.x * ow, py = pt.y * oh;
      if (cs.alpha > 0.5 && px >= cs.rect.x && px <= cs.rect.x + cs.rect.w && py >= cs.rect.y && py <= cs.rect.y + cs.rect.h) {
        const dx = pt.x - p.camera.x, dy = pt.y - p.camera.y;
        return drag((q) => h.update((x) => ({ ...x, camera: { ...x.camera, x: Math.min(Math.max(q.x - dx, 0), 1), y: Math.min(Math.max(q.y - dy, 0), 1) } }), "camera-drag"));
      }
    }
  };

  /** Drag a mask rectangle (move, or resize from the bottom-right handle). */
  const onMaskDown = (e: React.PointerEvent, mode: "move" | "resize") => {
    if (!selMask) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, rect: selMask.rect };
    // Display pixels to normalized frame units.
    const fx = (frame.w / ow) * (display.w / view.w);
    const fy = (frame.h / oh) * (display.h / view.h);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / fx, dy = (ev.clientY - start.y) / fy;
      const r = start.rect;
      const next: Rect =
        mode === "move"
          ? { ...r, x: Math.min(Math.max(r.x + dx, 0), 1 - r.w), y: Math.min(Math.max(r.y + dy, 0), 1 - r.h) }
          : { ...r, w: Math.min(Math.max(r.w + dx, 0.03), 1 - r.x), h: Math.min(Math.max(r.h + dy, 0.03), 1 - r.y) };
      h.update((x) => ({ ...x, masks: x.masks.map((m) => (m.id === selMask.id ? { ...m, rect: next } : m)) }), `mask-rect-${selMask.id}`);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const maskBox = selMask && (() => {
    const a = toDisplay((frame.x + selMask.rect.x * frame.w) / ow, (frame.y + selMask.rect.y * frame.h) / oh);
    const b = toDisplay((frame.x + (selMask.rect.x + selMask.rect.w) * frame.w) / ow, (frame.y + (selMask.rect.y + selMask.rect.h) * frame.h) / oh);
    return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  })();

  const aspectLabel = useMemo(() => (p.aspect === "auto" ? { label: "Auto", hint: "source" } : ASPECTS[p.aspect]), [p.aspect]);

  return (
    <div className="editor">
      <div className="topbar">
        <div className="brand" style={{ fontSize: 14, marginRight: 6 }}><span className="brand-dot" /></div>
        <button className="icon-btn" title="New recording" onClick={newRecording}><FilePlus2 size={17} /></button>
        <button className="icon-btn" title="Download raw recording files" onClick={downloadRaw}><Download size={17} /></button>
        <div className="grow" />
        <input className="title-input" value={p.name} onChange={(e) => h.update((x) => ({ ...x, name: e.target.value }), "name")} />
        <div className="grow" />
        <button className="icon-btn" title="Command menu (⌘K)" onClick={() => setModal("command")}><Command size={17} /></button>
        <div className="vsep" />
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!h.canUndo} onClick={h.undo}><Undo2 size={17} /></button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!h.canRedo} onClick={h.redo}><Redo2 size={17} /></button>
        <div className="vsep" />
        <button className="btn ghost" onClick={() => { setSel(null); setTab("layouts"); }}><Sparkles size={15} /> Presets</button>
        <button className="btn primary" onClick={() => setModal("export")}><Upload size={15} /> Export</button>
      </div>

      <div className="workspace">
        <div className="preview-col">
          <div className="preview-bar">
            <Dropdown
              trigger={(toggle) => (
                <button className="btn ghost" onClick={toggle}>
                  <LayoutTemplate size={15} /> {aspectLabel.label} <span className="dim">{aspectLabel.hint}</span> <ChevronDown size={14} />
                </button>
              )}
            >
              {(close) => (
                <>
                  {(Object.keys(ASPECTS) as Exclude<Aspect, "auto">[]).map((a) => (
                    <button key={a} onClick={() => { h.update((x) => ({ ...x, aspect: a })); close(); }}>
                      {ASPECTS[a].label} <span className="hint">{ASPECTS[a].hint}</span>
                    </button>
                  ))}
                  <div className="sep" />
                  <button onClick={() => { h.update((x) => ({ ...x, aspect: "auto" })); close(); }}>Auto <span className="hint">match recording</span></button>
                </>
              )}
            </Dropdown>
            <button className="btn ghost" onClick={() => setModal("crop")}><Crop size={15} /> Crop</button>
            <div className="grow" />
            <button className="btn ghost" title="Copy current frame (⌘C)" onClick={copyFrame}><Clipboard size={15} /> Copy frame</button>
            <Dropdown
              align="right"
              trigger={(toggle) => (
                <button className="btn ghost" onClick={toggle}>Preview quality <span className="dim">{quality === 1 ? "Full" : "Half"}</span> <ChevronDown size={14} /></button>
              )}
            >
              {(close) => (
                <>
                  <button onClick={() => { setQuality(1); close(); }}>Full</button>
                  <button onClick={() => { setQuality(0.5); close(); }}>Half <span className="hint">faster</span></button>
                </>
              )}
            </Dropdown>
          </div>
          <div className="preview-wrap" ref={wrapRef}>
            <div style={{ position: "relative", width: display.w, height: display.h }}>
              <canvas ref={canvasRef} className="preview-canvas" style={{ width: display.w, height: display.h }} />
              <div
                style={{ position: "absolute", inset: 0, cursor: selZoom ? "crosshair" : "default" }}
                onPointerDown={onPreviewDown}
                onDoubleClick={togglePlay}
              >
                {selZoom && (() => {
                  const d = toDisplay(selZoom.x, selZoom.y);
                  return <div className="focus-dot" style={{ left: d.x, top: d.y }} />;
                })()}
                {maskBox && (
                  <div className="mask-box" style={maskBox} onPointerDown={(e) => onMaskDown(e, "move")}>
                    <div className="handle" style={{ right: -7, bottom: -7, cursor: "nwse-resize" }} onPointerDown={(e) => onMaskDown(e, "resize")} />
                  </div>
                )}
              </div>
              {selZoom && <div className="preview-hint">Click or drag on the preview to set where the zoom focuses</div>}
              {selMask && <div className="preview-hint">Drag the box to place the mask, drag its corner to resize</div>}
            </div>
          </div>
        </div>

        <div className="rail">
          {TABS.map((t) => (
            <button key={t.id} className={`icon-btn ${!sel && tab === t.id ? "active" : ""}`} title={t.label} onClick={() => { setSel(null); setTab(t.id); }}>
              <t.icon size={18} />
            </button>
          ))}
        </div>
        <Inspector api={api} tab={tab} deleteSelected={deleteSelected} />
      </div>

      <Timeline api={api} playing={playing} duration={duration} onTogglePlay={togglePlay} onSplit={split} onAdd={addRegion} />

      {modal === "crop" && <CropModal api={api} onClose={() => setModal(null)} />}
      {modal === "export" && <ExportDialog api={api} bgImage={bgImage} onClose={() => setModal(null)} />}
      {modal === "command" && <CommandMenu actions={actions} onClose={() => setModal(null)} />}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}
