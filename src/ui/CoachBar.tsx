import type { Instruction, PhaseState } from "../core/coach";

interface Props {
  instruction: Instruction;
  phaseState: PhaseState;
  minutesToday: number;
}

/**
 * The coach speaking. This is the only thing you are asked to hold in your
 * head: what this set is for, and how far into it you are.
 */
export function CoachBar({ instruction, phaseState, minutesToday }: Props) {
  const dots = Array.from({ length: phaseState.phaseLines }, (_, i) => i);
  return (
    <div className="coach">
      <div className="coach-head">
        <span className={`phase phase-${instruction.phase}`}>{instruction.title}</span>
        <span className="dots" aria-label="progress through this set">
          {dots.map((i) => (
            <span key={i} className={"dot" + (i < phaseState.indexInPhase ? " done" : i === phaseState.indexInPhase ? " now" : "")} />
          ))}
        </span>
        <span className="spacer" />
        <span className="minutes">{minutesToday} min today</span>
      </div>
      <p className="coach-say">{instruction.say}</p>
    </div>
  );
}
