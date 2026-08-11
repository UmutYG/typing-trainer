import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import wordsRaw from "./data/words.txt?raw";
import { buildCorpus } from "./core/words";
import { SkillModel } from "./core/model";
import { generateLine, type GeneratedLine } from "./core/generator";
import type { CharResult, LineResult } from "./core/capture";
import { lineStats } from "./core/wpm";
import { emptyGoalState, progressOf, refreshGoals, type GoalState, type Metrics } from "./core/goals";
import * as persist from "./core/persist";
import { DrillScreen, type LineFeedback } from "./ui/DrillScreen";
import { TestScreen } from "./ui/TestScreen";
import { Progress, goalNow, fmtGoalValue } from "./ui/Progress";
import { GoalBanner, type BannerGoal } from "./ui/GoalBanner";

type Tab = "practice" | "test" | "progress";

export default function App() {
  const corpus = useMemo(() => buildCorpus(wordsRaw), []);
  const modelRef = useRef(new SkillModel());
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("practice");
  const [line, setLine] = useState<GeneratedLine | null>(null);
  const [feedback, setFeedback] = useState<LineFeedback | null>(null);
  const [sessions, setSessions] = useState<persist.SessionRecord[]>([]);
  const [tests, setTests] = useState<persist.TestRecord[]>([]);
  const [goals, setGoals] = useState<GoalState>(emptyGoalState);
  const [toast, setToast] = useState<string | null>(null);
  const [modelVersion, setModelVersion] = useState(0);
  const toastTimer = useRef<number | null>(null);

  // console/automation access to the full dataset (model + sessions as JSON)
  useEffect(() => {
    (window as unknown as { dumpData: () => Promise<string> }).dumpData = persist.exportAll;
  }, []);

  const nextLine = useCallback(() => {
    const bns = modelRef.current.bottlenecks(corpus.engFreq, 8);
    setLine(generateLine(corpus, bns));
  }, [corpus]);

  const nextPlainLine = useCallback(() => generateLine(corpus, []).text, [corpus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [savedModel, savedSessions, savedTests, savedGoals] = await Promise.all([
          persist.loadModel(),
          persist.getSessions(),
          persist.getTests(),
          persist.loadGoals(),
        ]);
        if (cancelled) return;
        if (savedModel) modelRef.current = SkillModel.deserialize(savedModel);
        setSessions(savedSessions);
        setTests(savedTests);
        setGoals(savedGoals ?? emptyGoalState());
        setReady(true);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready && line === null) nextLine();
  }, [ready, line, nextLine]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }, []);

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

  const runGoals = useCallback(
    (sessionsNow: persist.SessionRecord[], testsNow: persist.TestRecord[]) => {
      const recent = sessionsNow.slice(-50);
      const metrics: Metrics = {
        bestTestWpm: testsNow.length > 0 ? Math.max(...testsNow.map((t) => t.wpm)) : null,
        testCount: testsNow.length,
        accuracy:
          recent.length >= 5 ? recent.reduce((a, s) => a + s.accuracy, 0) / recent.length : null,
        linesTyped: sessionsNow.length,
        pairStat: (bg) => {
          const s = modelRef.current.bigrams.get(bg);
          return s && s.count > 0 ? { mean: s.mean, count: s.count } : null;
        },
        bottlenecks: modelRef.current.bottlenecks(corpus.engFreq, 24).filter((b) => b.count >= 10),
      };
      setGoals((prev) => {
        const { state, newlyAchieved } = refreshGoals(prev, metrics);
        if (newlyAchieved.length > 0) showToast(newlyAchieved[0].label);
        void persist.saveGoals(state);
        return state;
      });
    },
    [corpus, showToast],
  );

  const onLineComplete = useCallback(
    (result: LineResult) => {
      recordIntoModel(result.line, result.chars);
      const stats = lineStats(result);
      setFeedback({ stats });

      const rec: persist.SessionRecord = {
        time: Date.now(),
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        rolloverRate: stats.rolloverRate,
        consistency: stats.consistency,
        chars: result.line.length,
        errors: result.totalErrors,
        targets: line?.targets ?? [],
        mode: "drill",
      };
      const sessionsNow = [...sessions, rec];
      setSessions(sessionsNow);
      void persist.addSession(rec);
      void persist.saveModel(modelRef.current.serialize());
      setModelVersion((v) => v + 1);
      runGoals(sessionsNow, tests);
      nextLine();
    },
    [line, sessions, tests, recordIntoModel, runGoals, nextLine],
  );

  const onTestLineData = useCallback(
    (text: string, chars: CharResult[]) => {
      recordIntoModel(text, chars);
      void persist.saveModel(modelRef.current.serialize());
      setModelVersion((v) => v + 1);
    },
    [recordIntoModel],
  );

  const onTestDone = useCallback(
    (rec: persist.TestRecord) => {
      const testsNow = [...tests, rec];
      setTests(testsNow);
      void persist.addTest(rec);
      runGoals(sessions, testsNow);
    },
    [tests, sessions, runGoals],
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

  const accuracyNow = useMemo(() => {
    const recent = sessions.slice(-50);
    return recent.length >= 5 ? recent.reduce((a, s) => a + s.accuracy, 0) / recent.length : null;
  }, [sessions]);

  /** The single goal shown above the typing surface. */
  const bannerGoal: BannerGoal | null = useMemo(() => {
    const g = goals.active[0];
    if (!g) return null;
    const now = goalNow(g, modelRef.current, tests, accuracyNow);
    const showNumbers = g.kind !== "first-test";
    return {
      label: g.label,
      progress: progressOf(g, now),
      now: showNumbers ? fmtGoalValue(g, now) : undefined,
      target: showNumbers ? fmtGoalValue(g, g.target) : undefined,
    };
    // modelVersion keeps pair-speed goals live as the model updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, tests, accuracyNow, modelVersion]);

  const bestTestWpm = tests.length > 0 ? Math.max(...tests.map((t) => t.wpm)) : null;

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
          <button className={tab === "test" ? "active" : ""} onClick={() => setTab("test")}>
            Test
          </button>
          <button className={tab === "progress" ? "active" : ""} onClick={() => setTab("progress")}>
            Progress
          </button>
        </div>
        <div className="spacer" />
      </div>

      {toast && <div className="toast">★ {toast}</div>}

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
          <GoalBanner goal={bannerGoal} />
          <DrillScreen
            lineText={line.text}
            feedback={feedback}
            onLineComplete={onLineComplete}
          />
        </>
      ) : tab === "test" ? (
        <TestScreen
          nextPlainLine={nextPlainLine}
          onLineData={onTestLineData}
          onDone={onTestDone}
          bestWpm={bestTestWpm}
        />
      ) : (
        <Progress
          key={modelVersion}
          model={modelRef.current}
          sessions={sessions}
          tests={tests}
          goals={goals}
          corpus={corpus}
          onExport={onExport}
          onReset={onReset}
          onGoTest={() => setTab("test")}
        />
      )}
    </>
  );
}
