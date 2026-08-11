import { useEffect, useRef, useState } from "react";
import { CaptureEngine, type LineResult, type LineView } from "../core/capture";

const emptyView = (): LineView => ({ pos: 0, typed: [], wrong: [], fixing: false });

/**
 * Shared typing loop: binds window keydown/keyup to a CaptureEngine for the
 * given line.
 */
export function useTypingLine(
  lineText: string,
  onComplete: (result: LineResult) => void,
  requireCorrection = false,
  enabled = true,
): { view: LineView; engine: CaptureEngine } {
  const engineRef = useRef<CaptureEngine | null>(null);
  if (!engineRef.current) engineRef.current = new CaptureEngine();
  const [view, setView] = useState<LineView>(emptyView);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    const eng = engineRef.current!;
    eng.setLine(lineText, { requireCorrection });
    setView(eng.view());
    eng.onProgress = (v) => setView(v);
    eng.onComplete = (r) => completeRef.current(r);
  }, [lineText, requireCorrection]);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat && e.key !== "Backspace") return;
      // backspace would navigate back / space would scroll
      if (e.key === " " || e.key === "Backspace" || e.key.length === 1) e.preventDefault();
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

  return { view, engine: engineRef.current };
}
