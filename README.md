# OpenStudio

An open source, fully in-browser take on [Screen Studio](https://screen.studio): record your screen and camera, then polish the result with backgrounds, zooms, captions and a timeline editor. Everything runs locally in your browser. Nothing is uploaded, and projects are not saved yet: closing the tab discards the recording.

**Try it: https://aymeric-roucher.github.io/OpenStudio/**

Every push to `main` is tested, built and published there by GitHub Actions.

## Run it locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests for timeline, zoom, layout, captions, analysis
npm run build    # static site in dist/, host it anywhere (HTTPS needed for capture)
```

Best in a recent Chromium browser (Chrome, Edge, Arc, Brave). Firefox and Safari can record but lack some APIs (floating controls window, some export codecs).

## Features

**Recording**
- Record any screen, window or browser tab: you pick it in the browser's own share dialog. Crop it afterwards in the editor.
- Camera and microphone with device pickers, live preview and level meter. Drag the camera bubble to place it before recording, pick its shape and size.
- Optional system or tab audio, mixed with the microphone.
- Countdown before recording (off, 3, 5 or 10 seconds).
- Floating window that stays above other apps (Document Picture-in-Picture): live camera preview shaped like your bubble, timer, stop, pause and resume, restart, cancel, flag a moment (F), speaker notes. When sharing an entire screen the browser cannot hide this window from the capture, so the camera preview can be hidden with one click.
- Screen and camera are recorded as separate files, so the camera stays fully editable.
- Open an existing video file instead of recording (button or drag and drop).

**Editing**
- Timeline with a clip track (audio waveform), zoom track, mask track, camera layout track and caption track. Hover scrubbing, frame stepping, timeline zoom, recording flags on the ruler.
- Split (C), trim by dragging clip edges, delete clips, per-clip speed from 0.25x to 8x.
- Zooms (Z): smooth or instant, zoom level, focus point picked on the preview or in the panel.
- Masks (M): blur, pixelate, or highlight an area for a time range.
- Dynamic camera layouts (L): fullscreen camera, side by side (stacked on vertical canvases), or hidden for a section, with animated transitions. The bubble can shrink while zoomed in.
- Aspect ratios: 16:9, 9:16, 1:1, 4:3, 3:4, matching the recording, or a custom size in pixels (exported at exactly that size). Crop the recording.
- Background: 16 procedural wallpapers, gradients, solid colors, or your own image, with blur. Frame padding, roundness, shadow and inset border.
- Camera: anchored to a corner with an adjustable, equal distance from both edges (drag to snap to another corner). Crop sets the bubble ratio and framing, a roundness slider sets the corners, and Circle, Rounded and Rectangle are presets for both. Size, mirror, shadow, border.
- Captions generated on your device with Whisper (transformers.js, WebGPU when available), editable, with size and position.
- Audio: recording volume up to 200%, mute, background music with volume and fades.
- Smart edits: finds the mouse pointer in the recorded pixels, infers clicks, and adds zooms on clicks that follow the cursor. Also suggests zooms where the screen changes, and speeds up idle or typing sections.
- "Keep zoomed in": the screen fills vertical or square canvases and pans with the cursor.
- Undo and redo, command menu (Cmd+K), keyboard shortcuts, copy the current frame as an image.
- Presets for the look, stored in this browser, shareable as JSON. Optionally reuse the last look for new recordings.

**Export**
- MP4, WebM or GIF, 720p to 4K, 24 to 60 fps, three quality levels. Encoded with WebCodecs faster than real time, entirely on your device.
- Download the raw screen and camera recordings.

## Not possible in a browser

A web page cannot see the mouse or keyboard outside of itself, so these Screen Studio features have no equivalent here: cursor smoothing, cursor size and hiding, click sounds, keystroke overlays (click zooms are approximated from the pixels instead), camera reactions, and recording iPhone or iPad. Shareable links would need a server and are out of scope for a local-only app.
