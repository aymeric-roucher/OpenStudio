import { memo, useEffect, useRef, useState } from "react";
import { AudioWaveform, EyeOff, Rows3, SquareUser, Flag, Pause, Play, Plus, Scissors, SkipBack, SkipForward, ZoomIn } from "lucide-react";
import { audioPeaks } from "../lib/media";
import { freeSlot, moveRegion, outputSpanToSource, segmentOffsets, sourceRangeToOutput, trimEdge } from "../lib/timeline";
import { onTimeline } from "../lib/render";
import type { Project, Segment } from "../lib/types";
import type { EditorApi } from "./Editor";
import { Dropdown, formatTime, Slider } from "./ui";

const PAD = 20;
const TICKS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 8];

type RegionKind = "zoom" | "mask" | "layout";
type MenuItem = { label: string; run: () => void } | "sep";
type OpenMenu = (e: React.MouseEvent, items: MenuItem[]) => void;
type Span = { id: string; start: number; end: number };

/** Pointer drag that reports horizontal movement in seconds. */
function dragSeconds(e: React.PointerEvent, pps: number, onMove: (dt: number) => void, onEnd?: (moved: boolean) => void) {
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x0) > 3) moved = true;
    if (moved) onMove((ev.clientX - x0) / pps);
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    onEnd?.(moved);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

const Waveform = memo(function Waveform(props: { peaks: Float32Array; rate: number; seg: Segment; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const w = Math.max(1, Math.round(props.width));
    const h = 42;
    Object.assign(c, { width: w * 2, height: h * 2 });
    const ctx = c.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.fillStyle = "rgba(60, 30, 0, 0.9)";
    const { peaks, rate, seg } = props;
    for (let x = 0; x < w; x += 2) {
      const i = Math.floor((seg.start + (x / w) * (seg.end - seg.start)) * rate);
      const v = peaks[Math.min(i, peaks.length - 1)] ?? 0;
      const bh = Math.max(1, v * h * 0.8);
      ctx.fillRect(x, (h - bh) / 2, 1.2, bh);
    }
  }, [props]);
  return <canvas ref={ref} />;
});

function RegionTrack<T extends Span>(props: {
  api: EditorApi;
  kind: RegionKind;
  regions: T[];
  pps: number;
  duration: number;
  className: string;
  emptyLabel: string;
  addLabel: string;
  label: (r: T) => React.ReactNode;
  /** Store a region's new output span (converted back to source seconds by the caller). */
  setSpan: (id: string, start: number, end: number, coalesce: string) => void;
  onAdd: (kind: RegionKind, at: number) => void;
  menu: (r: T) => MenuItem[];
  openMenu: OpenMenu;
}) {
  const { api, kind, regions, pps, duration } = props;
  const [ghost, setGhost] = useState<[number, number] | null>(null);
  const tAt = (e: React.MouseEvent) => (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps;
  return (
    <div
      className="track"
      onMouseMove={(e) => setGhost(freeSlot(regions, Math.max(0, tAt(e)), kind === "zoom" ? 2.5 : 3, duration))}
      onMouseLeave={() => setGhost(null)}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("track-empty")) return;
        props.onAdd(kind, Math.max(0, tAt(e)));
        setGhost(null);
      }}
      style={{ marginLeft: PAD, marginRight: PAD }}
    >
      {regions.length === 0 && !ghost && <div className="track-empty">{props.emptyLabel}</div>}
      {ghost && (
        <div className="ghost-add" style={{ left: ghost[0] * pps, width: (ghost[1] - ghost[0]) * pps }}>
          <Plus size={12} /> {props.addLabel}
        </div>
      )}
      {regions.map((r) => {
        const selected = api.sel?.kind === kind && api.sel.id === r.id;
        const drag = (mode: "move" | "start" | "end") => (e: React.PointerEvent) => {
          if (e.button !== 0) return;
          api.setSel({ kind, id: r.id });
          dragSeconds(
            e,
            pps,
            (dt) => {
              const moved = moveRegion(regions, r.id, r.start + dt, r.end + dt, duration, mode).find((x) => x.id === r.id)!;
              props.setSpan(r.id, moved.start, moved.end, `${kind}-${mode}-${r.id}`);
            },
            (moved) => !moved && mode === "move" && api.player.seek(r.start + (e.clientX - (e.target as HTMLElement).getBoundingClientRect().left) / pps),
          );
        };
        return (
          <div
            key={r.id}
            className={`tl-block ${props.className} ${selected ? "selected" : ""}`}
            style={{ left: r.start * pps, width: Math.max(4, (r.end - r.start) * pps) }}
            onPointerDown={drag("move")}
            onMouseMove={(e) => e.stopPropagation()}
            onMouseEnter={() => setGhost(null)}
            onContextMenu={(e) => {
              api.setSel({ kind, id: r.id });
              props.openMenu(e, props.menu(r));
            }}
          >
            <div className="edge l" onPointerDown={drag("start")} />
            <span className="label">{props.label(r)}</span>
            <div className="edge r" onPointerDown={drag("end")} />
          </div>
        );
      })}
    </div>
  );
}

