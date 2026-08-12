// The coach: decides what you practise right now, measured against the next
// elite standard rather than against your own past. There are no goals to tick
// off and nothing to pass or fail — the standard is fixed by physics and the
// coach simply keeps pointing you at whatever is furthest from it.

import { classifyTransition, type TransitionClass } from "./keyboard";
import { trendOf, type SkillModel } from "./model";

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
  // the thumb travels almost nowhere, the key is enormous, and it is nearly
  // always overlapping with the other hand — this is the fastest thing you do
  space: 0.75,
  alternating: 0.85,
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
  /** ms this pair has come down lately; positive means practice is landing */
  trend: number;
}

/**
 * How far the coach will follow a hunch about a transition it has barely
 * measured. A pair seen a handful of times might be much worse than its average
 * says, and the only way to find out is to put it in front of you.
 */
const EXPLORE_C = 0.15;

/**
 * Every measured transition, ranked by what it costs against the standard.
 *
 * Frequency is deliberately damped by a square root. Raw frequency is brutally
 * top-heavy — 38% of English transitions touch the space bar, and 21 of the 40
 * commonest pairs involve it — so weighting by it directly lets a handful of
 * pairs own the coach forever. The square root keeps common pairs ahead of rare
 * ones without letting them monopolise.
 *
 * An unsteady pair is also lifted: erratic timing means the movement is still
 * being decided rather than executed, and that is exactly what practice fixes.
 *
 * Two further terms decide where a minute is best spent rather than merely
 * where the most time is being lost. A pair that is still coming down under
 * practice earns more of your attention than one that has settled at the same
 * distance from the standard — the same minute buys more there. And a pair the
 * coach has barely measured carries an optimism bonus, because an average taken
 * from a handful of samples might be hiding something worse. Neither term can
 * silence a pair: a plateaued transition is weighted down, never dropped.
 */
export function gaps(
  model: SkillModel,
  engFreq: Map<string, number>,
  tierWpm: number,
  minCount = MIN_SAMPLES,
): Gap[] {
  const out: Gap[] = [];
  // anything typed but absent from the word list (punctuation, capitals,
  // invented words) is weighted by how often it actually comes up for you
  let totalAttempts = 0;
  let totalSamples = 0;
  for (const s of model.bigrams.values()) {
    totalAttempts += s.attempts;
    totalSamples += s.count;
  }
  const logTotal = Math.log(totalSamples + 1);

  for (const [bigram, s] of model.bigrams) {
    if (s.count < minCount) continue;
    const cls = classifyTransition(bigram[0], bigram[1]);
    if (!cls) continue;
    const freq =
      engFreq.get(bigram) ?? (totalAttempts > 0 ? s.attempts / totalAttempts : 0);
    if (freq <= 0) continue;
    const target = eliteTarget(cls, tierWpm);
    const gap = Math.max(0, s.mean - target);
    const errorRate = model.errorRate(bigram);
    const sd = Math.sqrt(Math.max(0, s.m2));
    const cv = s.mean > 0 ? Math.min(1, sd / s.mean) : 0;
    const trend = trendOf(s);
    // moving half the remaining gap in the recent window counts as fully
    // responsive; a flat pair keeps a floor of 0.6 rather than falling away
    const responsiveness = gap > 0 ? Math.max(0, Math.min(1, trend / (gap * 0.5))) : 0;
    const learn = 0.6 + 0.8 * responsiveness;
    const optimism = EXPLORE_C * target * Math.sqrt(logTotal / s.count);
    out.push({
      bigram,
      cls,
      mean: s.mean,
      target,
      gap,
      freq,
      cost: Math.sqrt(freq) * (gap * learn * (1 + 3 * errorRate) * (1 + cv) + optimism),
      count: s.count,
      errorRate,
      trend,
    });
  }
  out.sort((a, b) => b.cost - a.cost);
  return out;
}

/** How many pairs of one movement type may fill a single set. */
const MAX_PER_CLASS = 2;

export interface Focus {
  targets: string[];
  cls: TransitionClass | null;
}

