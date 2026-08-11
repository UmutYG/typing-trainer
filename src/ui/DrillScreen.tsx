import { useEffect, useRef, useState } from "react";
import { CaptureEngine, type LineResult } from "../core/capture";
import { CLASS_LABELS, classifyTransition } from "../core/keyboard";
import type { LineStats } from "../core/wpm";

export interface LineFeedback {
  stats: LineStats;
  slowest: { bigram: string; iki: number }[];
}

interface Props {
  lineText: string;
  targets: string[];
  feedback: LineFeedback | null;
  onLineComplete: (result: LineResult) => void;
}

const show = (bg: string) => bg.replace(/ /g, "␣");

export function DrillScreen({ lineText, targets, feedback, onLineComplete }: Props) {
  const engineRef = useRef<CaptureEngine | null>(null);
  const [pos, setPos] = useState(0);
  const [err, setErr] = useState(false);
  const completeRef = useRef(onLineComplete);
  completeRef.current = onLineComplete;

  useEffect(() => {
    if (!engineRef.current) engineRef.current = new CaptureEngine();
    const eng = engineRef.current;
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
  }, []);

  return (
    <div className="drill">
      <div className="line-box">
        <div className="line" aria-label="text to type">
          <span className="done">{lineText.slice(0, pos)}</span>
          {pos < lineText.length && (
            <span className={"cur" + (err ? " err" : "")}>
              {lineText[pos] === " " ? " " : lineText[pos]}
            </span>
          )}
          <span className="todo">{lineText.slice(pos + 1)}</span>
        </div>
      </div>

      <div className="drill-meta">
        {feedback ? (
          <>
            <span className="line-result">
              <b>{feedback.stats.wpm.toFixed(0)}</b> wpm
            </span>
            <span className="line-result">
              <b>{(feedback.stats.accuracy * 100).toFixed(1)}</b>%
            </span>
            {feedback.slowest.length > 0 && <span className="meta-label">slowest</span>}
            {feedback.slowest.map((s) => {
              const cls = classifyTransition(s.bigram[0], s.bigram[1]);
              return (
                <span className="chip slow" key={s.bigram}>
                  <b>{show(s.bigram)}</b> {s.iki.toFixed(0)} ms
                  {cls && <span className="cls">{CLASS_LABELS[cls]}</span>}
                </span>
              );
            })}
          </>
        ) : (
          <span className="meta-label">start typing — the line adapts to you</span>
        )}
      </div>

      <div className="targets-row">
        <span className="meta-label">training</span>
        {targets.map((t) => (
          <span className="chip" key={t}>
            {show(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
