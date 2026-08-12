// The live skill model: per-transition (bigram) statistics with recency-weighted
// speed, variance, error and rollover tracking. It only records; deciding what
// any of it means belongs to the coach.

export interface BigramStat {
  count: number; // timed, correct samples
  mean: number; // EWMA of inter-key interval, ms
  /**
   * The same average over a much longer memory. On its own it says nothing;
   * held against `mean` it says which way this transition is moving, and how
   * fast — which is what separates a pair that is still responding to practice
   * from one that has settled and would only be ground at.
   */
  slow: number;
  m2: number; // EW variance accumulator
  attempts: number; // positions attempted (correct completions of this transition)
  errors: number; // wrong keystrokes made at this transition
  rollover: number; // rollover keystrokes among timed samples
  last: number; // epoch ms of last sample
  /** what was typed instead, and how often — the shape of the mistake */
  confusions: Record<string, number>;
  /** errors that were the *next* character: the hands fired out of order */
  transposed: number;
}

const EWMA_FLOOR = 0.1; // after 10 samples, ~last 10-20 dominate: model stays live
/** the long memory: roughly the last 50 samples, for comparison against `mean` */
const EWMA_SLOW = 0.02;

/** distinct wrong keys remembered per transition, so the record cannot grow without bound */
const MAX_CONFUSIONS = 6;

export function newStat(): BigramStat {
  return {
    count: 0,
    mean: 0,
    slow: 0,
    m2: 0,
    attempts: 0,
    errors: 0,
    rollover: 0,
    last: 0,
    confusions: {},
    transposed: 0,
  };
}

export function updateStat(s: BigramStat, iki: number, rollover: boolean, now = Date.now()): void {
  s.count++;
  const alpha = Math.max(1 / s.count, EWMA_FLOOR);
  const diff = iki - s.mean;
  const incr = alpha * diff;
  s.mean += incr;
  s.m2 = (1 - alpha) * (s.m2 + diff * incr);
  const slowAlpha = Math.max(1 / s.count, EWMA_SLOW);
  s.slow += slowAlpha * (iki - s.slow);
  if (rollover) s.rollover++;
  s.last = now;
}

/**
 * How much this transition has improved lately, in ms — the long average minus
 * the recent one. Positive means it is still getting faster under practice.
 */
export function trendOf(s: BigramStat): number {
  if (s.count < 12) return 0; // not enough history for the two averages to differ
  return s.slow - s.mean;
}

/** bumped whenever BigramStat gains a field; deserialize migrates forward */
export const MODEL_VERSION = 3;

export interface SerializedModel {
  version: number;
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

  /**
   * Wrong keystrokes made where `bigram` was expected, along with what was
   * actually hit — the substitutions are what turn "you make mistakes here"
   * into "you hit r when you mean t".
   */
  recordErrors(
    bigram: string,
    wrongCount: number,
    detail: { wrongChars?: string[]; transposed?: boolean } = {},
  ): void {
    const s = this.stat(bigram);
    s.errors += wrongCount;
    if (detail.transposed) s.transposed++;
    for (const ch of detail.wrongChars ?? []) {
      if (s.confusions[ch] === undefined && Object.keys(s.confusions).length >= MAX_CONFUSIONS) {
        continue; // keep the record bounded; the common ones are already in
      }
      s.confusions[ch] = (s.confusions[ch] ?? 0) + 1;
    }
  }

  /** The wrong key most often hit here, if one stands out. */
  topConfusion(bigram: string): { char: string; count: number } | null {
    const s = this.bigrams.get(bigram);
    if (!s) return null;
    let best: { char: string; count: number } | null = null;
    for (const [char, count] of Object.entries(s.confusions)) {
      if (!best || count > best.count) best = { char, count };
    }
    return best && best.count >= 2 ? best : null;
  }

  errorRate(bigram: string): number {
    const s = this.bigrams.get(bigram);
    if (!s || s.attempts === 0) return 0;
    return s.errors / (s.errors + s.attempts);
  }

  serialize(): SerializedModel {
    return { version: MODEL_VERSION, bigrams: Object.fromEntries(this.bigrams) };
  }

  /**
   * Loads a model saved by any earlier version of the app. Fields added since
   * are filled with neutral defaults rather than discarded, and a single
   * unreadable entry is skipped instead of taking the whole model down —
   * the years of keystrokes in here are the one thing that cannot be rebuilt.
   */
  static deserialize(data: SerializedModel): SkillModel {
    const m = new SkillModel();
    const entries = data && typeof data === "object" ? (data.bigrams ?? {}) : {};
    for (const [k, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Partial<BigramStat>;
      if (typeof v.count !== "number" || typeof v.mean !== "number") continue;
      m.bigrams.set(k, {
        ...newStat(),
        ...v,
        // v1 had no error-shape tracking
        confusions: typeof v.confusions === "object" && v.confusions !== null ? v.confusions : {},
        transposed: typeof v.transposed === "number" ? v.transposed : 0,
        // v2 had no long memory: seed it level with the recent one, so a
        // migrated pair reads as "no trend yet" rather than "improving hugely"
        slow: typeof v.slow === "number" ? v.slow : v.mean,
      });
    }
    return m;
  }
}
