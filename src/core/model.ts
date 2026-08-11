// The live skill model: per-transition (bigram) statistics with recency-weighted
// speed, variance, error and rollover tracking, plus bottleneck ranking that
// weighs personal slowness by real-English frequency.

import { classifyTransition, type TransitionClass } from "./keyboard";

export interface BigramStat {
  count: number; // timed, correct samples
  mean: number; // EWMA of inter-key interval, ms
  m2: number; // EW variance accumulator
  attempts: number; // positions attempted (correct completions of this transition)
  errors: number; // wrong keystrokes made at this transition
  rollover: number; // rollover keystrokes among timed samples
  last: number; // epoch ms of last sample
}

export interface Bottleneck {
  bigram: string;
  score: number;
  meanIki: number;
  excess: number; // ms above personal baseline
  errorRate: number;
  freq: number; // share of real-English transitions
  cls: TransitionClass | undefined;
  count: number;
}

const EWMA_FLOOR = 0.1; // after 10 samples, ~last 10-20 dominate: model stays live
const UNCERTAINTY_K = 10; // pseudo-count pulling unmeasured bigrams into rotation
const UNCERTAINTY_PRIOR_MS = 45; // assumed excess for an unmeasured transition

export function newStat(): BigramStat {
  return { count: 0, mean: 0, m2: 0, attempts: 0, errors: 0, rollover: 0, last: 0 };
}

export function updateStat(s: BigramStat, iki: number, rollover: boolean, now = Date.now()): void {
  s.count++;
  const alpha = Math.max(1 / s.count, EWMA_FLOOR);
  const diff = iki - s.mean;
  const incr = alpha * diff;
  s.mean += incr;
  s.m2 = (1 - alpha) * (s.m2 + diff * incr);
  if (rollover) s.rollover++;
  s.last = now;
}

export interface SerializedModel {
  version: 1;
  bigrams: Record<string, BigramStat>;
}

export class SkillModel {
  bigrams = new Map<string, BigramStat>();

  private stat(bigram: string): BigramStat {
    let s = this.bigrams.get(bigram);
    if (!s) {
      s = newStat();
      this.bigrams.set(bigram, s);
    }
    return s;
  }

  /** A correct, timed keystroke completing `bigram`. */
  recordSample(bigram: string, iki: number, rollover: boolean, now = Date.now()): void {
    const s = this.stat(bigram);
    s.attempts++;
    updateStat(s, iki, rollover, now);
  }

  /** A correct keystroke whose timing was invalid (after error / after pause). */
  recordUntimed(bigram: string): void {
    this.stat(bigram).attempts++;
  }

  /** `wrongCount` wrong keystrokes were made where `bigram` was expected. */
  recordErrors(bigram: string, wrongCount: number): void {
    this.stat(bigram).errors += wrongCount;
  }

  /**
   * Personal baseline: the 25th percentile of measured bigram means — your own
   * demonstrated "fast" level. Excess over this is trainable slack, so the
   * target moves up as you improve rather than saturating like keybr's.
   */
  baseline(): number {
    const means: number[] = [];
    for (const s of this.bigrams.values()) if (s.count >= 8) means.push(s.mean);
    if (means.length < 15) {
      // cold start: global mean of whatever we have, discounted
      let sum = 0;
      let n = 0;
      for (const s of this.bigrams.values()) {
        sum += s.mean * s.count;
        n += s.count;
      }
      return n > 0 ? (0.8 * sum) / n : 150;
    }
    means.sort((a, b) => a - b);
    return means[Math.floor(means.length * 0.25)];
  }

  errorRate(bigram: string): number {
    const s = this.bigrams.get(bigram);
    if (!s || s.attempts === 0) return 0;
    return s.errors / (s.errors + s.attempts);
  }

  /**
   * Expected cost of each transition in real typing:
   * english frequency x personal excess, inflated by error rate and
   * instability, plus an uncertainty bonus so frequent-but-unmeasured
   * transitions get scheduled and measured.
   */
  bottlenecks(engFreq: Map<string, number>, topN = 12): Bottleneck[] {
    const base = this.baseline();
    const out: Bottleneck[] = [];
    for (const [bigram, freq] of engFreq) {
      const s = this.bigrams.get(bigram);
      const count = s?.count ?? 0;
      const mean = s?.mean ?? 0;
      const excess = count > 0 ? Math.max(0, mean - base) : 0;
      // decays with count^2: a transition measured ~10 times is trusted and the
      // exploration bonus vanishes, leaving pure measured excess
      const uncertainty = UNCERTAINTY_PRIOR_MS * (UNCERTAINTY_K / (UNCERTAINTY_K + count * count));
      const errRate = this.errorRate(bigram);
      const cv = count > 0 && mean > 0 ? Math.min(1, Math.sqrt(Math.max(0, s!.m2)) / mean) : 0;
      const score = freq * (excess + uncertainty) * (1 + 3 * errRate) * (1 + cv);
      out.push({
        bigram,
        score,
        meanIki: mean,
        excess,
        errorRate: errRate,
        freq,
        cls: classifyTransition(bigram[0], bigram[1]),
        count,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
  }

  /** Mean excess IKI per destination key, for the heatmap. */
  keyExcess(): Map<string, number> {
    const base = this.baseline();
    const acc = new Map<string, { w: number; sum: number }>();
    for (const [bigram, s] of this.bigrams) {
      if (s.count < 3) continue;
      const key = bigram[1];
      const a = acc.get(key) ?? { w: 0, sum: 0 };
      a.w += s.count;
      a.sum += (s.mean - base) * s.count;
      acc.set(key, a);
    }
    const out = new Map<string, number>();
    for (const [k, a] of acc) out.set(k, a.sum / a.w);
    return out;
  }

  /** Aggregate excess per physical transition class, for "why you are slow". */
  classExcess(): Map<TransitionClass, { excess: number; samples: number }> {
    const base = this.baseline();
    const acc = new Map<TransitionClass, { w: number; sum: number }>();
    for (const [bigram, s] of this.bigrams) {
      if (s.count < 3) continue;
      const cls = classifyTransition(bigram[0], bigram[1]);
      if (!cls) continue;
      const a = acc.get(cls) ?? { w: 0, sum: 0 };
      a.w += s.count;
      a.sum += (s.mean - base) * s.count;
      acc.set(cls, a);
    }
    const out = new Map<TransitionClass, { excess: number; samples: number }>();
    for (const [k, a] of acc) out.set(k, { excess: a.sum / a.w, samples: a.w });
    return out;
  }

  rolloverRate(): number {
    let roll = 0;
    let n = 0;
    for (const s of this.bigrams.values()) {
      roll += s.rollover;
      n += s.count;
    }
    return n > 0 ? roll / n : 0;
  }

  serialize(): SerializedModel {
    return { version: 1, bigrams: Object.fromEntries(this.bigrams) };
  }

  static deserialize(data: SerializedModel): SkillModel {
    const m = new SkillModel();
    for (const [k, v] of Object.entries(data.bigrams)) m.bigrams.set(k, { ...v });
    return m;
  }
}
