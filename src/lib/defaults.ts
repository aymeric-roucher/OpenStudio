import type { Project, Recording, Style } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10);

export const DEFAULT_STYLE: Style = {
  aspect: "wide",
  background: {
    kind: "wallpaper",
    wallpaper: 0,
    gradient: { from: "#7c5cff", to: "#ff6ec7", angle: 135 },
    color: "#1b1b22",
    image: null,
    blur: 0,
  },
  padding: 0.08,
  radius: 0.025,
  shadow: 0.6,
  inset: 1,
  camera: { visible: true, x: 0.12, y: 0.8, size: 0.28, shape: "rounded", mirror: true, shadow: 0.6, border: 0, shrinkOnZoom: true },
  captionStyle: { enabled: true, size: 0.045, y: 0.88 },
  zoomSpeed: "mellow",
  motionBlur: 0.5,
  keepZoomedIn: false,
};

export function defaultProject(rec: Recording, style: Style): Project {
  return {
    ...structuredClone(style),
    name: `Recording ${new Date().toLocaleString()}`,
    segments: [{ id: uid(), start: 0, end: rec.duration, speed: 1, volume: 1 }],
    zooms: [],
    masks: [],
    cameraLayouts: [],
    captions: [],
    crop: { x: 0, y: 0, w: 1, h: 1 },
    volume: 1,
    muted: false,
    music: null,
    cursor: [],
  };
}

export function styleOf(p: Project): Style {
  const { aspect, background, padding, radius, shadow, inset, camera, captionStyle, zoomSpeed, motionBlur, keepZoomedIn } = p;
  return structuredClone({ aspect, background, padding, radius, shadow, inset, camera, captionStyle, zoomSpeed, motionBlur, keepZoomedIn });
}
