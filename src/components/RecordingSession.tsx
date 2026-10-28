import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { releaseCapture, SessionRecorder } from "../lib/recorder";
import { formatTime } from "./ui";
import type { StartRequest } from "./Setup";

type Result = { screen: Blob; camera: Blob | null; flags: number[] };

export default function RecordingSession(props: { req: StartRequest; onDone: (r: Result) => void; onCancel: () => void }) {
  const { req } = props;
  const [count, setCount] = useState(req.countdown);
  const [, setTick] = useState(0);
  const [flags, setFlags] = useState(0);
  const recRef = useRef<SessionRecorder | null>(null);
  const finishing = useRef(false);

  // Countdown, then start.
  useEffect(() => {
    if (count > 0) {
      const id = setTimeout(() => setCount((c) => c - 1), 1000);
      return () => clearTimeout(id);
    }
    if (!recRef.current) {
      recRef.current = new SessionRecorder(req.cap);
      recRef.current.start();
    }
  }, [count, req.cap]);

  // Refresh the timer display.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    req.pip?.close();
    const rec = recRef.current;
    if (!rec) {
      releaseCapture(req.cap);
      return props.onCancel();
    }
    props.onDone(await rec.stop());
  }, [props, req]);

  const cancel = () => {
    finishing.current = true;
    recRef.current?.discard();
    releaseCapture(req.cap);
    req.pip?.close();
    props.onCancel();
  };

  const restart = () => {
    recRef.current?.discard();
    recRef.current = null;
    setFlags(0);
    setCount(req.countdown || 3);
  };

  const togglePause = () => {
    const r = recRef.current!;
    if (r.paused) r.resume();
    else r.pause();
    setTick((t) => t + 1);
  };

  const flag = () => {
    recRef.current?.flag();
    setFlags((f) => f + 1);
  };

  // The browser's own "Stop sharing" button ends the display track.
  useEffect(() => {
    const track = req.cap.display.getVideoTracks()[0];
    track.addEventListener("ended", finish);
    return () => track.removeEventListener("ended", finish);
  }, [req.cap, finish]);

  // Closing the floating window finishes the recording, like Screen Studio's menu bar stop.
  useEffect(() => {
    if (!req.pip) return;
    const onHide = () => finish();
    req.pip.addEventListener("pagehide", onHide);
    return () => req.pip?.removeEventListener("pagehide", onHide);
  }, [req.pip, finish]);

  useEffect(() => {
    const targets = [window, ...(req.pip ? [req.pip] : [])];
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "f" || e.key === "F") flag();
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") finish();
    };
    targets.forEach((t) => t.addEventListener("keydown", onKey as EventListener));
    return () => targets.forEach((t) => t.removeEventListener("keydown", onKey as EventListener));
  });

  const rec = recRef.current;
  const counting = count > 0;
  const hud = (compact: boolean) => (
    <div className="rec-hud" style={compact ? { borderRadius: 12 } : undefined}>
      <span className={`rec-dot ${rec?.paused || counting ? "paused" : ""}`} style={{ marginLeft: 8 }} />
      <span className="rec-time">{counting ? `in ${count}…` : formatTime(rec?.elapsed() ?? 0, false)}</span>
      <button className="icon-btn" title="Stop and edit (Cmd/Ctrl+Shift+S)" onClick={finish} style={{ color: "var(--danger)" }}><Square size={16} fill="currentColor" /></button>
      <button className="icon-btn" title={rec?.paused ? "Resume" : "Pause"} onClick={togglePause} disabled={!rec}>{rec?.paused ? <Play size={16} /> : <Pause size={16} />}</button>
      <button className="icon-btn" title="Flag this moment (F)" onClick={flag} disabled={!rec}><Flag size={16} />{flags > 0 && <span style={{ fontSize: 11, marginLeft: 2 }}>{flags}</span>}</button>
      <button className="icon-btn" title="Restart recording" onClick={restart} disabled={!rec}><RotateCcw size={16} /></button>
      <button className="icon-btn" title="Cancel recording" onClick={cancel}><Trash2 size={16} /></button>
    </div>
  );

  return (
    <div className="rec-screen">
      {counting ? <div className="countdown" key={count}>{count}</div> : <div className="muted">Recording. Switch to what you want to capture.</div>}
      {hud(false)}
      {req.notes.trim() && <div className="notes">{req.notes}</div>}
      {req.pip &&
        createPortal(
          <div className="pip">
            {hud(true)}
            {req.notes.trim() && <div className="notes">{req.notes}</div>}
          </div>,
          req.pip.document.body,
        )}
    </div>
  );
}
