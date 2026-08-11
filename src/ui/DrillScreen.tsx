import type { LineResult } from "../core/capture";
import { CLASS_LABELS, classifyTransition } from "../core/keyboard";
import type { LineStats } from "../core/wpm";
import { useTypingLine } from "./useTypingLine";

export interface LineFeedback {
  stats: LineStats;
  slowest: { bigram: string; iki: number }[];
}

export interface TargetInfo {
  bigram: string;
  mean: number | null; // current model speed for this pair, ms
}

interface Props {
  lineText: string;
  targets: TargetInfo[];
  feedback: LineFeedback | null;
  onLineComplete: (result: LineResult) => void;
}

const show = (bg: string) => bg.replace(/ /g, "␣");

export function DrillScreen({ lineText, targets, feedback, onLineComplete }: Props) {
  const { pos, err } = useTypingLine(lineText, onLineComplete);

  return (
    <div className="drill">
      <div className="line-box">
        <div className="line" aria-label="text to type">
          <span className="done">{lineText.slice(0, pos)}</span>
          {pos < lineText.length && (
            <span className={"cur" + (err ? " err" : "")}>{lineText[pos]}</span>
          )}
          <span className="todo">{lineText.slice(pos + 1)}</span>
        </div>
      </div>

      <div className="drill-meta">
        {feedback ? (
          <>
            <span className="line-result">
              <b>{feedback.stats.wpm.toFixed(0)}</b> wpm
            </span>
            <span className="line-result">
              <b>{(feedback.stats.accuracy * 100).toFixed(1)}</b>%
            </span>
            {feedback.slowest.length > 0 && <span className="meta-label">slowest</span>}
            {feedback.slowest.map((s) => {
              const cls = classifyTransition(s.bigram[0], s.bigram[1]);
              return (
                <span className="chip slow" key={s.bigram}>
                  <b>{show(s.bigram)}</b> {s.iki.toFixed(0)} ms
                  {cls && <span className="cls">{CLASS_LABELS[cls]}</span>}
                </span>
              );
            })}
          </>
        ) : (
          <span className="meta-label">start typing — every line targets your weakest spots</span>
        )}
      </div>

      <div className="targets-row">
        <span className="meta-label">working on</span>
        {targets.map((t) => (
          <span className="chip" key={t.bigram}>
            <b>{show(t.bigram)}</b>
            {t.mean !== null && <span className="cls">{t.mean.toFixed(0)} ms</span>}
          </span>
        ))}
      </div>
    </div>
  );
}
