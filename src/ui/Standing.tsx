import { useMemo } from "react";
import type { SkillModel } from "../core/model";
import type { SessionRecord } from "../core/persist";
import type { Corpus } from "../core/words";
import { CLASS_LABELS } from "../core/keyboard";
import { classStanding, currentLevel, gaps, keyGaps, nextStandard, wpmForIki } from "../core/coach";
import { TrendChart } from "./TrendChart";
import { Heatmap } from "./Heatmap";

interface Props {
  model: SkillModel;
  sessions: SessionRecord[];
  corpus: Corpus;
  onExport: () => void;
  onReset: () => void;
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

export function Standing({ model, sessions, corpus, onExport, onReset }: Props) {
  const level = useMemo(() => currentLevel(model, corpus.engFreq), [model, corpus]);
  const tier = nextStandard(level?.wpm ?? null);
  const ranked = useMemo(() => gaps(model, corpus.engFreq, tier), [model, corpus, tier]);
  const classes = useMemo(() => classStanding(model, tier), [model, tier]);
  const kg = useMemo(() => keyGaps(model, tier), [model, tier]);
  const wpmTrend = useMemo(() => rollingMean(sessions.map((s) => s.wpm), 10), [sessions]);
  const minutesTotal = Math.round(sessions.reduce((a, s) => a + s.ms, 0) / 60000);

  return (
    <div className="stack">
      <div className="card">
        <div className="standing-row">
          <div className="stat">
            <div className={level ? "num" : "num s empty"}>
              {level ? level.wpm.toFixed(0) : "not yet"}
            </div>
            <div className="cap">words per minute, as you practise</div>
          </div>
          <div className="stat">
            <div className="num s">{minutesTotal}</div>
            <div className="cap">{minutesTotal === 1 ? "minute practised" : "minutes practised"}</div>
          </div>
        </div>
        <div className="note">
          Taken from ordinary practice — every keystroke is the measurement, so there is never a
          test to sit.{" "}
          {level === null && "This needs a few more minutes of typing before it can say."}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Where the work is</h2>
          {classes.length === 0 ? (
            <div className="note">Not enough data yet.</div>
          ) : (
            classes.map((c) => {
              const over = c.mean / c.target;
              const pct = Math.max(0, Math.min(1, 1 / over));
              return (
                <div className="classrow" key={c.cls}>
                  <span className="cname">{CLASS_LABELS[c.cls]}</span>
                  <span className="track">
                    <span
                      className={"fill" + (over <= 1.02 ? " met" : "")}
                      style={{ width: `${(pct * 100).toFixed(0)}%` }}
                    />
                  </span>
                  <span className="cnum">
                    {c.mean.toFixed(0)}
                    <span className="to">/{c.target.toFixed(0)}ms</span>
                  </span>
                </div>
              );
            })
          )}
          <div className="note">
            Each kind of movement has its own elite target — one finger firing twice cannot be as
            fast as two hands alternating, so they are not held to the same number.
          </div>
        </div>

        <div className="card">
          <h2>What the coach is drilling</h2>
          {ranked.length === 0 ? (
            <div className="note">Not enough data yet.</div>
          ) : (
            ranked.slice(0, 6).map((g) => (
              <div className="weak" key={g.bigram}>
                <span className="pair">{show(g.bigram)}</span>
                <span className="why">{CLASS_LABELS[g.cls]}</span>
                <span className="ms">
                  {g.mean.toFixed(0)}
                  <span className="to"> / {g.target.toFixed(0)}ms</span>
                </span>
              </div>
            ))
          )}
          <div className="note">This is what your practice lines are being built from.</div>
        </div>
      </div>

      <div className="card">
        <h2>Speed over time</h2>
        <TrendChart values={wpmTrend} yLabel="words per minute" formatY={(v) => v.toFixed(0)} yMin={0} />
      </div>

      <div className="card">
        <h2>Your keyboard</h2>
        <Heatmap keyExcess={kg} />
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

export { wpmForIki };
