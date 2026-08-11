// The goal engine: turns model state into a small set of concrete, plainly
// worded targets, tracks progress toward them, and detects achievement.
// All the statistics stay in the engine — the user only ever sees
// "bring ␣w under 160 ms" and a progress bar.

import type { Bottleneck } from "./model";

export type GoalKind = "first-test" | "test-wpm" | "accuracy" | "pair-speed";

export interface Goal {
  id: string;
  kind: GoalKind;
  label: string;
  pair?: string;
  target: number; // wpm, accuracy fraction, or ms
  baseline: number; // current value when the goal was created
  lowerIsBetter: boolean;
  createdAt: number;
  achievedAt?: number;
  /** pair-speed only: sample count at creation; achievement needs fresh reps */
  countAtCreation?: number;
}

export interface GoalState {
  active: Goal[];
  achieved: Goal[];
}

export interface Metrics {
  bestTestWpm: number | null;
  testCount: number;
  accuracy: number | null; // avg over recent lines, 0..1
  linesTyped: number;
  /** live lookup into the skill model */
  pairStat: (bigram: string) => { mean: number; count: number } | null;
  bottlenecks: Bottleneck[];
}

export const MAX_ACTIVE_GOALS = 4;
const MIN_PAIR_SAMPLES = 30; // don't set pair goals on thin evidence
const FRESH_REPS_TO_ACHIEVE = 20; // pair goal needs this many new samples
const MIN_PAIR_IMPROVEMENT_MS = 15; // don't set goals that are nearly met

const show = (bg: string) => bg.replace(/ /g, "␣");
const round5 = (v: number) => Math.round(v / 5) * 5;

export function emptyGoalState(): GoalState {
  return { active: [], achieved: [] };
}

/** Current value of a goal's tracked quantity, or null if not measurable yet. */
export function currentValue(goal: Goal, m: Metrics): number | null {
  switch (goal.kind) {
    case "first-test":
      return m.testCount;
    case "test-wpm":
      return m.bestTestWpm;
    case "accuracy":
      return m.accuracy;
    case "pair-speed": {
      const s = goal.pair ? m.pairStat(goal.pair) : null;
      return s ? s.mean : null;
    }
  }
}

/** Progress toward the goal in [0, 1], measured from where the user started. */
export function progressOf(goal: Goal, current: number | null): number {
  if (current === null) return 0;
  const span = goal.target - goal.baseline;
  if (Math.abs(span) < 1e-9) return 1;
  return Math.max(0, Math.min(1, (current - goal.baseline) / span));
}

function isAchieved(goal: Goal, m: Metrics): boolean {
  const v = currentValue(goal, m);
  if (v === null) return false;
  if (goal.kind === "pair-speed") {
    const s = goal.pair ? m.pairStat(goal.pair) : null;
    if (!s || s.count < (goal.countAtCreation ?? 0) + FRESH_REPS_TO_ACHIEVE) return false;
  }
  return goal.lowerIsBetter ? v <= goal.target : v >= goal.target;
}

function makeTestWpmGoal(m: Metrics, now: number): Goal | null {
  if (m.bestTestWpm === null) return null;
  const target = round5(m.bestTestWpm) + (round5(m.bestTestWpm) > m.bestTestWpm ? 0 : 5);
  return {
    id: `test-wpm-${target}`,
    kind: "test-wpm",
    label: `Beat ${target} wpm in a speed test`,
    target,
    baseline: m.bestTestWpm,
    lowerIsBetter: false,
    createdAt: now,
  };
}

function makeAccuracyGoal(m: Metrics, now: number): Goal | null {
  if (m.accuracy === null || m.linesTyped < 20) return null;
  const steps = [0.98, 0.985, 0.99, 0.995];
  const target = steps.find((s) => m.accuracy! < s);
  if (target === undefined) return null;
  return {
    id: `accuracy-${target}`,
    kind: "accuracy",
    label: `Hold ${(target * 100).toFixed(1).replace(/\.0$/, "")}% accuracy`,
    target,
    baseline: m.accuracy,
    lowerIsBetter: false,
    createdAt: now,
  };
}

function makePairGoal(b: Bottleneck, m: Metrics, now: number): Goal | null {
  const s = m.pairStat(b.bigram);
  if (!s || s.count < MIN_PAIR_SAMPLES) return null;
  const target = Math.max(90, round5(s.mean * 0.85));
  if (s.mean - target < MIN_PAIR_IMPROVEMENT_MS) return null;
  return {
    id: `pair-${b.bigram}-${target}`,
    kind: "pair-speed",
    label: `Bring ${show(b.bigram)} under ${target} ms`,
    pair: b.bigram,
    target,
    baseline: s.mean,
    lowerIsBetter: true,
    createdAt: now,
    countAtCreation: s.count,
  };
}

/**
 * Reconcile goals with current metrics: retire achieved ones, then top the
 * active list back up. Returns the new state plus any goals achieved just now
 * (for celebration in the UI).
 */
export function refreshGoals(
  state: GoalState,
  m: Metrics,
  now = Date.now(),
): { state: GoalState; newlyAchieved: Goal[] } {
  const newlyAchieved: Goal[] = [];
  const active: Goal[] = [];
  for (const g of state.active) {
    if (isAchieved(g, m)) {
      newlyAchieved.push({ ...g, achievedAt: now });
    } else {
      active.push(g);
    }
  }
  const achieved = [...state.achieved, ...newlyAchieved];
  const known = new Set([...active, ...achieved].map((g) => g.id));

  const candidates: (Goal | null)[] = [];
  if (m.testCount === 0) {
    candidates.push({
      id: "first-test",
      kind: "first-test",
      label: "Take your first speed test",
      target: 1,
      baseline: 0,
      lowerIsBetter: false,
      createdAt: now,
    });
  } else if (!active.some((g) => g.kind === "test-wpm")) {
    candidates.push(makeTestWpmGoal(m, now));
  }
  if (!active.some((g) => g.kind === "accuracy")) candidates.push(makeAccuracyGoal(m, now));
  const pairGoalsActive = active.filter((g) => g.kind === "pair-speed").length;
  let pairSlots = 2 - pairGoalsActive;
  for (const b of m.bottlenecks) {
    if (pairSlots <= 0) break;
    if (active.some((g) => g.pair === b.bigram)) continue;
    const g = makePairGoal(b, m, now);
    if (g && !known.has(g.id)) {
      candidates.push(g);
      pairSlots--;
    }
  }

  for (const c of candidates) {
    if (!c || known.has(c.id) || active.length >= MAX_ACTIVE_GOALS) continue;
    active.push(c);
    known.add(c.id);
  }

  return { state: { active, achieved }, newlyAchieved };
}
