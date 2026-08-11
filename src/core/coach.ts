// The coach: decides what you practise right now, measured against the next
// elite standard rather than against your own past. There are no goals to tick
// off and nothing to pass or fail — the standard is fixed by physics and the
// coach simply keeps pointing you at whatever is furthest from it.

import { classifyTransition, type TransitionClass } from "./keyboard";
import type { SkillModel } from "./model";

/* ------------------------------------------------------------------ *
 * Elite standards
 * ------------------------------------------------------------------ */

/**
 * Words per minute is defined as (characters / 5) per minute, so a sustained
 * speed implies an exact average gap between keystrokes:
 *   wpm = 12000 / iki_ms
 * 120 wpm is 100ms per key, 150 wpm is 80ms, 200 wpm is 60ms.
 */
export function ikiForWpm(wpm: number): number {
  return 12000 / wpm;
}

export function wpmForIki(iki: number): number {
  return 12000 / iki;
}

/** The ladder of standards the coach walks you up. */
export const TIERS = [100, 120, 140, 160, 180, 200];

/**
 * Not every movement can be equally fast, so a flat target per keystroke would
 * be wrong: one finger moving twice in a row is physically slower than two
 * hands alternating, which overlap. These multipliers scale the tier's average
 * target for each kind of movement.
 *
 * They are physical priors, not measured constants — set so that the
 * frequency-weighted average across English stays near 1.0, with alternation
 * fastest (hands overlap, enabling rollover) and same-finger slowest (one
 * finger must travel and reset before it can fire again).
 */
export const CLASS_FACTOR: Record<TransitionClass, number> = {
  alternating: 0.85,
  space: 0.9,
  "same-hand-roll": 0.95,
  repeat: 1.05,
  "same-hand-stretch": 1.25,
  shift: 1.4,
  "same-finger": 1.75,
};

/** The keystroke time an elite typist at `tierWpm` would hit for this movement. */
export function eliteTarget(cls: TransitionClass, tierWpm: number): number {
  return ikiForWpm(tierWpm) * CLASS_FACTOR[cls];
}

/* ------------------------------------------------------------------ *
 * Where you stand
 * ------------------------------------------------------------------ */

const MIN_SAMPLES = 6; // per bigram, before it is allowed to speak

/**
 * Your effective speed: the frequency-weighted average of how fast you
 * actually make each transition, expressed in wpm. This is measured from
 * ordinary practice, so it needs no test.
 */
export function currentLevel(
  model: SkillModel,
  engFreq: Map<string, number>,
): { wpm: number; iki: number; coverage: number } | null {
  let weight = 0;
  let weighted = 0;
  let covered = 0;
  let total = 0;
  for (const [bigram, freq] of engFreq) {
    total += freq;
    const s = model.bigrams.get(bigram);
    if (!s || s.count < MIN_SAMPLES) continue;
    weight += freq;
    weighted += freq * s.mean;
    covered += freq;
  }
  if (weight === 0 || covered / total < 0.25) return null;
  const iki = weighted / weight;
  return { wpm: wpmForIki(iki), iki, coverage: covered / total };
}

/** The standard being trained toward: the next rung above where you are. */
export function nextStandard(levelWpm: number | null): number {
  if (levelWpm === null) return TIERS[1];
  // a rung stays your standard until you clear it by a couple of percent, so
  // the target does not flip back and forth while you hover at a boundary
  const found = TIERS.find((t) => levelWpm < t * 1.02);
  return found ?? TIERS[TIERS.length - 1];
}

export interface Gap {
  bigram: string;
  cls: TransitionClass;
  mean: number;
  target: number;
  gap: number; // ms above the elite target
  freq: number;
  cost: number; // ms lost per unit of real English
  count: number;
  errorRate: number;
}

/**
 * Every measured transition, ranked by how much time it costs against the
 * standard: how far off it is, weighted by how often English asks for it.
 */
export function gaps(
  model: SkillModel,
  engFreq: Map<string, number>,
  tierWpm: number,
  minCount = MIN_SAMPLES,
): Gap[] {
  const out: Gap[] = [];
  for (const [bigram, freq] of engFreq) {
    const s = model.bigrams.get(bigram);
    if (!s || s.count < minCount) continue;
    const cls = classifyTransition(bigram[0], bigram[1]);
    if (!cls) continue;
    const target = eliteTarget(cls, tierWpm);
    const gap = Math.max(0, s.mean - target);
    const errorRate = model.errorRate(bigram);
    out.push({
      bigram,
      cls,
      mean: s.mean,
      target,
      gap,
      freq,
      // errors cost real time to fix, so they lift a pair's priority
      cost: freq * gap * (1 + 3 * errorRate),
      count: s.count,
      errorRate,
    });
  }
  out.sort((a, b) => b.cost - a.cost);
  return out;
}

