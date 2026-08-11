import { useMemo, useRef, useState } from "react";

interface Props {
  values: number[]; // one point per line typed, already smoothed by caller
  height?: number;
  yLabel: string;
  formatY: (v: number) => string;
  yMin?: number;
  yMax?: number;
}

const PAD = { top: 10, right: 14, bottom: 22, left: 44 };

/** Single-series line chart with crosshair hover tooltip. One axis, recessive grid. */
export function TrendChart({ values, height = 180, yLabel, formatY, yMin, yMax }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const width = 420;

  const { lo, hi, ticks } = useMemo(() => {
    if (values.length === 0) return { lo: 0, hi: 1, ticks: [] as number[] };
    let lo = yMin ?? Math.min(...values);
    let hi = yMax ?? Math.max(...values);
    if (hi - lo < 1e-6) {
      hi = lo + 1;
    }
    const span = hi - lo;
    lo = yMin ?? lo - span * 0.1;
    hi = yMax ?? hi + span * 0.1;
    const ticks = [lo, (lo + hi) / 2, hi];
    return { lo, hi, ticks };
  }, [values, yMin, yMax]);

  if (values.length < 2) {
    return <div className="panel-note">Type a few lines and the trend appears here.</div>;
  }

  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (values.length - 1)) * iw;
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih;
  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * width;
    const frac = Math.min(1, Math.max(0, (mx - PAD.left) / iw));
    const i = Math.round(frac * (values.length - 1));
    setHover({ i, px: x(i), py: y(values[i]) });
  };

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={yLabel}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--ink-3)">
              {formatY(t)}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={PAD.top} y2={PAD.top + ih} stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={hover.px} cy={hover.py} r={4.5} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
          </g>
        )}
        <text x={PAD.left} y={height - 5} fontSize={10.5} fill="var(--ink-3)">
          older
        </text>
        <text x={width - PAD.right} y={height - 5} fontSize={10.5} fill="var(--ink-3)" textAnchor="end">
          recent
        </text>
      </svg>
      {hover && wrapRef.current && (
        <div
          className="viz-tip"
          style={{
            left: `${(hover.px / width) * 100}%`,
            top: `${(hover.py / height) * 100}%`,
          }}
        >
          {formatY(values[hover.i])}
        </div>
      )}
    </div>
  );
}
