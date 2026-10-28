/** A kept piece of the source recording, in source seconds, played at `speed` with a volume multiplier. */
export type Segment = { id: string; start: number; end: number; speed: number; volume: number };

/**
 * A zoom on the composition. Like every timeline effect, times are in source seconds so effects stay
 * attached to their content when clips are cut or sped up. Focus point is normalized to the output canvas.
 */
export type ZoomRegion = {
  id: string;
  start: number;
  end: number;
  scale: number;
  x: number;
  y: number;
  /** Jump straight to the zoomed view, without the eased transition. */
  instant: boolean;
  /** Follow the detected cursor instead of the fixed focus point. */
  follow: boolean;
};

/** Detected cursor position: source seconds, coordinates normalized to the full source video frame. */
export type CursorSample = { t: number; x: number; y: number };

export type MaskKind = "blur" | "pixelate" | "highlight";

/** A masked area of the screen recording, in source seconds. `rect` is normalized to the (cropped) screen frame. */
export type MaskRegion = { id: string; start: number; end: number; kind: MaskKind; rect: Rect; strength: number };

export type CameraLayout = "hidden" | "fullscreen" | "side";

/** Overrides the default camera bubble during a time range, in source seconds. */
export type CameraLayoutRegion = { id: string; start: number; end: number; layout: CameraLayout };

/** A transcribed caption chunk, in source seconds (so cuts and speed changes keep it aligned). */
export type Caption = { id: string; start: number; end: number; text: string };

export type CaptionStyle = {
  enabled: boolean;
  /** Font size as a fraction of the canvas short side. */
  size: number;
  /** Vertical center, normalized. */
  y: number;
};

export type Music = { url: string; name: string; volume: number; fade: boolean };

/** Preset ratios, "auto" (match the recording) or "custom" (an exact pixel size, see `Style.customSize`). */
export type Aspect = "wide" | "vertical" | "square" | "classic" | "tall" | "auto" | "custom";

/** A preset ratio, as opposed to "auto" and "custom". */
export type PresetAspect = Exclude<Aspect, "auto" | "custom">;

export type Rect = { x: number; y: number; w: number; h: number };

export type BackgroundKind = "wallpaper" | "gradient" | "color" | "image";

export type Background = {
  kind: BackgroundKind;
  wallpaper: number;
  gradient: { from: string; to: string; angle: number };
  color: string;
  image: string | null;
  blur: number;
};

/**
 * Part of the camera image shown in the bubble: the largest area with `aspect` (width / height, null = the
 * camera's own ratio) that fits the frame, shrunk by `zoom` and centered on (x, y), normalized to the camera frame.
 */
export type CameraCrop = { aspect: number | null; zoom: number; x: number; y: number };

export type CameraCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CameraSettings = {
  visible: boolean;
  /** Corner the bubble is anchored to. */
  corner: CameraCorner;
  /** Gap between the bubble and both canvas edges, as a fraction of the canvas short side. */
  margin: number;
  /** Bubble height as a fraction of the output canvas short side. */
  size: number;
  /** Sets the bubble's aspect ratio and framing. */
  crop: CameraCrop;
  /** Corner radius, 0 (sharp) to 1 (fully round: a circle when the crop is square). */
  roundness: number;
  mirror: boolean;
  shadow: number;
  border: number;
  /** Shrink the bubble while a zoom is active, like Screen Studio does. */
  shrinkOnZoom: boolean;
};

/** Look & feel settings, shareable as presets. */
export type Style = {
  aspect: Aspect;
  /** Output size in pixels used when `aspect` is "custom". */
  customSize: { w: number; h: number };
  background: Background;
  /** Fraction of the canvas short side. */
  padding: number;
  /** Corner radius as a fraction of the frame short side. */
  radius: number;
  shadow: number;
  /** Thin light border drawn inside the frame edge, in px at 1080p. */
  inset: number;
  camera: CameraSettings;
  captionStyle: CaptionStyle;
  /** How fast zooms animate in and out. */
  zoomSpeed: ZoomSpeed;
  /** Motion blur strength applied on export while the view moves, 0 = off. */
  motionBlur: number;
  /** Fill the canvas with the screen even when aspect ratios differ (e.g. vertical videos), panning to the focus. */
  keepZoomedIn: boolean;
};

export type ZoomSpeed = "slow" | "mellow" | "quick" | "rapid";

export type Project = Style & {
  name: string;
  segments: Segment[];
  zooms: ZoomRegion[];
  masks: MaskRegion[];
  cameraLayouts: CameraLayoutRegion[];
  captions: Caption[];
  /** Normalized crop of the screen source. */
  crop: Rect;
  volume: number;
  muted: boolean;
  music: Music | null;
  /** Cursor path detected from the pixels of the recording, sorted by time. Empty until analyzed. */
  cursor: CursorSample[];
};

export type Recording = {
  screen: Blob;
  screenUrl: string;
  camera: Blob | null;
  cameraUrl: string | null;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Moments flagged while recording, in source seconds. */
  flags: number[];
};
