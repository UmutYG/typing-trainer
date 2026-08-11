import { describe, it, expect } from "vitest";
import {
  emptyGoalState,
  refreshGoals,
  progressOf,
  MAX_ACTIVE_GOALS,
  type Metrics,
  type Goal,
} from "../src/core/goals";
import type { Bottleneck } from "../src/core/model";

function bn(bigram: string, meanIki: number): Bottleneck {
  return { bigram, score: 1, meanIki, excess: 60, errorRate: 0, freq: 0.01, cls: undefined, count: 50 };
}

function metrics(over: Partial<Metrics> = {}): Metrics {
  const pairs = new Map<string, { mean: number; count: number }>([
    [" w", { mean: 210, count: 50 }],
    ["xc", { mean: 240, count: 40 }],
  ]);
  return {
    bestTestWpm: 118,
    testCount: 3,
    accuracy: 0.982,
    linesTyped: 120,
    pairStat: (bg) => pairs.get(bg) ?? null,
    bottlenecks: [bn(" w", 210), bn("xc", 240)],
    ...over,
  };
}

describe("goal generation", () => {
  it("suggests the first speed test before anything else when untested", () => {
    const { state } = refreshGoals(emptyGoalState(), metrics({ testCount: 0, bestTestWpm: null }));
    expect(state.active.some((g) => g.kind === "first-test")).toBe(true);
  });

  it("sets the next 5-wpm milestone above the best test", () => {
    const { state } = refreshGoals(emptyGoalState(), metrics());
    const g = state.active.find((x) => x.kind === "test-wpm")!;
    expect(g.target).toBe(120);
    expect(g.label).toContain("120");
  });

  it("sets accuracy and pair goals in plain language, capped at the max", () => {
    const { state } = refreshGoals(emptyGoalState(), metrics());
    expect(state.active.length).toBeLessThanOrEqual(MAX_ACTIVE_GOALS);
    const acc = state.active.find((g) => g.kind === "accuracy")!;
    expect(acc.target).toBe(0.985);
    const pair = state.active.find((g) => g.kind === "pair-speed" && g.pair === " w")!;
    expect(pair.target).toBe(180); // 210 * 0.85 rounded to 5
    expect(pair.label).toContain("␣w");
  });

  it("does not duplicate goals across refreshes", () => {
    const r1 = refreshGoals(emptyGoalState(), metrics());
    const r2 = refreshGoals(r1.state, metrics());
    expect(r2.state.active.map((g) => g.id).sort()).toEqual(r1.state.active.map((g) => g.id).sort());
  });
});

describe("goal achievement", () => {
  it("achieves a test-wpm goal when the best test passes the target", () => {
    const r1 = refreshGoals(emptyGoalState(), metrics());
    const r2 = refreshGoals(r1.state, metrics({ bestTestWpm: 121 }));
    expect(r2.newlyAchieved.some((g) => g.kind === "test-wpm")).toBe(true);
    // and a fresh milestone replaces it
    const next = r2.state.active.find((g) => g.kind === "test-wpm")!;
    expect(next.target).toBe(125);
  });

  it("pair goals need fresh reps, not just an EWMA dip", () => {
    const r1 = refreshGoals(emptyGoalState(), metrics());
    // mean now beats the target but count is unchanged -> not achieved
    const dipOnly = metrics({
      pairStat: (bg) => (bg === " w" ? { mean: 170, count: 50 } : bg === "xc" ? { mean: 240, count: 40 } : null),
    });
    const r2 = refreshGoals(r1.state, dipOnly);
    expect(r2.newlyAchieved.length).toBe(0);
    // with 20+ new samples it counts
    const earned = metrics({
      pairStat: (bg) => (bg === " w" ? { mean: 170, count: 75 } : bg === "xc" ? { mean: 240, count: 40 } : null),
    });
    const r3 = refreshGoals(r2.state, earned);
    expect(r3.newlyAchieved.some((g) => g.pair === " w")).toBe(true);
  });

  it("never re-creates an already-achieved goal id", () => {
    const r1 = refreshGoals(emptyGoalState(), metrics());
    const r2 = refreshGoals(r1.state, metrics({ bestTestWpm: 121 }));
    const r3 = refreshGoals(r2.state, metrics({ bestTestWpm: 121 }));
    const ids = r3.state.active.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("test-wpm-120");
  });
});

describe("goal progress", () => {
  const goal: Goal = {
    id: "pair- w-180",
    kind: "pair-speed",
    label: "",
    pair: " w",
    target: 180,
    baseline: 210,
    lowerIsBetter: true,
    createdAt: 0,
  };

  it("measures progress from the baseline toward the target", () => {
    expect(progressOf(goal, 210)).toBe(0);
    expect(progressOf(goal, 195)).toBeCloseTo(0.5, 5);
    expect(progressOf(goal, 180)).toBe(1);
    expect(progressOf(goal, 170)).toBe(1); // clamped
    expect(progressOf(goal, 230)).toBe(0); // regression clamps at 0
  });
});
