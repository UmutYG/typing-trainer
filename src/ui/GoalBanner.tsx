export interface BannerGoal {
  label: string;
  progress: number; // 0..1
  /** omitted for goals whose label already says everything (e.g. "take a test") */
  now?: string;
  target?: string;
}

/** The one thing you are chasing right now, kept in view while you type. */
export function GoalBanner({ goal }: { goal: BannerGoal | null }) {
  if (!goal) return null;
  return (
    <div className="goal-banner">
      <span className="cap">Goal</span>
      <span className="txt">{goal.label}</span>
      <span className="bar">
        <span className="fill" style={{ width: `${Math.round(goal.progress * 100)}%` }} />
      </span>
      {goal.now && (
        <span className="val">
          {goal.now} <span style={{ opacity: 0.5 }}>/ {goal.target}</span>
        </span>
      )}
    </div>
  );
}
