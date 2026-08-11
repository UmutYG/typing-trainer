import { useState } from "react";

// Sequential single-hue ramp on the accent green, dark -> bright: on a near-black
// surface "more light" reads as "more magnitude".
const RAMP = [
  "#16281d",
  "#1b3626",
  "#20452f",
  "#255438",
  "#2a6341",
  "#2f734b",
  "#358355",
  "#3b945f",
  "#41a569",
  "#47b673",
  "#4ec87e",
  "#5ad98b",
  "#74e59f",
];

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/**
 * Per-key arrival slowness versus your own baseline. Keys you have no data for
 * stay unpainted.
 */
export function Heatmap({ keyExcess }: { keyExcess: Map<string, number> }) {
  const [tip, setTip] = useState<string | null>(null);
  const max = Math.max(30, ...keyExcess.values());

  const paint = (key: string) => {
    const v = keyExcess.get(key);
    if (v === undefined) return undefined;
    const t = Math.min(1, Math.max(0, v / max));
    const idx = Math.round(t * (RAMP.length - 1));
    return {
      background: RAMP[idx],
      borderColor: "transparent",
      color: idx > 7 ? "#06210f" : "#cfe9d9",
    };
  };

  const label = (key: string) => {
    const v = keyExcess.get(key);
    const name = key === " " ? "space" : key;
    if (v === undefined) return `${name} — no data yet`;
    return `${name} — ${v >= 0 ? "+" : ""}${v.toFixed(0)}ms vs your baseline`;
  };

  return (
    <div>
      <div className="kb" aria-label="keyboard heatmap">
        {ROWS.map((row, ri) => (
          <div className="kb-row" key={ri} style={{ marginLeft: ri * 14 }}>
            {[...row].map((k) => (
              <div
                key={k}
                className="kb-key"
                style={paint(k)}
                onMouseEnter={() => setTip(label(k))}
                onMouseLeave={() => setTip(null)}
              >
                {k}
              </div>
            ))}
          </div>
        ))}
        <div className="kb-row">
          <div
            className="kb-key space"
            style={paint(" ")}
            onMouseEnter={() => setTip(label(" "))}
            onMouseLeave={() => setTip(null)}
          >
            space
          </div>
        </div>
      </div>
      <div className="kb-legend">
        <span>at your baseline</span>
        <div
          className="bar"
          style={{ background: `linear-gradient(90deg, ${RAMP[0]}, ${RAMP[RAMP.length - 1]})` }}
        />
        <span>slower</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-2)" }}>{tip ?? "hover a key"}</span>
      </div>
    </div>
  );
}
