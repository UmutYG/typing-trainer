import type { LineResult } from "../core/capture";
import type { LineStats } from "../core/wpm";
import { useTypingLine } from "./useTypingLine";
import { TypedLine } from "./TypedLine";

export interface LineFeedback {
  stats: LineStats;
}

interface Props {
  lineText: string;
  feedback: LineFeedback | null;
  onLineComplete: (result: LineResult) => void;
}

export function DrillScreen({ lineText, feedback, onLineComplete }: Props) {
  const { view } = useTypingLine(lineText, onLineComplete);

  return (
    <div className="stage">
      <TypedLine text={lineText} view={view} />
      <div className="readout">
        {feedback ? (
          <>
            <span className="n">
              {feedback.stats.wpm.toFixed(0)}
              <span className="u">wpm</span>
            </span>
            <span className="n sub">
              {(feedback.stats.accuracy * 100).toFixed(0)}
              <span className="u">% accurate</span>
            </span>
          </>
        ) : (
          <span className="idle">every line is built from the pairs you are slowest at</span>
        )}
      </div>
    </div>
  );
}