/** Which kind of movement is costing the most overall. */
export function dominantClass(list: Gap[]): TransitionClass | null {
  const byClass = new Map<TransitionClass, number>();
  for (const g of list.slice(0, 40)) {
    byClass.set(g.cls, (byClass.get(g.cls) ?? 0) + g.cost);
  }
  let best: TransitionClass | null = null;
  let bestCost = 0;
  for (const [cls, cost] of byClass) {
    if (cost > bestCost) {
      bestCost = cost;
      best = cls;
    }
  }
  return best;
}

/** Per-destination-key distance from the standard, for the ambient map. */
export function keyGaps(model: SkillModel, tierWpm: number): Map<string, number> {
  const acc = new Map<string, { w: number; sum: number }>();
  for (const [bigram, s] of model.bigrams) {
    if (s.count < 3) continue;
    const cls = classifyTransition(bigram[0], bigram[1]);
    if (!cls) continue;
    const key = bigram[1];
    const a = acc.get(key) ?? { w: 0, sum: 0 };
    a.w += s.count;
    a.sum += (s.mean - eliteTarget(cls, tierWpm)) * s.count;
    acc.set(key, a);
  }
  const out = new Map<string, number>();
  for (const [k, a] of acc) out.set(k, a.sum / a.w);
  return out;
}

/** How far each kind of movement sits from the standard. */
export function classStanding(
  model: SkillModel,
  tierWpm: number,
): { cls: TransitionClass; mean: number; target: number; samples: number }[] {
  const acc = new Map<TransitionClass, { w: number; sum: number }>();
  for (const [bigram, s] of model.bigrams) {
    if (s.count < 3) continue;
    const cls = classifyTransition(bigram[0], bigram[1]);
    if (!cls) continue;
    const a = acc.get(cls) ?? { w: 0, sum: 0 };
    a.w += s.count;
    a.sum += s.mean * s.count;
    acc.set(cls, a);
  }
  return [...acc.entries()]
    .map(([cls, a]) => ({
      cls,
      mean: a.sum / a.w,
      target: eliteTarget(cls, tierWpm),
      samples: a.w,
    }))
    .sort((x, y) => y.mean / y.target - x.mean / x.target);
}

/* ------------------------------------------------------------------ *
 * The shape of your mistakes
 * ------------------------------------------------------------------ */

export interface ErrorPattern {
  bigram: string;
  cls: TransitionClass;
  /** what you hit instead of the intended key */
  wrongChar: string;
  count: number;
  /** the wrong key was the *next* letter: the hands ran out of order */
  transposition: boolean;
  /** a plain sentence describing the fault */
  say: string;
}

const show = (bg: string) => bg.replace(/ /g, "␣");
const showChar = (c: string) => (c === " " ? "␣" : c);

/**
 * Not "you make mistakes here" but "you hit r when you mean t, and it happens
 * because both live on the same finger". Transpositions are called out
 * separately because they are a timing fault, not an aiming one — the fix is
 * to even out the pair, not to hunt for the key.
 */
