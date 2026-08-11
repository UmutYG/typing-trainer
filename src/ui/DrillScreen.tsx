import type { LineResult } from "../core/capture";
import type { LineStats } from "../core/wpm";
import { useTypingLine } from "./useTypingLine";
import { TypedLine } from "./TypedLine";

interface Props {
  lineText: string;
  last: LineStats | null;
  /** precision work: the line will not finish while a mistake is still showing */
  requireCorrection: boolean;
  onLineComplete: (result: LineResult) => void;
}

/**
 * The text and your hands. Speed and accuracy are shown but kept deliberately
 * quiet — there when you glance down, never asking to be chased.
 */
export function DrillScreen({ lineText, last, requireCorrection, onLineComplete }: Props) {
  const { view } = useTypingLine(lineText, onLineComplete, requireCorrection);
  return (
    <div className="stage">
      <TypedLine text={lineText} view={view} />
      <div className="ambient">
        {view.fixing ? (
          <span className="fixing">clear the red letters to finish</span>
        ) : (
          last && (
            <>
              <span>{last.wpm.toFixed(0)} wpm</span>
              <span>{(last.accuracy * 100).toFixed(0)}% clean</span>
            </>
          )
        )}
      </div>
    </div>
  );
}
