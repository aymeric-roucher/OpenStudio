import { DEFAULT_STYLE, normalizeStyle } from "./defaults";
import type { SurfaceKind } from "./recorder";
import type { Style } from "./types";

/** Small user preferences kept in localStorage. Projects themselves are never persisted. */
export type Prefs = {
  surface: SurfaceKind | "area";
  cameraId: string | null;
  micId: string | null;
  systemAudio: boolean;
  countdown: number;
  floatingControls: boolean;
  notes: string;
  useLastStyle: boolean;
  lastStyle: Style;
  presets: { name: string; style: Style }[];
};

const KEY = "openstudio.prefs.v1";

const DEFAULT_PREFS: Prefs = {
  surface: "monitor",
  cameraId: null,
  micId: null,
  systemAudio: false,
  countdown: 3,
  floatingControls: true,
  notes: "",
  useLastStyle: true,
  lastStyle: DEFAULT_STYLE,
  presets: [],
};

export function loadPrefs(): Prefs {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(DEFAULT_PREFS);
  const stored = JSON.parse(raw) as Partial<Prefs>;
  return {
    ...structuredClone(DEFAULT_PREFS),
    ...stored,
    lastStyle: normalizeStyle(stored.lastStyle ?? {}),
    presets: (stored.presets ?? []).map((p) => ({ name: p.name, style: normalizeStyle(p.style) })),
  };
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
