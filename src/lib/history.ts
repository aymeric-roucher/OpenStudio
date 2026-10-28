import { useCallback, useRef, useState } from "react";

type H<T> = { past: T[]; present: T; future: T[] };

const COALESCE_MS = 700;
const LIMIT = 200;

/**
 * Undoable state. Successive updates sharing a `coalesce` key (e.g. a slider drag) become one undo step.
 */
export function useHistory<T>(initial: () => T) {
  const [h, setH] = useState<H<T>>(() => ({ past: [], present: initial(), future: [] }));
  const last = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });

  const update = useCallback((fn: (prev: T) => T, coalesce?: string) => {
    const now = performance.now();
    const merge = coalesce !== undefined && last.current.key === coalesce && now - last.current.at < COALESCE_MS;
    last.current = { key: coalesce ?? null, at: now };
    setH((cur) => {
      const next = fn(cur.present);
      if (next === cur.present) return cur;
      return merge ? { ...cur, present: next, future: [] } : { past: [...cur.past, cur.present].slice(-LIMIT), present: next, future: [] };
    });
  }, []);

  const undo = useCallback(() => {
    last.current.key = null;
    setH((cur) => (cur.past.length ? { past: cur.past.slice(0, -1), present: cur.past[cur.past.length - 1], future: [cur.present, ...cur.future] } : cur));
  }, []);

  const redo = useCallback(() => {
    last.current.key = null;
    setH((cur) => (cur.future.length ? { past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1) } : cur));
  }, []);

  return { state: h.present, update, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
