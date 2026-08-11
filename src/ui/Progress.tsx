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

export function goalNow(
  g: Goal,
  model: SkillModel,
  tests: TestRecord[],
  accuracy: number | null,
): number | null {
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

export function fmtGoalValue(g: Goal, v: number | null): string {
  if (v === null) return "—";
  if (g.kind === "accuracy") return (v * 100).toFixed(1) + "%";
  if (g.kind === "pair-speed") return v.toFixed(0) + "ms";
  if (g.kind === "first-test") return v >= 1 ? "done" : "0";
  return v.toFixed(0);
}

export function Progress({
  model,
  sessions,
  tests,
  goals,
  corpus,
  onExport,
  onReset,
  onGoTest,
}: Props) {
  const recent = sessions.slice(-50);
  const practiceWpm =
    recent.length >= 5 ? recent.reduce((a, s) => a + s.wpm, 0) / recent.length : null;
  const accuracy =
    recent.length >= 5 ? recent.reduce((a, s) => a + s.accuracy, 0) / recent.length : null;
  const bestTest = tests.length > 0 ? Math.max(...tests.map((t) => t.wpm)) : null;
  const lastTest = tests.length > 0 ? tests[tests.length - 1] : null;

  const wpmTrend = useMemo(() => rollingMean(sessions.map((s) => s.wpm), 10), [sessions]);
  const weakPoints = useMemo(
    () => model.bottlenecks(corpus.engFreq, 24).filter((b) => b.count >= 10).slice(0, 5),
    [model, corpus],
  );
  const keyExcess = useMemo(() => model.keyExcess(), [model]);
  const wonRecent = [...goals.achieved].reverse().slice(0, 5);

  return (
    <div className="stack">
      <div className="headline">
        <div className="card">
          {bestTest !== null ? (
            <>
              <div className="num">{bestTest.toFixed(0)}</div>
              <div className="cap">wpm · your best</div>
              {lastTest && (
                <div className="since">
                  last test {lastTest.wpm.toFixed(0)} ·{" "}
                  {new Date(lastTest.time).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="num empty">—</div>
              <div className="cap">wpm · your best</div>
              <button className="btn primary" onClick={onGoTest} style={{ marginTop: 16 }}>
                Take a speed test
              </button>
            </>
          )}
        </div>
        <div className="card">
          <div className="num s">{practiceWpm !== null ? practiceWpm.toFixed(0) : "—"}</div>
          <div className="cap">wpm in practice</div>
        </div>
        <div className="card">
          <div className="num s">
            {accuracy !== null ? (accuracy * 100).toFixed(1) + "%" : "—"}
          </div>
          <div className="cap">accuracy</div>
        </div>
      </div>

      <div className="card">
        <h2>Goals</h2>
        {goals.active.length === 0 ? (
          <div className="note">Goals appear once there is enough data. Keep typing.</div>
        ) : (
          <div className="goals">
            {goals.active.map((g) => {
              const now = goalNow(g, model, tests, accuracy);
              const p = progressOf(g, now);
              return (
                <div className="goal" key={g.id}>
                  <div className="top">
                    <span className="name">{g.label}</span>
                    <span className="now">
                      {fmtGoalValue(g, now)}
                      {g.kind !== "first-test" && (
                        <span className="to"> / {fmtGoalValue(g, g.target)}</span>
                      )}
                    </span>
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${(p * 100).toFixed(0)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {wonRecent.length > 0 && (
          <div className="won">
            <span className="tag">{goals.achieved.length} achieved</span>
            {wonRecent.map((g) => (
              <span className="tag win" key={g.id}>
                ✓ {g.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Practice speed</h2>
          <TrendChart
            values={wpmTrend}
            yLabel="words per minute"
            formatY={(v) => v.toFixed(0)}
            yMin={0}
          />
        </div>

        <div className="card">
          <h2>What's slowing you down</h2>
          {weakPoints.length === 0 ? (
            <div className="note">
              Not enough data yet. After a few hundred lines this names the exact transitions
              costing you the most time.
            </div>
          ) : (
            <>
              {weakPoints.map((b) => {
                const pairGoal = goals.active.find((g) => g.pair === b.bigram);
                return (
                  <div className="weak" key={b.bigram}>
                    <span className="pair">{show(b.bigram)}</span>
                    <span className="why">
                      {describePair(b.bigram)}
                      {b.errorRate > 0.05 && " · error-prone"}
                    </span>
                    <span className="ms">
                      {b.meanIki.toFixed(0)}ms
                      {pairGoal && <span className="to"> → {pairGoal.target}</span>}
                    </span>
                  </div>
                );
              })}
              <div className="note">Practice lines are already built around these.</div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Slow keys</h2>
        <Heatmap keyExcess={keyExcess} />
      </div>

      <div className="btn-row">
        <button className="btn" onClick={onExport}>
          Export data
        </button>
        <button className="btn ghost" onClick={onReset}>
          Reset everything
        </button>
      </div>
    </div>
  );
}
