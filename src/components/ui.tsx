import { useEffect, useRef, useState, type ReactNode } from "react";

export function Slider(props: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const { value, min, max, step = 0.01, onChange, format } = props;
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {format && <span className="muted mono" style={{ minWidth: 42, textAlign: "right", fontSize: 12 }}>{format(value)}</span>}
    </div>
  );
}

export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={String(o.value)} title={o.title} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { value: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
      <span>{props.label}</span>
      <button className={`toggle ${props.value ? "on" : ""}`} onClick={() => props.onChange(!props.value)} aria-pressed={props.value} />
    </div>
  );
}

export function Field(props: { label: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>
        <span>{props.label}</span>
        {props.extra}
      </label>
      {props.children}
    </div>
  );
}

/** A button that opens a floating menu below it. */
export function Dropdown(props: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {props.trigger(() => setOpen((o) => !o))}
      {open && (
        <div className="menu" style={{ top: "calc(100% + 6px)", [props.align === "right" ? "right" : "left"]: 0 }}>
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function formatTime(t: number, withMs = true): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}${withMs ? `.${String(cs).padStart(2, "0")}` : ""}`;
}

export function Modal(props: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ width: props.width }}>{props.children}</div>
    </div>
  );
}

/** Copy the page styles into a floating Picture-in-Picture window. */
export function adoptStyles(win: Window) {
  for (const node of document.querySelectorAll("style, link[rel=stylesheet]")) win.document.head.appendChild(node.cloneNode(true));
  win.document.body.style.margin = "0";
}
