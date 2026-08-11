import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import wordsRaw from "./data/words.txt?raw";
import { buildCorpus } from "./core/words";
import { SkillModel } from "./core/model";
import { generateLine, DEFAULT_OPTIONS } from "./core/generator";
import type { CharResult, LineResult } from "./core/capture";
import { lineStats, type LineStats } from "./core/wpm";
import {
  currentLevel,
  dominantClass,
  gaps,
  instruct,
  nextStandard,
  phaseAt,
  type Instruction,
  type PhaseState,
} from "./core/coach";
import * as persist from "./core/persist";
import { DrillScreen } from "./ui/DrillScreen";
import { Standing } from "./ui/Standing";
import { CoachBar } from "./ui/CoachBar";

type Tab = "practice" | "standing";

export default function App() {
  const corpus = useMemo(() => buildCorpus(wordsRaw), []);
  const modelRef = useRef(new SkillModel());
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("practice");
  const [sessions, setSessions] = useState<persist.SessionRecord[]>([]);
  const [modelVersion, setModelVersion] = useState(0);
  /** lines completed in this sitting — drives the shape of the session */
  const [lineIndex, setLineIndex] = useState(0);
  const [line, setLine] = useState<string | null>(null);
  const [lastStats, setLastStats] = useState<LineStats | null>(null);
  const activeTargets = useRef<string[]>([]);

  // console/automation access to the full dataset
  useEffect(() => {
    (window as unknown as { dumpData: () => Promise<string> }).dumpData = persist.exportAll;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedModel, savedSessions] = await Promise.all([
          persist.loadModel(),
          persist.getSessions(),
        ]);
        if (cancelled) return;
        if (savedModel) modelRef.current = SkillModel.deserialize(savedModel);
        setSessions(savedSessions);
        setReady(true);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** What the coach wants from this line. */
  const { phaseState, instruction } = useMemo(() => {
    const ps: PhaseState = phaseAt(lineIndex);
    const level = currentLevel(modelRef.current, corpus.engFreq);
    const tier = nextStandard(level?.wpm ?? null);
    const ranked = gaps(modelRef.current, corpus.engFreq, tier);
    const ins: Instruction = instruct(ps, ranked, dominantClass(ranked));
    return { phaseState: ps, instruction: ins };
    // modelVersion keeps the coach's picture current as you type
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineIndex, corpus, modelVersion]);

  // build the next line whenever the coach's instruction changes
  useEffect(() => {
    if (!ready) return;
    activeTargets.current = instruction.targets;
    setLine(
      generateLine(corpus, instruction.targets, {
        ...DEFAULT_OPTIONS,
        lineLength: instruction.lineLength,
        targetDensity: instruction.density,
      }).text,
    );
  }, [ready, instruction, corpus]);

  const recordIntoModel = useCallback((text: string, chars: CharResult[]) => {
    const model = modelRef.current;
    for (let i = 1; i < chars.length; i++) {
      const bigram = text[i - 1] + text[i];
      const c = chars[i];
      if (c.errors > 0) model.recordErrors(bigram, c.errors);
      if (c.timed) model.recordSample(bigram, c.iki, c.rollover);
      else model.recordUntimed(bigram);
    }
  }, []);

  const onLineComplete = useCallback(
    (result: LineResult) => {
      recordIntoModel(result.line, result.chars);
      const stats = lineStats(result);
      setLastStats(stats);
      const rec: persist.SessionRecord = {
        time: Date.now(),
        ms: Math.max(0, result.endTime - result.startTime),
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        rolloverRate: stats.rolloverRate,
        consistency: stats.consistency,
        chars: result.line.length,
        errors: result.totalErrors,
        targets: activeTargets.current,
        mode: instruction.phase,
      };
      setSessions((prev) => [...prev, rec]);
      void persist.addSession(rec);
      void persist.saveModel(modelRef.current.serialize());
      setModelVersion((v) => v + 1);
      setLineIndex((i) => i + 1);
    },
    [recordIntoModel, instruction.phase],
  );

  const onExport = useCallback(async () => {
    const json = await persist.exportAll();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `typing-trainer-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const onReset = useCallback(() => {
    if (!window.confirm("Delete all typing data and start fresh? This cannot be undone.")) return;
    indexedDB.deleteDatabase("typing-trainer");
    location.reload();
  }, []);

  const minutesToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = sessions.filter((s) => s.time >= start.getTime()).reduce((a, s) => a + s.ms, 0);
    return Math.round(ms / 60000);
  }, [sessions]);

  return (
    <>
      <div className="header">
        <span className="brand">
          <span className="dot" />
          typing trainer
        </span>
        <div className="nav">
          <button className={tab === "practice" ? "active" : ""} onClick={() => setTab("practice")}>
            Practice
          </button>
          <button className={tab === "standing" ? "active" : ""} onClick={() => setTab("standing")}>
            Standing
          </button>
        </div>
        <div className="spacer" />
      </div>

      {loadError ? (
        <div className="hint">
          {loadError}
          <div style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      ) : !ready || line === null ? (
        <div className="hint">loading…</div>
      ) : tab === "practice" ? (
        <>
          <CoachBar
            instruction={instruction}
            phaseState={phaseState}
            minutesToday={minutesToday}
          />
          <DrillScreen lineText={line} last={lastStats} onLineComplete={onLineComplete} />
        </>
      ) : (
        <Standing
          key={modelVersion}
          model={modelRef.current}
          sessions={sessions}
          corpus={corpus}
          onExport={onExport}
          onReset={onReset}
        />
      )}
    </>
  );
}
