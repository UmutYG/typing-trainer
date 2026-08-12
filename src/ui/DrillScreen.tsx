import type { LineView } from "../core/capture";
import type { Phase } from "../core/coach";
import type { LineStats } from "../core/wpm";
import { ScrollingText } from "./ScrollingText";

interface Props {
  text: string;
  view: LineView;
  phase: Phase;
  /** precision work: mistakes are marked properly rather than softly */
  strict: boolean;
  last: LineStats | null;
  /** the hands are moving right now */
  typing: boolean;
}

/**
 * The text and your hands. Speed and accuracy are shown but kept deliberately
 * quiet, and they step back further while you are actually typing — a number
 * that changes under your eyes during a run is something to chase.
 */
export function DrillScreen({ text, view, phase, strict, last, typing }: Props) {
  return (
    <div className="stage">
      <ScrollingText text={text} view={view} phase={phase} strict={strict} />
      <div className="ambient" style={{ opacity: typing ? 0.35 : 1 }}>
        {view.fixing ? (
          <span className="fixing">clear it before the caret will move</span>
        ) : (
          last && (
            <>
              <span>{last.wpm.toFixed(0)} wpm</span>
              <span>{(last.accuracy * 100).toFixed(0)}% clean</span>
            </>
          )
        )}
        <span className="hintkey">
          <kbd>esc</kbd>skip this one
        </span>
      </div>
    </div>
  );
}
