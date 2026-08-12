import type { Instruction, PhaseState, SetSummary } from "../core/coach";

interface Props {
  instruction: Instruction;
  phaseState: PhaseState;
  minutesToday: number;
  /** shown for the moment between sets: what the last one changed */
  summary: SetSummary | null;
  setNumber: number;
  /** step back while the hands are moving */
  receded: boolean;
}

/**
 * The coach speaking. Between sets it reports what moved; the rest of the time
 * it says only what this set is for. It clears itself the moment you type on.
 */
export function CoachBar({
  instruction,
  phaseState,
  minutesToday,
  summary,
  setNumber,
  receded,
}: Props) {
  const cls = "coach" + (receded ? " receded" : "");
  if (summary) {
    return (
      <div className={cls}>
        <div className="coach-head">
          <span className="phase done-phase">{summary.title}</span>
          <span className="verdict">{summary.verdict}</span>
          <span className="spacer" />
          <span className="minutes">{minutesToday} min today</span>
        </div>
        <div className="deltas">
          {summary.changes.length > 0 ? (
            summary.changes.map((c) => (
              <span className={"delta" + (c.better ? " better" : " worse")} key={c.pair}>
                <b>{c.pair}</b>
                {c.from}
                <span className="arrow">→</span>
                <b className="to">{c.to}</b>
                ms
              </span>
            ))
          ) : (
            <span className="delta quiet">next set is loaded — start typing</span>
          )}
        </div>
      </div>
    );
  }

  const dots = Array.from({ length: phaseState.phaseLines }, (_, i) => i);
  return (
    <div className={cls}>
      <div className="coach-head">
        <span className={`phase phase-${instruction.phase}`}>
          {instruction.title} <span className="setno">{setNumber}</span>
        </span>
        <span className="dots" aria-label="progress through this set">
          {dots.map((i) => (
            <span
              key={i}
              className={
                "dot" +
                (i < phaseState.indexInPhase ? " done" : i === phaseState.indexInPhase ? " now" : "")
              }
            />
          ))}
        </span>
        <span className="spacer" />
        <span className="minutes">{minutesToday} min today</span>
      </div>
      <p className="coach-say">{instruction.say}</p>
    </div>
  );
}
