# OpenStudio

An open source, fully in-browser take on [Screen Studio](https://screen.studio): record your screen and camera, then polish the result with backgrounds, zooms, captions and a timeline editor. Everything runs locally in your browser. Nothing is uploaded, and projects are not saved yet: closing the tab discards the recording.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for timeline, zoom, layout, captions, analysis
npm run build    # static site in dist/, host it anywhere (HTTPS needed for capture)
```

Best in a recent Chromium browser (Chrome, Edge, Arc, Brave). Firefox and Safari can record but lack some APIs (floating controls window, some export codecs).

## Features

**Recording**
- Record an entire screen, a window, a browser tab, or an area (record the screen, then crop).
- Camera and microphone with device pickers, live preview and level meter. Drag the camera bubble to place it before recording, pick its shape and size.
- Optional system or tab audio, mixed with the microphone.
- Countdown before recording (off, 3, 5 or 10 seconds).
- Floating controls window (Document Picture-in-Picture): timer, stop, pause and resume, restart, cancel, flag a moment (F), speaker notes.
- Screen and camera are recorded as separate files, so the camera stays fully editable.
- Open an existing video file instead of recording (button or drag and drop).

**Editing**
- Timeline with a clip track (audio waveform), zoom track, mask track, camera layout track and caption track. Hover scrubbing, frame stepping, timeline zoom, recording flags on the ruler.
- Split (S), trim by dragging clip edges, delete clips, per-clip speed from 0.25x to 8x.
- Zooms (Z): smooth or instant, zoom level, focus point picked on the preview or in the panel.
- Masks (M): blur, pixelate, or highlight an area for a time range.
- Dynamic camera layouts (L): fullscreen camera, side by side (stacked on vertical canvases), or hidden for a section, with animated transitions. The bubble can shrink while zoomed in.
- Aspect ratios: 16:9, 9:16, 1:1, 4:3, 3:4, or matching the recording. Crop the recording.
- Background: 16 procedural wallpapers, gradients, solid colors, or your own image, with blur. Frame padding, roundness, shadow and inset border.
- Camera: shape, size, position, mirror, shadow, border.
- Captions generated on your device with Whisper (transformers.js, WebGPU when available), editable, with size and position.
- Audio: recording volume up to 200%, mute, background music with volume and fades.
- Smart edits: pixel-based activity analysis suggests zooms where things happen, and speeds up idle or typing sections.
- Undo and redo, command menu (Cmd+K), keyboard shortcuts, copy the current frame as an image.
- Presets for the look, stored in this browser, shareable as JSON. Optionally reuse the last look for new recordings.

**Export**
- MP4, WebM or GIF, 720p to 4K, 24 to 60 fps, three quality levels. Encoded with WebCodecs faster than real time, entirely on your device.
- Download the raw screen and camera recordings.

## Not possible in a browser

A web page cannot see the mouse or keyboard outside of itself, so these Screen Studio features have no equivalent here: cursor smoothing, cursor size and hiding, click sounds, keystroke overlays, click-driven auto zoom (replaced by pixel analysis), camera reactions, and recording iPhone or iPad. Shareable links would need a server and are out of scope for a local-only app.
