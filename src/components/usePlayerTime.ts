import { useEffect, useRef, useState } from "react";
import type { Player } from "../lib/player";

type PlayerState = { time: number; playing: boolean };

/**
 * Current time and play state of the player, as React state.
 * While playing, updates are limited to one every `throttleMs` (0: every frame), so only components that
 * truly need every frame (playhead, time readout) re-render that often. Pauses, seeks and play/pause changes
 * are always delivered at once.
 */
export function usePlayerTime(player: Player, throttleMs: number): PlayerState {
  const [state, setState] = useState<PlayerState>({ time: player.time, playing: player.playing });
  const current = useRef(state);
  useEffect(() => {
    let last = 0;
    return player.subscribe(() => {
      const prev = current.current;
      if (prev.time === player.time && prev.playing === player.playing) return;
      const now = performance.now();
      if (player.playing && prev.playing && now - last < throttleMs) return;
      last = now;
      current.current = { time: player.time, playing: player.playing };
      setState(current.current);
    });
  }, [player, throttleMs]);
  return state;
}
