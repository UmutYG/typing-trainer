import { useCallback, useEffect, useRef, useState } from "react";
import type { CharResult, LineResult } from "../core/capture";
import type { TestRecord } from "../core/persist";
import { useTypingLine } from "./useTypingLine";

// dev override: ?testsec=10
const TEST_SECONDS = Number(new URLSearchParams(window.location.search).get("testsec")) || 60;

interface Props {
  nextPlainLine: () => string;
  onLineData: (text: string, chars: CharResult[]) => void;
  onDone: (rec: TestRecord) => void;
  bestWpm: number | null;
}

type Phase = "idle" | "run" | "done";

export function TestScreen({ nextPlainLine, onLineData, onDone, bestWpm }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [line, setLine] = useState(() => nextPlainLine());
  const [secondsLeft, setSecondsLeft] = useState(TEST_SECONDS);
  const [result, setResult] = useState<TestRecord | null>(null);
  const completedChars = useRef(0);
  const completedErrors = useRef(0);
  // best BEFORE this attempt — the prop updates as soon as the test is saved
  const bestAtStart = useRef(bestWpm);
  const timerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  const onComplete = useCallback(
    (r: LineResult) => {
      if (phaseRef.current === "done") return;
      completedChars.current += r.line.length;
      completedErrors.current += r.totalErrors;
      onLineData(r.line, r.chars);
      setLine(nextPlainLine());
    },
    [nextPlainLine, onLineData],
  );

  const { pos, err, engine } = useTypingLine(line, onComplete, phase !== "done");

  const finish = useCallback(() => {
    const partial = engine.snapshot();
    if (partial.chars.length > 0) onLineData(line.slice(0, partial.chars.length), partial.chars);
    const chars = completedChars.current + partial.chars.length;
    const errors = completedErrors.current + partial.totalErrors;
    const rec: TestRecord = {
      time: Date.now(),
      wpm: chars / 5 / (TEST_SECONDS / 60),
      accuracy: chars + errors > 0 ? chars / (chars + errors) : 1,
      chars,
      errors,
      seconds: TEST_SECONDS,
    };
    setResult(rec);
    setPhase("done");
    onDone(rec);
  }, [engine, line, onDone, onLineData]);

  // `finish` closes over the current line, so keep the timer pointing at the
  // latest version instead of re-arming (which would reset the clock)
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const clearTimers = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    timerRef.current = null;
    tickRef.current = null;
  };

  // first keystroke starts the clock
  useEffect(() => {
    if (phase !== "idle" || pos === 0) return;
    setPhase("run");
    const t0 = performance.now();
    timerRef.current = window.setTimeout(() => finishRef.current(), TEST_SECONDS * 1000);
    tickRef.current = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil(TEST_SECONDS - (performance.now() - t0) / 1000)));
    }, 250);
  }, [phase, pos]);

  useEffect(() => {
    if (phase === "done") clearTimers();
  }, [phase]);

  // unmount only
  useEffect(() => clearTimers, []);

  const restart = () => {
    bestAtStart.current = bestWpm;
    completedChars.current = 0;
    completedErrors.current = 0;
    setSecondsLeft(TEST_SECONDS);
    setResult(null);
    setLine(nextPlainLine());
    setPhase("idle");
  };

  if (phase === "done" && result) {
    const prevBest = bestAtStart.current;
    const isRecord = prevBest === null || result.wpm > prevBest;
    return (
      <div className="test-result">
        <div className="hero-num">{result.wpm.toFixed(0)}</div>
        <div className="hero-unit">words per minute</div>
        {isRecord && <div className="record-badge">new personal best</div>}
        <div className="test-substats">
          <span>
            <b>{(result.accuracy * 100).toFixed(1)}%</b> accuracy
          </span>
          <span>
            <b>{result.chars}</b> characters
          </span>
          {prevBest !== null && !isRecord && (
            <span>
              best <b>{prevBest.toFixed(0)}</b>
            </span>
          )}
        </div>
        <button className="btn primary" onClick={restart}>
          Go again
        </button>
      </div>
    );
  }

  return (
    <div className="drill">
      <div className="test-topbar">
        <span className={"timer" + (phase === "run" ? " live" : "")}>
          {phase === "idle" ? `${TEST_SECONDS}s — starts on your first key` : `${secondsLeft}s`}
        </span>
      </div>
      <div className="line-box">
        <div className="line" aria-label="text to type">
          <span className="done">{line.slice(0, pos)}</span>
          {pos < line.length && <span className={"cur" + (err ? " err" : "")}>{line[pos]}</span>}
          <span className="todo">{line.slice(pos + 1)}</span>
        </div>
      </div>
      <div className="drill-meta">
        <span className="meta-label">
          plain common words, no targeting — this is your official speed
        </span>
      </div>
    </div>
  );
}