/**
 * Picks what a set is built from. Two rules keep practice from going stale:
 * no more than a couple of pairs from the same kind of movement, and a
 * deliberate change of subject from the set before — there is always more than
 * one thing worth fixing, and rotating between them is what keeps the work
 * feeling alive.
 */
export function selectFocus(
  ranked: Gap[],
  opts: { avoidClass?: TransitionClass | null; size?: number } = {},
): Focus {
  const size = opts.size ?? 6;
  const withGap = ranked.filter((g) => g.gap > 0);
  if (withGap.length === 0) return { targets: [], cls: null };

  // compare the average cost of a pair in each class, not the total: a class
  // simply having more pairs measured should not make it look worse
  const byClass = new Map<TransitionClass, { sum: number; n: number }>();
  for (const g of withGap.slice(0, 40)) {
    const a = byClass.get(g.cls) ?? { sum: 0, n: 0 };
    a.sum += g.cost;
    a.n++;
    byClass.set(g.cls, a);
  }
  const ordered = [...byClass.entries()]
    .map(([cls, a]) => [cls, a.sum / a.n] as [TransitionClass, number])
    .sort((a, b) => b[1] - a[1]);
  let lead = ordered[0]?.[0] ?? null;
  // move on to the next-worst movement if it is nearly as costly
  if (opts.avoidClass && lead === opts.avoidClass && ordered.length > 1) {
    const [, bestCost] = ordered[0];
    const [nextCls, nextCost] = ordered[1];
    if (nextCost >= bestCost * 0.5) lead = nextCls;
  }

  const targets: string[] = [];
  const used = new Map<TransitionClass, number>();
  // the leading movement goes in first, then the field fills the rest
  for (const pass of [true, false]) {
    for (const g of withGap) {
      if (targets.length >= size) break;
      if (pass !== (g.cls === lead)) continue;
      const n = used.get(g.cls) ?? 0;
      if (n >= MAX_PER_CLASS) continue;
      used.set(g.cls, n + 1);
      targets.push(g.bigram);
    }
  }
  return { targets, cls: lead };
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
 * Flow: overlap and evenness
 * ------------------------------------------------------------------ */

export interface Flow {
  /** share of keystrokes begun before the previous key was released */
  rollover: number;
  /** 1 = metronomic, 0 = wildly uneven */
  rhythm: number;
  samples: number;
}

/**
 * The two habits that separate a fast typist from an elite one, and the two the
 * app can see but you cannot feel reliably.
 *
 * Rollover is overlap — pressing the next key before letting the last one go.
 * The largest study of typing found the quickest typists overlap on roughly
 * 40–70% of keystrokes; slow typists finish each key before starting the next.
 *
 * Rhythm is evenness. Two typists can average the same speed while one moves
 * in smooth chunks and the other in lurches, and only the smooth one is close
 * to the next tier — evenness means the movement has stopped being a decision.
 */
export function flowStanding(model: SkillModel): Flow {
  let roll = 0;
  let n = 0;
  let weighted = 0;
  let weight = 0;
  for (const s of model.bigrams.values()) {
    if (s.count === 0) continue;
    roll += s.rollover;
    n += s.count;
    if (s.count >= 4 && s.mean > 0) {
      const cv = Math.min(1, Math.sqrt(Math.max(0, s.m2)) / s.mean);
      weighted += (1 - cv) * s.count;
      weight += s.count;
    }
  }
  return {
    rollover: n > 0 ? roll / n : 0,
    rhythm: weight > 0 ? weighted / weight : 0,
    samples: n,
  };
}

/** Below this, overlap is worth calling out as the thing holding you back. */
export const ROLLOVER_TARGET = 0.4;

/* ------------------------------------------------------------------ *
 * What you are allowed to meet, and when
 * ------------------------------------------------------------------ */

/**
 * Punctuation and capitals arrive in stages rather than all at once, so each
 * new movement gets a stretch of practice on its own. You start with sentences
 * — an experienced typist does not need to be walked through the alphabet.
 */
export const UNLOCKS: { level: number; marks: string[]; announce: string }[] = [
  { level: 0, marks: [], announce: "" },
  { level: 1, marks: [".", ","], announce: "Sentences now — capitals, full stops, commas." },
  { level: 2, marks: ["'"], announce: "Adding apostrophes." },
  { level: 3, marks: ["?", "!"], announce: "Adding question and exclamation marks." },
  { level: 4, marks: [";", ":", '"'], announce: "Adding semicolons, colons and quotes." },
  { level: 5, marks: ["-"], announce: "Adding hyphens — that is the full set." },
];

const MIN_MARK_SAMPLES = 25;
const READY_RATIO = 1.4; // within 40% of the elite target counts as settled

/**
 * How far through the punctuation ladder you are. A stage opens only once the
 * marks already in play are landing near their target — new symbols wait until
 * the last ones stopped being work.
 */
export function unlockLevel(model: SkillModel, tierWpm: number): number {
  let level = 1; // capitals and sentence punctuation from the start
  for (let i = 1; i < UNLOCKS.length - 1; i++) {
    const marks = new Set(UNLOCKS[i].marks);
    let samples = 0;
    let weighted = 0;
    for (const [bigram, s] of model.bigrams) {
      if (!marks.has(bigram[0]) && !marks.has(bigram[1])) continue;
      if (s.count === 0) continue;
      const cls = classifyTransition(bigram[0], bigram[1]);
      if (!cls) continue;
      samples += s.count;
      weighted += (s.mean / eliteTarget(cls, tierWpm)) * s.count;
    }
    if (samples < MIN_MARK_SAMPLES) break;
    if (weighted / samples > READY_RATIO) break;
    level = i + 1;
  }
  return level;
}

/** Every mark available at a given stage. */
export function marksFor(level: number): string[] {
  return UNLOCKS.filter((u) => u.level > 0 && u.level <= level).flatMap((u) => u.marks);
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

/**
 * How a sitting is shaped, and the one decision that is yours rather than the
 * coach's. The coach still chooses every transition you meet and every word you
 * type — but being told what to do for half an hour with no say in it is the
 * fastest way to make good practice feel like an obligation. One choice at the
 * door is enough to make the session yours.
 */
export type OpeningKey = "coach" | "loose" | "clean";

const CYCLES: Record<OpeningKey, { phase: Phase; lines: number }[]> = {
  coach: [
    { phase: "focus", lines: 8 },
    { phase: "stretch", lines: 4 },
    { phase: "precision", lines: 4 },
  ],
  loose: [
    { phase: "stretch", lines: 6 },
    { phase: "focus", lines: 6 },
    { phase: "precision", lines: 2 },
  ],
  clean: [
    { phase: "precision", lines: 6 },
    { phase: "focus", lines: 6 },
    { phase: "stretch", lines: 2 },
  ],
};

export interface Opening {
  key: OpeningKey;
  label: string;
  note: string;
}

/** The choice offered when a sitting begins. */
export function openings(lead: TransitionClass | null): Opening[] {
  return [
    {
      key: "coach",
      label: "Wherever it is worst",
      note: lead ? capitalize(COACH_PHRASE[lead]) : "Let the coach choose",
    },
    { key: "loose", label: "Loose and fast", note: "Bursts above comfort, mess allowed" },
    { key: "clean", label: "Clean", note: "Nothing wrong left behind" },
  ];
}

export interface PhaseState {
  phase: Phase;
  indexInPhase: number; // 0-based
  phaseLines: number;
}

/** Where a session is in its shape, from the number of lines typed so far. */
export function phaseAt(lineIndex: number, opening: OpeningKey = "coach"): PhaseState {
  if (lineIndex < WARMUP_LINES) {
    return { phase: "warmup", indexInPhase: lineIndex, phaseLines: WARMUP_LINES };
  }
  const cycle = CYCLES[opening] ?? CYCLES.coach;
  const cycleLines = cycle.reduce((a, p) => a + p.lines, 0);
  let n = (lineIndex - WARMUP_LINES) % cycleLines;
  for (const p of cycle) {
    if (n < p.lines) return { phase: p.phase, indexInPhase: n, phaseLines: p.lines };
    n -= p.lines;
  }
  return { phase: cycle[0].phase, indexInPhase: 0, phaseLines: cycle[0].lines };
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
  /** shorter passages for stretch work */
  lineLength: number;
  /** how much of the passage should carry the targets */
  density: number;
  /** punctuation currently in play */
  marks: string[];
  capitals: boolean;
}

const PHASE_TITLE: Record<Phase, string> = {
  warmup: "Warm up",
  focus: "Focus",
  stretch: "Stretch",
  precision: "Precision",
};

/** Written to sit inside "Right now, ___ are costing you the most time." */
export const COACH_PHRASE: Record<TransitionClass, string> = {
  alternating: "your hand switches",
  space: "the moves in and out of the space bar",
  "same-hand-roll": "your same-hand rolls",
  "same-hand-stretch": "the awkward reaches inside one hand",
  repeat: "your double letters",
  shift: "the keys you reach with shift held",
  "same-finger": "the pairs where one finger has to fire twice",
};

export interface InstructInput {
  phaseState: PhaseState;
  focus: Focus;
  flow: Flow;
  /** punctuation stage in play */
  marks: string[];
  /** set once, the first time a new stage opens */
  announce?: string | null;
  /** the coach has noticed you are tiring */
  tiring?: boolean;
  /** the last passage of the session: built from what you already own */
  finishing?: boolean;
  /** pairs already at the standard, for that last passage */
  settled?: string[];
}

/**
 * What to do, right now. The only thing the app asks you to hold in your head.
 */
export function instruct(input: InstructInput): Instruction {
  const { phaseState, focus, flow, marks, announce, tiring, finishing, settled } = input;
  const { phase } = phaseState;
  const title = PHASE_TITLE[phase];
  const common = { phase, title, marks, capitals: true };

  // finish on something you already own, never on the hardest thing you did
  if (finishing) {
    return {
      ...common,
      title: "Last one",
      say: "Nothing to chase here. Just type it.",
      targets: settled ?? [],
      lineLength: 150,
      density: 0.4,
    };
  }

  if (announce) {
    return { ...common, say: announce, targets: [], lineLength: 150, density: 0 };
  }

  if (phase === "warmup") {
    return {
      ...common,
      say: tiring
        ? "Easy does it. Let the hands wake up again."
        : "Settle in. Nothing targeted yet.",
      targets: [],
      lineLength: 150,
      density: 0,
    };
  }

  if (phase === "stretch") {
    // overlap is the single habit that separates the tiers; if it is missing,
    // this is the set to say so
    const say =
      flow.samples > 200 && flow.rollover < ROLLOVER_TARGET
        ? "Let the keys overlap — start the next before the last comes up."
        : "Short bursts, faster than feels safe. Messy is fine.";
    return { ...common, say, targets: [], lineLength: 64, density: 0 };
  }

  if (phase === "precision") {
    return {
      ...common,
      say: "Every key clean. Mistakes have to be fixed before the line moves on.",
      targets: focus.targets,
      lineLength: 130,
      density: 0.4,
    };
  }

  const phrase = focus.cls ? COACH_PHRASE[focus.cls] : null;
  const pairs = focus.targets.slice(0, 3).map(show);
  const say = tiring
    ? "You are drifting — ease off and let the rhythm come back."
    : phrase && pairs.length > 0
      ? `${capitalize(phrase)} — chasing ${pairs.join(", ")}.`
      : "Keeping the whole keyboard moving.";

  return { ...common, say, targets: focus.targets, lineLength: 150, density: 0.5 };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ------------------------------------------------------------------ *
 * Knowing when to stop
 * ------------------------------------------------------------------ */

/** A gap this long means you got up and came back: warm up again. */
export const NEW_SITTING_MS = 20 * 60 * 1000;

/** Before this the coach keeps quiet — a session has barely begun. */
export const MIN_SESSION_MS = 8 * 60 * 1000;
/** Past this it offers the door whether or not anything has slipped. */
export const LONG_SESSION_MS = 35 * 60 * 1000;

/**
 * Whether the recent lines are sliding — slower and messier than the ones
 * before them. Practising through this teaches the mistakes, so the coach eases
 * off rather than pushing on.
 */
export function isTiring(recent: { wpm: number; accuracy: number }[]): boolean {
  if (recent.length < 12) return false;
  const tail = recent.slice(-6);
  const before = recent.slice(-12, -6);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const wpmDrop = mean(before.map((r) => r.wpm)) - mean(tail.map((r) => r.wpm));
  const accDrop = mean(before.map((r) => r.accuracy)) - mean(tail.map((r) => r.accuracy));
  return wpmDrop > mean(before.map((r) => r.wpm)) * 0.08 && accDrop > 0.01;
}

/**
 * When to offer the door. Not a clock: a session should end when another
 * passage has stopped buying anything, and typing on past that point rehearses
 * the degraded version of the movement rather than the good one. Slipping speed
 * *and* slipping accuracy together is the signal — either alone is just you
 * deliberately changing gear.
 */
export function shouldClose(input: {
  elapsedMs: number;
  tiring: boolean;
  atSetBoundary: boolean;
}): boolean {
  if (!input.atSetBoundary) return false;
  if (input.elapsedMs < MIN_SESSION_MS) return false;
  return input.tiring || input.elapsedMs > LONG_SESSION_MS;
}

/**
 * The transitions already at the standard. The last passage of a session is
 * built from these on purpose: you remember an experience by its best moment
 * and its last one, not by its average, and there is no reason for the last
 * thing your hands do today to be the hardest thing they did.
 */
export function settledPairs(ranked: Gap[], size = 6): string[] {
  const settled = ranked.filter((g) => g.gap === 0);
  const pool = settled.length >= size ? settled : [...ranked].sort((a, b) => a.gap - b.gap);
  return pool.slice(0, size).map((g) => g.bigram);
}

/**
 * The whole standing in one sentence. Everything below it on that page is
 * detail for when you want detail — this is the part you should be able to read
 * in two seconds without being a data scientist about it.
 */
export function headline(input: {
  levelWpm: number | null;
  tier: number;
  lead: TransitionClass | null;
}): string {
  const { levelWpm, tier, lead } = input;
  if (levelWpm === null) {
    return "Not enough typing yet to say where you stand. A few more minutes will do it.";
  }
  const where = `You are typing at ${levelWpm.toFixed(0)}.`;
  if (!lead) return `${where} Nothing is far off the standard right now.`;
  return `${where} ${capitalize(COACH_PHRASE[lead])} are what stand between you and ${tier}.`;
}

export interface SessionReport {
  title: string;
  body: string;
  /** what moved, and what is waiting — a session that closes cleanly is a
   *  session with no reason to come back to */
  thread: string | null;
}

export function sessionReport(input: {
  minutes: number;
  passages: number;
  changes: SetChange[];
  nextPhrase: string | null;
}): SessionReport {
  const { minutes, passages, changes, nextPhrase } = input;
  const gains = changes.filter((c) => c.better).sort((a, b) => b.from - b.to - (a.from - a.to));
  const best = gains[0];
  const thread = best
    ? `${best.pair} came down ${Math.round(best.from - best.to)}ms today` +
      (nextPhrase ? `, and ${nextPhrase} is where we pick up.` : ".")
    : nextPhrase
      ? `${capitalize(nextPhrase)} is where we pick up.`
      : null;
  const parts: string[] = [];
  // a session that rounds to zero minutes should not say so
  if (minutes >= 1) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  parts.push(`${passages} ${passages === 1 ? "passage" : "passages"}`);
  return {
    title: "That is a session.",
    body: `${parts.join(", ")}. The hands keep learning after you walk away.`,
    thread,
  };
}
