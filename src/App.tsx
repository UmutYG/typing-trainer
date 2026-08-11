import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import wordsRaw from "./data/words.txt?raw";
import { buildCorpus } from "./core/words";
import { SkillModel } from "./core/model";
import { generateLine, type GeneratedLine } from "./core/generator";
import type { LineResult } from "./core/capture";
import { lineStats } from "./core/wpm";
import * as persist from "./core/persist";
import { DrillScreen, type LineFeedback } from "./ui/DrillScreen";
import { Dashboard } from "./ui/Dashboard";

type Tab = "train" | "stats";
type Theme = "carbon" | "paper" | "neon";

const THEMES: Theme[] = ["carbon", "paper", "neon"];

export default function App() {
  const corpus = useMemo(() => buildCorpus(wordsRaw), []);
  const modelRef = useRef(new SkillModel());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("train");
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("tt-theme") as Theme) ?? "paper");
  const [line, setLine] = useState<GeneratedLine | null>(null);
  const [feedback, setFeedback] = useState<LineFeedback | null>(null);
  const [sessions, setSessions] = useState<persist.SessionRecord[]>([]);
  const [modelVersion, setModelVersion] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tt-theme", theme);
  }, [theme]);

  // console/automation access to the full dataset (model + sessions as JSON)
  useEffect(() => {
    (window as unknown as { dumpData: () => Promise<string> }).dumpData = persist.exportAll;
  }, []);

  const nextLine = useCallback(() => {
    const bns = modelRef.current.bottlenecks(corpus.engFreq, 8);
    setLine(generateLine(corpus, bns));
  }, [corpus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [saved, savedSessions] = await Promise.all([persist.loadModel(), persist.getSessions()]);
      if (cancelled) return;
      if (saved) modelRef.current = SkillModel.deserialize(saved);
      setSessions(savedSessions);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ready && line === null) nextLine();
  }, [ready, line, nextLine]);

  const onLineComplete = useCallback(
    (result: LineResult) => {
      const model = modelRef.current;
      const text = result.line;
      for (let i = 1; i < result.chars.length; i++) {
        const bigram = text[i - 1] + text[i];
        const c = result.chars[i];
        if (c.errorsBefore > 0) model.recordErrors(bigram, c.errorsBefore);
        if (c.timed) model.recordSample(bigram, c.iki, c.rollover);
        else model.recordUntimed(bigram);
      }

      const stats = lineStats(result);
      const slowest = result.chars
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => i >= 1 && c.timed)
        .sort((a, b) => b.c.iki - a.c.iki)
        .slice(0, 3)
        .map(({ c, i }) => ({ bigram: text[i - 1] + text[i], iki: c.iki }));
      setFeedback({ stats, slowest });

      const rec: persist.SessionRecord = {
        time: Date.now(),
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        rolloverRate: stats.rolloverRate,
        consistency: stats.consistency,
        chars: text.length,
        errors: result.totalErrors,
        targets: line?.targets ?? [],
        mode: "drill",
      };
      setSessions((prev) => [...prev, rec]);
      void persist.addSession(rec);
      void persist.saveModel(model.serialize());
      setModelVersion((v) => v + 1);
      nextLine();
    },
    [line, nextLine],
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
    if (!window.confirm("Delete ALL typing data and start fresh? This cannot be undone.")) return;
    indexedDB.deleteDatabase("typing-trainer");
    location.reload();
  }, []);

  return (
    <>
      <div className="header">
        <h1>typing trainer</h1>
        <div className="tabs">
          <button className={tab === "train" ? "active" : ""} onClick={() => setTab("train")}>
            Train
          </button>
          <button className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>
            Stats
          </button>
        </div>
        <div className="spacer" />
        <div className="themes">
          {THEMES.map((t) => (
            <button
              key={t}
              title={t}
              className={`theme-dot-${t} ${theme === t ? "active" : ""}`}
              onClick={() => setTheme(t)}
            />
          ))}
        </div>
      </div>

      {!ready || line === null ? (
        <div className="hint">loading…</div>
      ) : tab === "train" ? (
        <DrillScreen
          lineText={line.text}
          targets={line.targets}
          feedback={feedback}
          onLineComplete={onLineComplete}
        />
      ) : (
        <Dashboard
          key={modelVersion}
          model={modelRef.current}
          sessions={sessions}
          corpus={corpus}
          darkTheme={theme !== "paper"}
          onExport={onExport}
          onReset={onReset}
        />
      )}
    </>
  );
}
