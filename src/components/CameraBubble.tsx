import { useState, type CSSProperties, type PointerEvent } from "react";
import { cameraCropRect } from "../lib/render";
import type { CameraSettings } from "../lib/types";

/**
 * Live camera preview shaped like the final bubble: same crop, roundness and mirroring as the compositor.
 * Width follows from `height` and the crop ratio.
 */
export default function CameraBubble(props: {
  stream: MediaStream;
  cam: CameraSettings;
  height: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
}) {
  const { stream, cam, height } = props;
  const [camAspect, setCamAspect] = useState(16 / 9);
  const width = height * (cam.crop.aspect ?? camAspect);
  const crop = cameraCropRect(cam.crop, camAspect);
  return (
    <div
      className={props.className}
      title={props.title}
      onPointerDown={props.onPointerDown}
      style={{ ...props.style, position: props.style?.position ?? "relative", overflow: "hidden", width, height, borderRadius: (cam.roundness * Math.min(width, height)) / 2, flex: "none" }}
    >
      <div style={{ position: "absolute", inset: 0, transform: cam.mirror ? "scaleX(-1)" : undefined }}>
        <video
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
          autoPlay
          muted
          playsInline
          onLoadedMetadata={(e) => setCamAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
          style={{ position: "absolute", objectFit: "fill", maxWidth: "none", pointerEvents: "none", width: width / crop.w, height: height / crop.h, left: (-crop.x * width) / crop.w, top: (-crop.y * height) / crop.h }}
        />
      </div>
    </div>
  );
}
