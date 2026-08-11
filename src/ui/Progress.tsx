import { useMemo } from "react";
import type { SkillModel } from "../core/model";
import type { SessionRecord, TestRecord } from "../core/persist";
import type { Corpus } from "../core/words";
import type { GoalState, Goal } from "../core/goals";
import { progressOf } from "../core/goals";
import { describePair } from "../core/keyboard";
import { TrendChart } from "./TrendChart";
import { Heatmap } from "./Heatmap";

interface Props {
  model: SkillModel;
  sessions: SessionRecord[];
  tests: TestRecord[];
  goals: GoalState;
  corpus: Corpus;
  darkTheme: boolean;
  onExport: () => void;
  onReset: () => void;
  onGoTest: () => void;
}

const show = (bg: string) => bg.replace(/ /g, "␣");

function rollingMean(values: number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

function goalNow(g: Goal, model: SkillModel, tests: TestRecord[], accuracy: number | null): number | null {
  switch (g.kind) {
    case "first-test":
      return tests.length;
    case "test-wpm":
      return tests.length > 0 ? Math.max(...tests.map((t) => t.wpm)) : null;
    case "accuracy":
      return accuracy;
    case "pair-speed": {
      const s = g.pair ? model.bigrams.get(g.pair) : undefined;
      return s && s.count > 0 ? s.mean : null;
    }
  }
}

function fmtGoalValue(g: Goal, v: number | null): string {
  if (v === null) return "—";
  if (g.kind === "accuracy") return (v * 100).toFixed(1) + "%";
  if (g.kind === "pair-speed") return v.toFixed(0) + " ms";
  if (g.kind === "first-test") return v >= 1 ? "done" : "not yet";
  return v.toFixed(0) + " wpm";
}

export function Progress({
  model,
  sessions,
  tests,
  goals,
  corpus,
  darkTheme,
  onExport,
  onReset,
  onGoTest,
}: Props) {
  const recent = sessions.slice(-50);
  const practiceWpm = recent.length >= 5 ? recent.reduce((a, s) => a + s.wpm, 0) / recent.length : null;
  const accuracy = recent.length >= 5 ? recent.reduce((a, s) => a + s.accuracy, 0) / recent.length : null;
  const bestTest = tests.length > 0 ? Math.max(...tests.map((t) => t.wpm)) : null;
  const lastTest = tests.length > 0 ? tests[tests.length - 1] : null;

  const wpmTrend = useMemo(() => rollingMean(sessions.map((s) => s.wpm), 10), [sessions]);
  const weakPoints = useMemo(
    () => model.bottlenecks(corpus.engFreq, 24).filter((b) => b.count >= 10).slice(0, 4),
    [model, corpus],
  );
  const keyExcess = useMemo(() => model.keyExcess(), [model]);
  const achievedRecent = [...goals.achieved].reverse().slice(0, 4);

  return (
    <div className="stats">
      <div className="hero-row">
        <div className="hero-tile main">
          {bestTest !== null ? (
            <>
              <div className="hero-num">{bestTest.toFixed(0)}</div>
              <div className="hero-unit">wpm — your speed</div>
              {lastTest && (
                <div className="hero-sub">
                  last test {lastTest.wpm.toFixed(0)} wpm ·{" "}
                  {new Date(lastTest.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="hero-num muted">?</div>
              <div className="hero-unit">your speed</div>
              <button className="btn primary" onClick={onGoTest} style={{ marginTop: 10 }}>
                Take a speed test
              </button>
            </>
          )}
        </div>
        <div className="hero-tile">
          <div className="hero-num sm">{practiceWpm !== null ? practiceWpm.toFixed(0) : "—"}</div>
          <div className="hero-unit">wpm in practice</div>
        </div>
        <div className="hero-tile">
          <div className="hero-num sm">{accuracy !== null ? (accuracy * 100).toFixed(1) + "%" : "—"}</div>
          <div className="hero-unit">accuracy</div>
        </div>
      </div>

      <div className="panel">
        <h2>Your goals</h2>
        {goals.active.length === 0 ? (
          <div className="panel-note">Goals appear as soon as there is enough data — keep typing.</div>
        ) : (
          <div className="goal-list">
            {goals.active.map((g) => {
              const now = goalNow(g, model, tests, accuracy);
              const p = progressOf(g, now);
              return (
                <div className="goal" key={g.id}>
                  <div className="goal-head">
                    <span className="goal-label">{g.label}</span>
                    <span className="goal-now">
                      {fmtGoalValue(g, now)}
                      {g.kind !== "first-test" && <span className="goal-target"> → {fmtGoalValue(g, g.target)}</span>}
                    </span>
                  </div>
                  <div className="goal-track">
                    <div className="goal-fill" style={{ width: `${(p * 100).toFixed(0)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {achievedRecent.length > 0 && (
          <div className="achieved">
            <span className="meta-label">
              achieved · {goals.achieved.length}
            </span>
            {achievedRecent.map((g) => (
              <span className="chip done-chip" key={g.id}>
                ✓ {g.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>Practice speed over time</h2>
          <TrendChart values={wpmTrend} yLabel="words per minute" formatY={(v) => v.toFixed(0)} yMin={0} />
          {tests.length > 0 && (
            <div className="test-history">
              <span className="meta-label">tests</span>
              {tests.slice(-6).map((t, i) => (
                <span className="chip" key={i}>
                  <b>{t.wpm.toFixed(0)}</b>
                  <span className="cls">
                    {new Date(t.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>What's slowing you down</h2>
          {weakPoints.length === 0 ? (
            <div className="panel-note">
              Not enough data yet. After a few hundred lines the engine knows exactly which
              transitions cost you the most.
            </div>
          ) : (
            <div className="weak-list">
              {weakPoints.map((b) => {
                const pairGoal = goals.active.find((g) => g.pair === b.bigram);
                return (
                  <div className="weak" key={b.bigram}>
                    <span className="weak-pair">{show(b.bigram)}</span>
                    <span className="weak-desc">
                      {describePair(b.bigram)}
                      {b.errorRate > 0.05 && " · error-prone"}
                    </span>
                    <span className="weak-speed">
                      {b.meanIki.toFixed(0)} ms
                      {pairGoal && <span className="goal-target"> → {pairGoal.target} ms</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="panel-note">
            Practice lines are already built around these — they fade off this list as you beat them.
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Slow keys</h2>
        <Heatmap keyExcess={keyExcess} darkTheme={darkTheme} />
      </div>

      <div className="btn-row footer-row">
        <button className="btn" onClick={onExport}>
          Export data
        </button>
        <button className="btn danger" onClick={onReset}>
          Reset all data
        </button>
      </div>
    </div>
  );
}
