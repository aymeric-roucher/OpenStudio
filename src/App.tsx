import { useEffect, useState } from "react";
import { X } from "lucide-react";
import Setup, { type StartRequest } from "./components/Setup";
import RecordingSession from "./components/RecordingSession";
import Editor from "./components/Editor";
import SiteFooter from "./components/SiteFooter";
import { loadRecording } from "./lib/media";
import { loadPrefs } from "./lib/prefs";
import type { Recording, Style } from "./lib/types";

type Phase =
  | { kind: "setup" }
  | { kind: "recording"; req: StartRequest }
  | { kind: "loading"; message: string }
  | { kind: "editor"; rec: Recording; style: Style };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const [error, setError] = useState<string | null>(null);

  // Surface every uncaught error to the user instead of failing silently.
  useEffect(() => {
    const onError = (e: ErrorEvent) => setError(e.message);
    const onRejection = (e: PromiseRejectionEvent) => setError(e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Recordings only live in memory: warn before losing them.
  useEffect(() => {
    if (phase.kind !== "editor" && phase.kind !== "recording") return;
    const onBefore = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [phase.kind]);

  const open = async (screen: Blob, camera: Blob | null, flags: number[], remux: boolean) => {
    setPhase({ kind: "loading", message: "Preparing your recording…" });
    const rec = await loadRecording(screen, camera, flags, remux);
    setPhase({ kind: "editor", rec, style: loadPrefs().lastStyle });
  };

  const run = (p: Promise<unknown>) =>
    p.catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setPhase({ kind: "setup" });
    });

  return (
    <>
      <div className="app-viewport">
        {phase.kind === "setup" && (
          <Setup
            onStart={(req) => setPhase({ kind: "recording", req })}
            onImport={(file) => run(open(file, null, [], false))}
          />
        )}
        {phase.kind === "recording" && (
          <RecordingSession
            req={phase.req}
            onDone={(r) => run(open(r.screen, r.camera, r.flags, true))}
            onCancel={() => setPhase({ kind: "setup" })}
          />
        )}
        {phase.kind === "loading" && (
          <div className="rec-screen">
            <div className="brand"><span className="brand-dot" /> OpenStudio</div>
            <div className="muted">{phase.message}</div>
          </div>
        )}
        {phase.kind === "editor" && (
          <Editor
            rec={phase.rec}
            initialStyle={phase.style}
            onNew={() => setPhase({ kind: "setup" })}
          />
        )}
      </div>
      <SiteFooter />
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}
    </>
  );
}