export default function Timeline(props: {
  api: EditorApi;
  playing: boolean;
  duration: number;
  onTogglePlay: () => void;
  onSplit: () => void;
  onAdd: (kind: RegionKind, at: number) => void;
}) {
  const { api, duration } = props;
  const { p, rec, player, time } = api;
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(1000);
  const [scrubber, setScrubber] = useState(true);
  const [peaks, setPeaks] = useState<{ peaks: Float32Array; rate: number } | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openMenu: OpenMenu = (e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);
  const remove = (key: "zooms" | "masks" | "cameraLayouts" | "segments", id: string) => () => {
    if (key === "segments" && p.segments.length === 1) return api.notify("Cannot delete the only clip. Split it first.");
    api.update((x) => ({ ...x, [key]: (x[key] as { id: string }[]).filter((r) => r.id !== id) }));
    api.setSel(null);
  };
  const patch = <K extends "zooms" | "masks" | "cameraLayouts" | "segments">(key: K, id: string, change: Partial<Project[K][number]>) => () =>
    api.update((x) => ({ ...x, [key]: (x[key] as { id: string }[]).map((r) => (r.id === id ? { ...r, ...change } : r)) }));
  const saved = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(scrollRef.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (rec.hasAudio) audioPeaks(rec.screen, 100).then(setPeaks);
  }, [rec]);

  const pps = ((width - PAD * 2) / Math.max(duration, 0.5)) * zoom;
  const inner = duration * pps + PAD * 2;
  const offsets = segmentOffsets(p.segments);
  const tick = TICKS.find((t) => t * pps >= 70) ?? 600;

  const timeAt = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - r.left + scrollRef.current!.scrollLeft - PAD) / pps, 0), duration);
  };

  // Hover scrubbing: preview the frame under the mouse while paused, restore on leave.
  const onHover = (e: React.MouseEvent) => {
    const t = timeAt(e.clientX);
    setHoverT(t);
    if (!scrubber || props.playing || e.buttons) return;
    if (saved.current === null) saved.current = player.time;
    player.seek(t);
  };
  const onLeave = () => {
    setHoverT(null);
    if (saved.current !== null) player.seek(saved.current);
    saved.current = null;
  };
  const commitSeek = (t: number) => {
    saved.current = null;
    player.seek(t);
  };

  const onRulerDown = (e: React.PointerEvent) => {
    commitSeek(timeAt(e.clientX));
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => commitSeek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  // Keep the playhead visible while playing.
  useEffect(() => {
    const el = scrollRef.current!;
    const x = PAD + time * pps;
    if (props.playing && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40)) el.scrollLeft = x - 60;
  }, [time, pps, props.playing]);

  const bounds = [0, ...offsets.slice(1), duration];
  const prevCut = () => commitSeek([...bounds].reverse().find((b) => b < time - 0.05) ?? 0);
  const nextCut = () => commitSeek(bounds.find((b) => b > time + 0.05) ?? duration);

  const selSeg = api.sel?.kind === "segment" ? p.segments.find((s) => s.id === api.sel!.id) : undefined;
  const setSpeed = (speed: number) => api.update((x) => ({ ...x, segments: x.segments.map((s) => (s.id === selSeg!.id ? { ...s, speed } : s)) }));

  const tl = onTimeline(p);
  const setSpan = (key: "zooms" | "masks" | "cameraLayouts") => (id: string, start: number, end: number, coalesce: string) => {
    const [a, b] = outputSpanToSource(p.segments, start, end);
    api.update((x) => ({ ...x, [key]: x[key].map((r) => (r.id === id ? { ...r, start: a, end: b } : r)) }), coalesce);
  };

  const flags = rec.flags.map((f) => sourceRangeToOutput(p.segments, f, f + 0.01)).filter((r): r is [number, number] => r !== null);
  const captions = p.captions
    .map((c) => ({ c, r: sourceRangeToOutput(p.segments, c.start, c.end) }))
    .filter((x): x is { c: typeof x.c; r: [number, number] } => x.r !== null);

  return (
    <div className="timeline">
      <div className="transport">
        <div className="left">
          <button className="icon-btn" title="Split clip at playhead (C)" onClick={props.onSplit}><Scissors size={17} /></button>
          <button className="icon-btn" title="Add zoom at playhead (Z)" onClick={() => props.onAdd("zoom", time)}><ZoomIn size={17} /></button>
          <button className="icon-btn" title="Add blur or highlight mask (M)" onClick={() => props.onAdd("mask", time)}><EyeOff size={17} /></button>
          {rec.camera && <button className="icon-btn" title="Add camera layout change (L)" onClick={() => props.onAdd("layout", time)}><SquareUser size={17} /></button>}
        </div>
        <div className="center">
          <span className="time">{formatTime(time)}</span>
          <button className="icon-btn" title="Previous cut" onClick={prevCut}><SkipBack size={17} /></button>
          <button className="icon-btn" title="Play or pause (Space)" onClick={props.onTogglePlay} style={{ width: 38, height: 38, color: "var(--text)" }}>
            {props.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button className="icon-btn" title="Next cut" onClick={nextCut}><SkipForward size={17} /></button>
          <span className="time">{formatTime(duration)}</span>
        </div>
        <div className="right">
          <button className={`icon-btn ${showAll ? "active" : ""}`} title="Show all tracks" onClick={() => setShowAll((v) => !v)}><Rows3 size={17} /></button>
          <button className={`icon-btn ${scrubber ? "active" : ""}`} title="Scrubber: preview frames by hovering the timeline" onClick={() => setScrubber((s) => !s)}><AudioWaveform size={17} /></button>
          <Dropdown
            align="right"
            trigger={(toggle) => (
              <button className="btn ghost small" title={selSeg ? "Speed of selected clip" : "Select a clip to change its speed"} disabled={!selSeg} onClick={toggle}>
                {selSeg ? `${selSeg.speed}x` : "1x"}
              </button>
            )}
          >
            {(close) => SPEEDS.map((s) => <button key={s} onClick={() => { setSpeed(s); close(); }}>{s}x {selSeg?.speed === s && <span className="hint">current</span>}</button>)}
          </Dropdown>
          <div style={{ width: 120 }}><Slider value={zoom} min={1} max={20} step={0.1} onChange={setZoom} /></div>
        </div>
      </div>

      <div className="tl-scroll" ref={scrollRef} onMouseMove={onHover} onMouseLeave={onLeave} onPointerDown={() => (saved.current = null)}>
        <div className="tl-inner" style={{ width: inner, padding: 0 }}>
          <div className="ruler" onPointerDown={onRulerDown} style={{ marginLeft: PAD, marginRight: PAD }}>
            {Array.from({ length: Math.floor(duration / tick) + 1 }, (_, i) => (
              <span key={i}>
                <span className="tick-label" style={{ left: i * tick * pps }}>{formatTime(i * tick, tick < 1)}</span>
                <span className="tick" style={{ left: (i + 0.5) * tick * pps }} />
              </span>
            ))}
            {flags.map(([t], i) => (
              <Flag key={i} className="flag-mark" style={{ left: t * pps }} size={12} fill="currentColor" />
            ))}
          </div>

          <div className="track" style={{ marginLeft: PAD, marginRight: PAD }}>
            {p.segments.map((s, i) => {
              const len = (s.end - s.start) / s.speed;
              const selected = api.sel?.kind === "segment" && api.sel.id === s.id;
              const trim = (edge: "start" | "end") => (e: React.PointerEvent) => {
                api.setSel({ kind: "segment", id: s.id });
                const v0 = s[edge];
                dragSeconds(e, pps, (dt) => api.update((x) => ({ ...x, segments: trimEdge(x.segments, s.id, edge, v0 + dt * s.speed, rec.duration) }), `trim-${edge}-${s.id}`));
              };
              return (
                <div
                  key={s.id}
                  className={`tl-block clip-block ${selected ? "selected" : ""}`}
                  style={{ left: offsets[i] * pps + 1, width: Math.max(4, len * pps - 2) }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    api.setSel({ kind: "segment", id: s.id });
                    commitSeek(timeAt(e.clientX));
                  }}
                  onContextMenu={(e) => {
                    api.setSel({ kind: "segment", id: s.id });
                    const at = timeAt(e.clientX);
                    openMenu(e, [
                      { label: "Split here", run: () => { commitSeek(at); props.onSplit(); } },
                      "sep",
                      ...SPEEDS.map((v) => ({ label: `Speed ${v}x${v === s.speed ? "  (current)" : ""}`, run: patch("segments", s.id, { speed: v }) })),
                      "sep",
                      { label: s.volume === 0 ? "Unmute clip" : "Mute clip", run: patch("segments", s.id, { volume: s.volume === 0 ? 1 : 0 }) },
                      { label: "Delete clip", run: remove("segments", s.id) },
                    ]);
                  }}
                >
                  {peaks && <Waveform peaks={peaks.peaks} rate={peaks.rate} seg={s} width={len * pps} />}
                  <div className="edge l" onPointerDown={trim("start")} />
                  <span className="label">
                    <small>Clip</small>
                    {len.toFixed(1)}s · {s.speed}x{s.volume !== 1 && ` · ${s.volume === 0 ? "muted" : `${Math.round(s.volume * 100)}%`}`}
                  </span>
                  <div className="edge r" onPointerDown={trim("end")} />
                </div>
              );
            })}
          </div>

          <RegionTrack
            api={api} kind="zoom" regions={tl.zooms} pps={pps} duration={duration} className="zoom-block"
            emptyLabel="Click to add a zoom" addLabel="Zoom"
            label={(z) => (<><small>Zoom</small>{z.scale.toFixed(1)}x · {z.follow ? "Follow" : z.instant ? "Instant" : "Smooth"}</>)}
            setSpan={setSpan("zooms")}
            onAdd={props.onAdd}
            openMenu={openMenu}
            menu={(z) => [
              { label: z.instant ? "Make it smooth" : "Make it instant", run: patch("zooms", z.id, { instant: !z.instant }) },
              ...[1.5, 2, 2.5, 3].map((v) => ({ label: `Zoom ${v}x`, run: patch("zooms", z.id, { scale: v }) })),
              "sep" as const,
              { label: "Delete zoom", run: remove("zooms", z.id) },
            ]}
          />
          {(tl.masks.length > 0 || showAll) && <RegionTrack
            api={api} kind="mask" regions={tl.masks} pps={pps} duration={duration} className="mask-block"
            emptyLabel="Click to add a blur or highlight" addLabel="Mask"
            label={(m) => (<><small>Mask</small>{m.kind}</>)}
            setSpan={setSpan("masks")}
            onAdd={props.onAdd}
            openMenu={openMenu}
            menu={(m) => [
              ...(["blur", "pixelate", "highlight"] as const).map((k) => ({ label: `Effect: ${k}`, run: patch("masks", m.id, { kind: k }) })),
              "sep" as const,
              { label: "Delete mask", run: remove("masks", m.id) },
            ]}
          />}
          {rec.camera && (tl.cameraLayouts.length > 0 || showAll) && (
            <RegionTrack
              api={api} kind="layout" regions={tl.cameraLayouts} pps={pps} duration={duration} className="layout-block"
              emptyLabel="Click to change the camera layout for a section" addLabel="Camera layout"
              label={(l) => (<><small>Camera</small>{l.layout}</>)}
              setSpan={setSpan("cameraLayouts")}
              onAdd={props.onAdd}
              openMenu={openMenu}
              menu={(l) => [
                ...([["fullscreen", "Camera fullscreen"], ["side", "Side by side"], ["hidden", "Hide camera"]] as const).map(([k, label]) => ({ label, run: patch("cameraLayouts", l.id, { layout: k }) })),
                "sep" as const,
                { label: "Delete layout change", run: remove("cameraLayouts", l.id) },
              ]}
            />
          )}
          {captions.length > 0 && (
            <div className="track small" style={{ marginLeft: PAD, marginRight: PAD }}>
              {captions.map(({ c, r }) => (
                <div
                  key={c.id}
                  className={`tl-block caption-block ${api.sel?.kind === "caption" && api.sel.id === c.id ? "selected" : ""}`}
                  style={{ left: r[0] * pps, width: Math.max(4, (r[1] - r[0]) * pps - 2) }}
                  title={c.text}
                  onPointerDown={() => {
                    api.setSel({ kind: "caption", id: c.id });
                    commitSeek(r[0]);
                  }}
                >
                  <span className="label" style={{ alignItems: "flex-start", overflow: "hidden" }}>{c.text}</span>
                </div>
              ))}
            </div>
          )}

          {menu && (
            <div className="menu" style={{ position: "fixed", left: menu.x, top: menu.y, transform: menu.y > window.innerHeight - 320 ? "translateY(-100%)" : undefined }} onPointerDown={(e) => e.stopPropagation()}>
              {menu.items.map((it, i) =>
                it === "sep" ? <div key={i} className="sep" /> : <button key={i} onClick={() => { setMenu(null); it.run(); }}>{it.label}</button>,
              )}
            </div>
          )}
          <div className="playhead" style={{ left: PAD + (saved.current ?? time) * pps }} />
          {hoverT !== null && <div className="hover-line" style={{ left: PAD + hoverT * pps }} />}
        </div>
      </div>
    </div>
  );
}
