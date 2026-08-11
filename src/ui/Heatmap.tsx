import { useState } from "react";

// Validated sequential blue ramp (dataviz reference palette, steps 100..700).
const RAMP = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
];

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

interface Props {
  keyExcess: Map<string, number>; // destination-key mean excess IKI (ms over baseline)
  darkTheme: boolean;
}

/**
 * Keyboard heatmap of per-key excess slowness. Sequential single-hue encoding:
 * near-baseline recedes toward the surface, slower keys saturate. On dark
 * surfaces the ramp direction flips so magnitude still reads as "more ink".
 */
export function Heatmap({ keyExcess, darkTheme }: Props) {
  const [tip, setTip] = useState<string | null>(null);
  const vals = [...keyExcess.values()];
  const max = Math.max(30, ...vals);

  const color = (key: string): { bg: string | undefined; fg: string | undefined } => {
    const v = keyExcess.get(key);
    if (v === undefined) return { bg: undefined, fg: undefined };
    const t = Math.min(1, Math.max(0, v / max));
    const idx = Math.round(t * (RAMP.length - 1));
    const bg = darkTheme ? RAMP[RAMP.length - 1 - idx] : RAMP[idx];
    // ink flips against the fill for readability at the extremes
    const deep = darkTheme ? idx > 5 : idx > 5;
    const fg = deep ? "#ffffff" : "#0b0b0b";
    return { bg, fg };
  };

  const label = (key: string): string => {
    const v = keyExcess.get(key);
    if (v === undefined) return `${key === " " ? "space" : key} — no data yet`;
    const sign = v >= 0 ? "+" : "";
    return `${key === " " ? "space" : key} — ${sign}${v.toFixed(0)} ms vs your baseline`;
  };

  const gradient = darkTheme
    ? `linear-gradient(90deg, ${RAMP[RAMP.length - 1]}, ${RAMP[0]})`
    : `linear-gradient(90deg, ${RAMP[0]}, ${RAMP[RAMP.length - 1]})`;

  return (
    <div>
      <div className="kb" aria-label="keyboard heatmap">
        {ROWS.map((row, ri) => (
          <div className="kb-row" key={ri} style={{ marginLeft: ri * 14 }}>
            {[...row].map((k) => {
              const c = color(k);
              return (
                <div
                  key={k}
                  className="kb-key"
                  style={c.bg ? { background: c.bg, color: c.fg, borderColor: "transparent" } : undefined}
                  onMouseEnter={() => setTip(label(k))}
                  onMouseLeave={() => setTip(null)}
                >
                  {k}
                </div>
              );
            })}
          </div>
        ))}
        <div className="kb-row">
          {(() => {
            const c = color(" ");
            return (
              <div
                className="kb-key space"
                style={c.bg ? { background: c.bg, color: c.fg, borderColor: "transparent" } : undefined}
                onMouseEnter={() => setTip(label(" "))}
                onMouseLeave={() => setTip(null)}
              >
                space
              </div>
            );
          })()}
        </div>
      </div>
      <div className="kb-legend">
        <span>at your baseline</span>
        <div className="bar" style={{ background: gradient }} />
        <span>slower</span>
        <span style={{ marginLeft: "auto", color: "var(--ink-2)" }}>{tip ?? "hover a key"}</span>
      </div>
    </div>
  );
}
