import { useEffect, useRef, useState } from "react";
import { CaptureEngine, type LineResult, type LineView } from "../core/capture";

const emptyView = (): LineView => ({ pos: 0, typed: [], wrong: [], fixing: false });

export interface Stream {
  view: LineView;
  engine: CaptureEngine;
  /** true from the first keystroke of a segment until it is reported */
  typing: boolean;
}

/**
 * Binds the keyboard to a single long-lived CaptureEngine. Unlike a per-passage
 * loop, the engine is never torn down: text is appended to it and the caret
 * simply keeps going, which is what makes the run continuous.
 */
export function useTypingStream(
  onSegment: (result: LineResult) => void,
  onKey?: (correct: boolean) => void,
  enabled = true,
): Stream {
  const engineRef = useRef<CaptureEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CaptureEngine();
  const [view, setView] = useState<LineView>(emptyView);
  const [typing, setTyping] = useState(false);
  const segmentRef = useRef(onSegment);
  segmentRef.current = onSegment;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  useEffect(() => {
    const eng = engineRef.current!;
    eng.onProgress = (v) => setView(v);
    eng.onComplete = (r) => {
      setTyping(false);
      segmentRef.current(r);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat && e.key !== "Backspace") return;
      // backspace would navigate back / space would scroll
      if (e.key === " " || e.key === "Backspace" || e.key.length === 1) e.preventDefault();
      const eng = engineRef.current!;
      if (e.key.length === 1) {
        const expected = eng.text[eng.position];
        keyRef.current?.(e.key === expected);
        setTyping(true);
      }
      eng.feed({ type: "down", key: e.key, code: e.code, time: performance.now() });
    };
    const up = (e: KeyboardEvent) => {
      engineRef.current?.feed({ type: "up", key: e.key, code: e.code, time: performance.now() });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [enabled]);

  return { view, engine: engineRef.current, typing };
}
