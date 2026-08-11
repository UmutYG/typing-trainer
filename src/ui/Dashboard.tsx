import { useMemo } from "react";
import type { SkillModel } from "../core/model";
import type { SessionRecord } from "../core/persist";
import type { Corpus } from "../core/words";
import { CLASS_LABELS, type TransitionClass } from "../core/keyboard";
import { TrendChart } from "./TrendChart";
import { Heatmap } from "./Heatmap";

interface Props {
  model: SkillModel;
  sessions: SessionRecord[];
  corpus: Corpus;
  darkTheme: boolean;
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

export function Dashboard({ model, sessions, corpus, darkTheme, onExport, onReset }: Props) {
  const recent = sessions.slice(-50);
  const tiles = useMemo(() => {
    if (recent.length === 0) return null;
    const mean = (f: (s: SessionRecord) => number) => recent.reduce((a, s) => a + f(s), 0) / recent.length;
    return {
      wpm: mean((s) => s.wpm),
      acc: mean((s) => s.accuracy),
      roll: mean((s) => s.rolloverRate),
      cons: mean((s) => s.consistency),
    };
  }, [recent]);

  const wpmTrend = useMemo(() => rollingMean(sessions.map((s) => s.wpm), 10), [sessions]);
  const accTrend = useMemo(() => rollingMean(sessions.map((s) => s.accuracy * 100), 10), [sessions]);

  const bottlenecks = useMemo(() => model.bottlenecks(corpus.engFreq, 10), [model, corpus]);
  const baseline = useMemo(() => model.baseline(), [model]);
  const keyExcess = useMemo(() => model.keyExcess(), [model]);
  const classes = useMemo(() => {
    const raw = model.classExcess();
    const order: TransitionClass[] = [
      "same-finger",
      "same-hand-stretch",
      "same-hand-roll",
      "repeat",
      "space",
      "alternating",
      "shift",
    ];
    return order
      .filter((c) => raw.has(c))
      .map((c) => ({ cls: c, ...raw.get(c)! }));
  }, [model]);
  const maxClassExcess = Math.max(20, ...classes.map((c) => Math.abs(c.excess)));

  return (
    <div className="stats">
      <div className="tile-row">
        <div className="tile">
          <div className="v">{tiles ? tiles.wpm.toFixed(0) : "—"}</div>
          <div className="k">wpm · last 50 lines</div>
        </div>
        <div className="tile">
          <div className="v">{tiles ? (tiles.acc * 100).toFixed(1) + "%" : "—"}</div>
          <div className="k">accuracy</div>
        </div>
        <div className="tile">
          <div className="v">{tiles ? (tiles.roll * 100).toFixed(0) + "%" : "—"}</div>
          <div className="k">rollover</div>
        </div>
        <div className="tile">
          <div className="v">{tiles ? (tiles.cons * 100).toFixed(0) + "%" : "—"}</div>
          <div className="k">consistency</div>
        </div>
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>Speed — wpm per line, smoothed</h2>
          <TrendChart values={wpmTrend} yLabel="words per minute" formatY={(v) => v.toFixed(0)} yMin={0} />
        </div>
        <div className="panel">
          <h2>Accuracy — % per line, smoothed</h2>
          <TrendChart values={accTrend} yLabel="accuracy percent" formatY={(v) => v.toFixed(1) + "%"} yMax={100} />
        </div>
      </div>

      <div className="panel">
        <h2>Key heatmap — arrival slowness vs your baseline ({baseline.toFixed(0)} ms)</h2>
        <Heatmap keyExcess={keyExcess} darkTheme={darkTheme} />
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>Top bottleneck transitions</h2>
          <table className="bn">
            <thead>
              <tr>
                <th>pair</th>
                <th>why</th>
                <th>speed</th>
                <th>vs base</th>
                <th>errors</th>
              </tr>
            </thead>
            <tbody>
              {bottlenecks.map((b) => (
                <tr key={b.bigram}>
                  <td className="bg">{show(b.bigram)}</td>
                  <td>{b.cls ? CLASS_LABELS[b.cls] : "—"}</td>
                  <td>{b.count > 0 ? b.meanIki.toFixed(0) + " ms" : "unmeasured"}</td>
                  <td>{b.count > 0 ? "+" + b.excess.toFixed(0) + " ms" : "—"}</td>
                  <td>{(b.errorRate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="panel-note">
            Ranked by what each transition costs you in real English: frequency × your excess time,
            inflated by errors and instability. This is what the generator is drilling.
          </div>
        </div>

        <div className="panel">
          <h2>Slowness by transition type</h2>
          <div className="class-bars">
            {classes.map((c) => (
              <div className="class-bar" key={c.cls}>
                <span>{CLASS_LABELS[c.cls]}</span>
                <div className="track">
                  <div
                    className="fill"
                    style={{ width: `${Math.min(100, (Math.max(0, c.excess) / maxClassExcess) * 100)}%` }}
                  />
                </div>
                <span className="val">
                  {c.excess >= 0 ? "+" : ""}
                  {c.excess.toFixed(0)} ms
                </span>
              </div>
            ))}
          </div>
          <div className="panel-note">
            Mean arrival time vs baseline, by the physical shape of the transition. This is the
            "why" behind slow keys — a slow letter is usually a slow class of movement.
          </div>
          <div style={{ height: 16 }} />
          <div className="btn-row">
            <button className="btn" onClick={onExport}>
              Export data
            </button>
            <button className="btn danger" onClick={onReset}>
              Reset all data
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
