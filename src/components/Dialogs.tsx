import { useEffect, useRef, useState } from "react";
import { Download, Search } from "lucide-react";
import { exportPlan, exportVideo, type ExportSettings } from "../lib/exporter";
import { download } from "../lib/media";
import type { Rect } from "../lib/types";
import type { EditorApi } from "./Editor";
import { Field, Modal, Segmented, formatTime } from "./ui";

export type Action = { id: string; label: string; keys?: string; run: () => unknown };

export function CommandMenu(props: { actions: Action[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = props.actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  const run = (a: Action | undefined) => {
    if (!a) return;
    props.onClose();
    a.run();
  };
  return (
    <Modal onClose={props.onClose} width={520}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Search size={16} className="muted" />
        <input
          autoFocus
          className="input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, list.length - 1));
            if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            if (e.key === "Enter") run(list[i]);
          }}
        />
      </div>
      <div className="menu" style={{ position: "static", boxShadow: "none", maxHeight: 360, overflowY: "auto" }}>
        {list.map((a, k) => (
          <button key={a.id} className={k === i ? "focus" : ""} onMouseEnter={() => setI(k)} onClick={() => run(a)}>
            {a.label}
            {a.keys && <span className="hint"><span className="kbd">{a.keys}</span></span>}
          </button>
        ))}
        {list.length === 0 && <div className="dim" style={{ padding: 10 }}>No matching command</div>}
      </div>
    </Modal>
  );
}