export function errorPatterns(model: SkillModel, limit = 5): ErrorPattern[] {
  const out: ErrorPattern[] = [];
  for (const [bigram, s] of model.bigrams) {
    if (s.errors < 2) continue;
    const cls = classifyTransition(bigram[0], bigram[1]);
    if (!cls) continue;
    const top = model.topConfusion(bigram);
    if (!top) continue;
    const intended = bigram[1];
    const transposition = s.transposed >= Math.max(2, s.errors * 0.4);
    const say = transposition
      ? `you type ${show(bigram[0] + top.char)} before ${showChar(intended)} — the second hand is arriving early`
      : `you hit ${showChar(top.char)} instead of ${showChar(intended)}`;
    out.push({ bigram, cls, wrongChar: top.char, count: top.count, transposition, say });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * Session shape
 * ------------------------------------------------------------------ */

export type Phase = "warmup" | "focus" | "stretch" | "precision";

const WARMUP_LINES = 3;
const CYCLE: { phase: Phase; lines: number }[] = [
  { phase: "focus", lines: 8 },
  { phase: "stretch", lines: 4 },
  { phase: "precision", lines: 4 },
];
const CYCLE_LINES = CYCLE.reduce((a, p) => a + p.lines, 0);

export interface PhaseState {
  phase: Phase;
  indexInPhase: number; // 0-based
  phaseLines: number;
}

/** Where a session is in its shape, from the number of lines typed so far. */
export function phaseAt(lineIndex: number): PhaseState {
  if (lineIndex < WARMUP_LINES) {
    return { phase: "warmup", indexInPhase: lineIndex, phaseLines: WARMUP_LINES };
  }
  let n = (lineIndex - WARMUP_LINES) % CYCLE_LINES;
  for (const p of CYCLE) {
    if (n < p.lines) return { phase: p.phase, indexInPhase: n, phaseLines: p.lines };
    n -= p.lines;
  }
  return { phase: "focus", indexInPhase: 0, phaseLines: CYCLE[0].lines };
}

/* ------------------------------------------------------------------ *
 * Closing a set
 * ------------------------------------------------------------------ */

export interface SetChange {
  pair: string; // display form, spaces shown as ␣
  from: number;
  to: number;
  better: boolean;
}

export interface SetSummary {
  title: string;
  /** the headline: did the work land */
  verdict: string;
  /** at most three concrete changes */
  changes: SetChange[];
}

const MIN_MOVE_MS = 3; // below this a change is noise, not progress

/**
 * What a set actually did. This is the only place the app looks backwards, and
 * it does it in three lines — the point is to see the needle move, then move on.
 */
export function summarizeSet(input: {
  phase: Phase;
  setNumber: number;
  targets: string[];
  before: Map<string, number>;
  after: Map<string, number>;
  wpms: number[];
  prevPhaseWpm: number | null;
}): SetSummary {
  const { phase, setNumber, targets, before, after, wpms, prevPhaseWpm } = input;
  const title = `${PHASE_TITLE[phase]} · set ${setNumber}`;
  const avg = wpms.length > 0 ? wpms.reduce((a, b) => a + b, 0) / wpms.length : null;

  const moved: { bigram: string; from: number; to: number }[] = [];
  for (const bg of targets) {
    const from = before.get(bg);
    const to = after.get(bg);
    if (from === undefined || to === undefined) continue;
    if (Math.abs(from - to) < MIN_MOVE_MS) continue;
    moved.push({ bigram: bg, from, to });
  }
  moved.sort((a, b) => a.to - a.from - (b.to - b.from)); // biggest gain first

  const faster = moved.filter((m) => m.to < m.from).length;
  const changes: SetChange[] = moved.slice(0, 3).map((m) => ({
    pair: show(m.bigram),
    from: Math.round(m.from),
    to: Math.round(m.to),
    better: m.to < m.from,
  }));

  let verdict: string;
  if (moved.length > 0) {
    verdict = `${faster} of ${moved.length} faster`;
  } else if (avg !== null && prevPhaseWpm !== null) {
    const d = avg - prevPhaseWpm;
    verdict =
      Math.abs(d) < 1
        ? `holding at ${avg.toFixed(0)} wpm`
        : `${avg.toFixed(0)} wpm, ${d > 0 ? "up" : "down"} ${Math.abs(d).toFixed(0)}`;
  } else if (avg !== null) {
    verdict = `${avg.toFixed(0)} wpm`;
  } else {
    verdict = "done";
  }

  return { title, verdict, changes };
}

export interface Instruction {
  phase: Phase;
  /** short name of what is happening, e.g. "Focus" */
  title: string;
  /** the coach speaking: what to do with your attention right now */
  say: string;
  /** pairs this line is built around (empty for untargeted phases) */
  targets: string[];
  /** shorter lines for stretch work */
  lineLength: number;
  /** how much of the line should carry the targets */
  density: number;
}

const PHASE_TITLE: Record<Phase, string> = {
  warmup: "Warm up",
  focus: "Focus",
  stretch: "Stretch",
  precision: "Precision",
};

/** Written to sit inside "Right now, ___ are costing you the most time." */
const COACH_PHRASE: Record<TransitionClass, string> = {
  alternating: "your hand switches",
  space: "the moves in and out of the space bar",
  "same-hand-roll": "your same-hand rolls",
  "same-hand-stretch": "the awkward reaches inside one hand",
  repeat: "your double letters",
  shift: "the keys you reach with shift held",
  "same-finger": "the pairs where one finger has to fire twice",
};

/**
 * What to do, right now. The only thing the app asks you to hold in your head.
 */
export function instruct(
  phaseState: PhaseState,
  ranked: Gap[],
  focusClass: TransitionClass | null,
): Instruction {
  const { phase } = phaseState;
  const title = PHASE_TITLE[phase];

  if (phase === "warmup") {
    return {
      phase,
      title,
      say: "Settle in. Nothing targeted yet.",
      targets: [],
      lineLength: 52,
      density: 0,
    };
  }

  if (phase === "stretch") {
    return {
      phase,
      title,
      say: "Short bursts, faster than feels safe. Messy is fine.",
      targets: [],
      lineLength: 30,
      density: 0,
    };
  }

  const top = ranked.slice(0, 6).map((g) => g.bigram);

  if (phase === "precision") {
    return {
      phase,
      title,
      say: "Every key clean. Mistakes have to be fixed before the line moves on.",
      targets: top,
      lineLength: 52,
      density: 0.4,
    };
  }

  const phrase = focusClass ? COACH_PHRASE[focusClass] : null;
  const pairs = ranked.slice(0, 3).map((g) => show(g.bigram));
  const say = phrase
    ? `${capitalize(phrase)} — chasing ${pairs.join(", ")}.`
    : "Keeping the whole keyboard moving.";

  return { phase, title, say, targets: top, lineLength: 56, density: 0.5 };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
