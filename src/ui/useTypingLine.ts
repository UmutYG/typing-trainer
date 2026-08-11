import { useEffect, useRef, useState } from "react";
import { CaptureEngine, type LineResult } from "../core/capture";

/**
 * Shared typing loop: binds window keydown/keyup to a CaptureEngine for the
 * given line. Both the practice drill and the speed test run on this.
 */
export function useTypingLine(
  lineText: string,
  onComplete: (result: LineResult) => void,
  enabled = true,
): { pos: number; err: boolean; engine: CaptureEngine } {
  const engineRef = useRef<CaptureEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CaptureEngine();
  const [pos, setPos] = useState(0);
  const [err, setErr] = useState(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    const eng = engineRef.current!;
    eng.setLine(lineText);
    setPos(0);
    setErr(false);
    eng.onProgress = (p, errorAtPos) => {
      setPos(p);
      setErr(errorAtPos);
    };
    eng.onComplete = (r) => completeRef.current(r);
  }, [lineText]);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat) return;
      if (e.key === " " || e.key.length === 1) e.preventDefault();
      engineRef.current?.feed({ type: "down", key: e.key, code: e.code, time: performance.now() });
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

  return { pos, err, engine: engineRef.current };
}
