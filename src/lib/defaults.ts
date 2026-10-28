import type { CameraCorner, CameraSettings, Project, Recording, Style } from "./types";

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
  camera: { visible: true, corner: "bottom-right", margin: 0.04, size: 0.28, crop: { aspect: 1, zoom: 1, x: 0.5, y: 0.5 }, roundness: 0.45, mirror: true, shadow: 0.6, border: 0, shrinkOnZoom: true },
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

/** Camera shape presets: they only set the crop ratio and the roundness, which stay editable afterwards. */
export const CAMERA_PRESETS: Record<"circle" | "rounded" | "rectangle", Pick<CameraSettings, "crop" | "roundness">> = {
  circle: { crop: { aspect: 1, zoom: 1, x: 0.5, y: 0.5 }, roundness: 1 },
  rounded: { crop: { aspect: 1, zoom: 1, x: 0.5, y: 0.5 }, roundness: 0.44 },
  rectangle: { crop: { aspect: null, zoom: 1, x: 0.5, y: 0.5 }, roundness: 0.12 },
};

/** Corner closest to a normalized point. */
export const nearestCorner = (x: number, y: number): CameraCorner => `${y > 0.5 ? "bottom" : "top"}-${x > 0.5 ? "right" : "left"}`;

/** Camera settings as stored before corners existed: a free center point and other shape names. */
type LegacyCamera = { x: number; y: number; shape: "rounded" | "square" | "circle" };

/**
 * Bring a stored look (last look or preset, possibly saved by an older version) up to date:
 * missing settings get their defaults and the old free camera position snaps to its nearest corner.
 */
export function normalizeStyle(stored: Partial<Style>): Style {
  const { x, y, shape, ...raw } = (stored.camera ?? {}) as Partial<CameraSettings> & Partial<LegacyCamera>;
  const camera: CameraSettings = { ...DEFAULT_STYLE.camera, ...raw };
  if (x !== undefined && y !== undefined) camera.corner = nearestCorner(x, y);
  if (shape) Object.assign(camera, CAMERA_PRESETS[shape === "square" ? "rectangle" : shape]);
  return structuredClone({
    ...DEFAULT_STYLE,
    ...stored,
    background: { ...DEFAULT_STYLE.background, ...stored.background },
    captionStyle: { ...DEFAULT_STYLE.captionStyle, ...stored.captionStyle },
    camera,
  });
}