export function CropModal(props: { api: EditorApi; onClose: () => void }) {
  const { api } = props;
  const [rect, setRect] = useState<Rect>(api.p.crop);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const v = api.player.screen;
  const ratio = v.videoWidth / v.videoHeight;
  const W = Math.min(window.innerWidth * 0.8, 1100, window.innerHeight * 0.65 * ratio);
  const H = W / ratio;

  useEffect(() => {
    const c = canvasRef.current!;
    Object.assign(c, { width: v.videoWidth, height: v.videoHeight });
    c.getContext("2d")!.drawImage(v, 0, 0);
  }, [v]);

  const drag = (e: React.PointerEvent, mode: "move" | "tl" | "tr" | "bl" | "br") => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, r0 = rect;
    const MIN = 0.05;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / W, dy = (ev.clientY - y0) / H;
      let { x, y, w, h } = r0;
      if (mode === "move") {
        x = Math.min(Math.max(x + dx, 0), 1 - w);
        y = Math.min(Math.max(y + dy, 0), 1 - h);
      } else {
        if (mode === "tl" || mode === "bl") {
          const nx = Math.min(Math.max(x + dx, 0), x + w - MIN);
          w += x - nx;
          x = nx;
        } else w = Math.min(Math.max(w + dx, MIN), 1 - x);
        if (mode === "tl" || mode === "tr") {
          const ny = Math.min(Math.max(y + dy, 0), y + h - MIN);
          h += y - ny;
          y = ny;
        } else h = Math.min(Math.max(h + dy, MIN), 1 - y);
      }
      setRect({ x, y, w, h });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const handles: ["tl" | "tr" | "bl" | "br", object, string][] = [
    ["tl", { left: -7, top: -7 }, "nwse-resize"], ["tr", { right: -7, top: -7 }, "nesw-resize"],
    ["bl", { left: -7, bottom: -7 }, "nesw-resize"], ["br", { right: -7, bottom: -7 }, "nwse-resize"],
  ];

  return (
    <Modal onClose={props.onClose}>
      <h2>Crop recording</h2>
      <p className="muted" style={{ marginTop: -8 }}>Keep only the part of the screen that matters. Drag the box or its corners.</p>
      <div style={{ position: "relative", width: W, height: H, borderRadius: 8, overflow: "hidden", background: "#000" }}>
        <canvas ref={canvasRef} style={{ width: W, height: H, display: "block" }} />
        <div
          style={{ position: "absolute", left: rect.x * W, top: rect.y * H, width: rect.w * W, height: rect.h * H, border: "2px solid #fff", boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)", cursor: "move" }}
          onPointerDown={(e) => drag(e, "move")}
        >
          {handles.map(([k, pos, cursor]) => <div key={k} className="handle" style={{ ...pos, cursor }} onPointerDown={(e) => drag(e, k)} />)}
        </div>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <Segmented
          value={-1}
          onChange={(ratio: number) => {
            // Largest centered area with this pixel aspect ratio.
            const vw = v.videoWidth, vh = v.videoHeight;
            const w = Math.min(vw, vh * ratio), h = w / ratio;
            setRect({ x: (vw - w) / 2 / vw, y: (vh - h) / 2 / vh, w: w / vw, h: h / vh });
          }}
          options={[{ value: 16 / 9, label: "16:9" }, { value: 4 / 3, label: "4:3" }, { value: 1, label: "1:1" }, { value: 9 / 16, label: "9:16" }]}
        />
        <div className="grow" />
        {(["w", "h"] as const).map((k) => {
          const full = k === "w" ? v.videoWidth : v.videoHeight;
          const pos = k === "w" ? "x" : "y";
          return (
            <input
              key={k}
              className="input mono"
              type="number"
              style={{ width: 84 }}
              title={k === "w" ? "Width in pixels" : "Height in pixels"}
              value={Math.round(rect[k] * full)}
              onChange={(e) => {
                const size = Math.min(Math.max(Number(e.target.value) / full, 0.05), 1);
                setRect({ ...rect, [k]: size, [pos]: Math.min(rect[pos], 1 - size) });
              }}
            />
          );
        })}
        <span className="muted">px</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="grow" />
        <button className="btn ghost" onClick={() => setRect({ x: 0, y: 0, w: 1, h: 1 })}>Reset</button>
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn primary" onClick={() => { api.update((p) => ({ ...p, crop: rect })); props.onClose(); }}>Apply crop</button>
      </div>
    </Modal>
  );
}

const RESOLUTIONS = [{ value: 1280, label: "720p" }, { value: 1920, label: "1080p" }, { value: 2560, label: "1440p" }, { value: 3840, label: "4K" }];

export function ExportDialog(props: { api: EditorApi; bgImage: CanvasImageSource | null; onClose: () => void }) {
  const { api } = props;
  const [s, setS] = useState<ExportSettings>({ format: "mp4", long: 1920, fps: 60, quality: "high" });
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const plan = exportPlan(api.rec, api.p, s);
  const ext = s.format;
  const filename = `${api.p.name.replace(/[^\w\- ]+/g, "").trim() || "recording"}.${ext}`;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  const start = async () => {
    api.player.pause();
    abort.current = new AbortController();
    setProgress(0);
    const t0 = performance.now();
    const blob = await exportVideo(api.rec, api.p, props.bgImage, s, setProgress, abort.current.signal)
      .catch((e: unknown) => {
        // Cancelling is not an error.
        if (e instanceof DOMException && e.name === "AbortError") return null;
        throw e;
      })
      .finally(() => setProgress(null));
    if (!blob) return;
    setResult({ blob, url: URL.createObjectURL(blob), seconds: (performance.now() - t0) / 1000 });
  };

  const close = () => {
    abort.current?.abort();
    props.onClose();
  };

  return (
    <Modal onClose={close} width={520}>
      <h2>Export</h2>
      {result ? (
        <>
          {s.format === "gif" ? <img src={result.url} style={{ width: "100%", borderRadius: 8 }} /> : <video src={result.url} controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />}
          <p className="muted">{(result.blob.size / 1e6).toFixed(1)} MB, exported in {result.seconds.toFixed(1)} s.</p>
          <div className="row">
            <button className="btn" onClick={() => setResult(null)}>Change settings</button>
            <div className="grow" />
            <button className="btn primary" onClick={() => download(result.blob, filename)}><Download size={15} /> Download {ext.toUpperCase()}</button>
          </div>
        </>
      ) : (
        <>
          <Field label="Format">
            <Segmented value={s.format} onChange={(format) => setS({ ...s, format })} options={[{ value: "mp4", label: "MP4" }, { value: "webm", label: "WebM" }, { value: "gif", label: "GIF" }]} />
          </Field>
          <Field label="Resolution">
            <Segmented value={s.long} onChange={(long) => setS({ ...s, long })} options={RESOLUTIONS} />
          </Field>
          <Field label="Frame rate">
            <Segmented value={s.fps} onChange={(fps) => setS({ ...s, fps })} options={[24, 30, 60].map((v) => ({ value: v, label: `${v} fps` }))} />
          </Field>
          {s.format !== "gif" && (
            <Field label="Quality">
              <Segmented value={s.quality} onChange={(quality) => setS({ ...s, quality })} options={[{ value: "low", label: "Smaller file" }, { value: "medium", label: "Balanced" }, { value: "high", label: "Best quality" }]} />
            </Field>
          )}
          <p className="muted mono">{plan.width} × {plan.height} · {plan.fps} fps · {formatTime(plan.frames / plan.fps, false)}</p>
          {progress !== null ? (
            <div className="field">
              <span className="muted">Rendering… {Math.round(progress * 100)}%</span>
              <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
              <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>
            </div>
          ) : (
            <div className="row">
              <span className="dim">Rendered on your device. Nothing is uploaded.</span>
              <div className="grow" />
              <button className="btn primary" onClick={start}>Export</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
