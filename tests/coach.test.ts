import { describe, it, expect } from "vitest";
import { SkillModel } from "../src/core/model";
import {
  CLASS_FACTOR,
  TIERS,
  classStanding,
  currentLevel,
  dominantClass,
  eliteTarget,
  errorPatterns,
  gaps,
  ikiForWpm,
  instruct,
  nextStandard,
  phaseAt,
  summarizeSet,
  wpmForIki,
} from "../src/core/coach";

describe("elite standards", () => {
  it("converts between wpm and keystroke time exactly", () => {
    // wpm counts a "word" as 5 characters
    expect(ikiForWpm(120)).toBeCloseTo(100, 6);
    expect(ikiForWpm(150)).toBeCloseTo(80, 6);
    expect(ikiForWpm(200)).toBeCloseTo(60, 6);
    expect(wpmForIki(100)).toBeCloseTo(120, 6);
    expect(wpmForIki(ikiForWpm(173))).toBeCloseTo(173, 6);
  });

  it("gives slower movements more generous targets than alternation", () => {
    const t = 150;
    expect(eliteTarget("same-finger", t)).toBeGreaterThan(eliteTarget("same-hand-stretch", t));
    expect(eliteTarget("same-hand-stretch", t)).toBeGreaterThan(eliteTarget("same-hand-roll", t));
    expect(eliteTarget("same-hand-roll", t)).toBeGreaterThan(eliteTarget("alternating", t));
    // alternation is the fastest movement there is
    expect(CLASS_FACTOR.alternating).toBeLessThan(1);
    expect(CLASS_FACTOR["same-finger"]).toBeGreaterThan(1.5);
  });

  it("scales every target with the tier", () => {
    expect(eliteTarget("alternating", 200)).toBeLessThan(eliteTarget("alternating", 120));
  });
});

/** a model where every listed bigram was typed at `iki` ms */
function modelWith(pairs: Record<string, number>, count = 20): SkillModel {
  const m = new SkillModel();
  for (const [bg, iki] of Object.entries(pairs)) {
    for (let i = 0; i < count; i++) m.recordSample(bg, iki, true);
  }
  return m;
}

describe("where you stand", () => {
  const engFreq = new Map<string, number>([
    ["th", 0.4],
    ["er", 0.3],
    ["in", 0.3],
  ]);

  it("reads your speed from ordinary practice, no test needed", () => {
    const m = modelWith({ th: 100, er: 100, in: 100 });
    const level = currentLevel(m, engFreq)!;
    expect(level.wpm).toBeCloseTo(120, 4); // 100ms per key == 120 wpm
  });

  it("weights the estimate by how often English uses each pair", () => {
    // the frequent pair is slow, the rare ones fast
    const m = modelWith({ th: 200, er: 50, in: 50 });
    const level = currentLevel(m, engFreq)!;
    // 0.4*200 + 0.3*50 + 0.3*50 = 110ms
    expect(level.iki).toBeCloseTo(110, 4);
  });

  it("stays silent until it has seen enough of the language", () => {
    const m = modelWith({ th: 100 }); // only 40% coverage... but below the bar with one pair
    const sparse = new Map<string, number>([
      ["th", 0.1],
      ["er", 0.9],
    ]);
    expect(currentLevel(m, sparse)).toBeNull();
  });

  it("aims at the next rung above where you are", () => {
    expect(nextStandard(null)).toBe(TIERS[1]);
    expect(nextStandard(105)).toBe(120);
    expect(nextStandard(130)).toBe(140);
    // already at the top of the ladder
    expect(nextStandard(260)).toBe(TIERS[TIERS.length - 1]);
  });

  it("keeps a rung as the standard until you clearly clear it", () => {
    expect(nextStandard(119.9)).toBe(120);
    expect(nextStandard(120)).toBe(120); // met it, but not clear of it yet
    expect(nextStandard(123)).toBe(140); // now past it
  });
});

describe("what to work on", () => {
  const engFreq = new Map<string, number>([
    ["th", 0.5], // hand alternation, common
    ["ed", 0.3], // same finger (e and d share a finger)
    ["ju", 0.2],
  ]);

  it("ranks by time lost against the standard, not raw slowness", () => {
    // 'ed' is slower in absolute terms, but it is a same-finger pair so its
    // target is lenient, and it is rarer
    const m = modelWith({ th: 130, ed: 150, ju: 90 });
    const ranked = gaps(m, engFreq, 150);
    expect(ranked[0].bigram).toBe("th");
  });

  it("gives a pair no gap once it meets its own target", () => {
    const fast = ikiForWpm(150) * CLASS_FACTOR["same-finger"] - 5;
    const m = modelWith({ ed: fast });
    const ranked = gaps(m, new Map([["ed", 0.5]]), 150);
    expect(ranked[0].gap).toBe(0);
  });

  it("lifts pairs you keep fumbling", () => {
    const clean = modelWith({ th: 140 });
    const messy = modelWith({ th: 140 });
    messy.recordErrors("th", 15);
    const f = new Map([["th", 0.5]]);
    expect(gaps(messy, f, 150)[0].cost).toBeGreaterThan(gaps(clean, f, 150)[0].cost * 1.5);
  });

  it("ignores pairs it has barely seen", () => {
    const m = modelWith({ th: 300 }, 2);
    expect(gaps(m, engFreq, 150)).toHaveLength(0);
  });

  it("names the kind of movement costing the most", () => {
    const m = modelWith({ th: 130, ed: 260, ju: 90 });
    const ranked = gaps(m, engFreq, 150);
    expect(dominantClass(ranked)).toBe("same-finger");
  });

  it("sorts the standing by how far each movement is from its own target", () => {
    const m = modelWith({ th: 200, ju: 70 });
    const standing = classStanding(m, 150);
    expect(standing[0].cls).toBe("alternating"); // th is 200 vs a 68ms target
    expect(standing[0].mean).toBeCloseTo(200, 4);
  });
});

describe("the shape of your mistakes", () => {
  it("says what you hit instead, not just that you erred", () => {
    const m = modelWith({ th: 120 });
    m.recordErrors("th", 3, { wrongChars: ["r", "r", "y"] });
    const [p] = errorPatterns(m);
    expect(p.wrongChar).toBe("r");
    expect(p.say).toBe("you hit r instead of h");
    expect(p.transposition).toBe(false);
  });

  it("calls out an out-of-order pair as a timing fault, not an aiming one", () => {
    const m = modelWith({ th: 120 });
    // typed 'e' where 'h' was due, and 'e' is what came next: t-e-h instead of t-h-e
    m.recordErrors("th", 1, { wrongChars: ["e"], transposed: true });
    m.recordErrors("th", 1, { wrongChars: ["e"], transposed: true });
    m.recordErrors("th", 1, { wrongChars: ["e"], transposed: true });
    const [p] = errorPatterns(m);
    expect(p.transposition).toBe(true);
    expect(p.say).toContain("arriving early");
  });

  it("ignores one-off slips", () => {
    const m = modelWith({ th: 120 });
    m.recordErrors("th", 1, { wrongChars: ["r"] });
    expect(errorPatterns(m)).toHaveLength(0);
  });

  it("keeps the confusion record bounded", () => {
    const m = modelWith({ th: 120 });
    for (const c of "abcdefghijklmnop") m.recordErrors("th", 1, { wrongChars: [c] });
    const s = m.bigrams.get("th")!;
    expect(Object.keys(s.confusions).length).toBeLessThanOrEqual(6);
    expect(s.errors).toBe(16); // the count itself is never lost
  });
});

describe("closing a set", () => {
  const base = {
    phase: "focus" as const,
    setNumber: 3,
    targets: ["th", "ed"],
    wpms: [120, 124],
    prevPhaseWpm: null,
  };

  it("reports the pairs that moved, fastest gain first", () => {
    const s = summarizeSet({
      ...base,
      before: new Map([
        ["th", 200],
        ["ed", 180],
      ]),
      after: new Map([
        ["th", 150],
        ["ed", 175],
      ]),
    });
    expect(s.title).toBe("Focus · set 3");
    expect(s.verdict).toBe("2 of 2 faster");
    expect(s.changes[0]).toEqual({ pair: "th", from: 200, to: 150, better: true });
  });

  it("marks a pair that slipped so the report stays honest", () => {
    const s = summarizeSet({
      ...base,
      targets: ["th"],
      before: new Map([["th", 150]]),
      after: new Map([["th", 190]]),
    });
    expect(s.changes[0].better).toBe(false);
  });

  it("is honest when a pair went backwards", () => {
    const s = summarizeSet({
      ...base,
      before: new Map([["th", 150]]),
      after: new Map([["th", 190]]),
    });
    expect(s.verdict).toBe("0 of 1 faster");
  });

  it("ignores changes too small to mean anything", () => {
    const s = summarizeSet({
      ...base,
      before: new Map([["th", 150]]),
      after: new Map([["th", 151]]),
    });
    expect(s.changes).toHaveLength(0);
  });

  it("falls back to speed for sets with no targets", () => {
    const s = summarizeSet({
      ...base,
      phase: "stretch",
      targets: [],
      before: new Map(),
      after: new Map(),
      wpms: [130, 140],
      prevPhaseWpm: 128,
    });
    expect(s.verdict).toBe("135 wpm, up 7");
  });

  it("says so plainly when speed is holding steady", () => {
    const s = summarizeSet({
      ...base,
      phase: "stretch",
      targets: [],
      before: new Map(),
      after: new Map(),
      wpms: [130],
      prevPhaseWpm: 130.4,
    });
    expect(s.verdict).toContain("holding");
  });

  it("never shows more than three changes at once", () => {
    const targets = ["th", "ed", "in", "er", "an"];
    const before = new Map(targets.map((t, i) => [t, 200 + i]));
    const after = new Map(targets.map((t, i) => [t, 150 + i]));
    const s = summarizeSet({ ...base, targets, before, after });
    expect(s.changes.length).toBeLessThanOrEqual(3);
  });
});

describe("the shape of a session", () => {
  it("opens with a warm up", () => {
    expect(phaseAt(0).phase).toBe("warmup");
    expect(phaseAt(2).phase).toBe("warmup");
    expect(phaseAt(2).indexInPhase).toBe(2);
  });

  it("then cycles focus, stretch and precision forever", () => {
    expect(phaseAt(3).phase).toBe("focus");
    expect(phaseAt(10).phase).toBe("focus");
    expect(phaseAt(11).phase).toBe("stretch");
    expect(phaseAt(14).phase).toBe("stretch");
    expect(phaseAt(15).phase).toBe("precision");
    expect(phaseAt(18).phase).toBe("precision");
    // back around
    expect(phaseAt(19).phase).toBe("focus");
    expect(phaseAt(19).indexInPhase).toBe(0);
  });

  it("reports position within the current set", () => {
    const p = phaseAt(12);
    expect(p.phase).toBe("stretch");
    expect(p.indexInPhase).toBe(1);
    expect(p.phaseLines).toBe(4);
  });
});

describe("the coach's instruction", () => {
  const ranked = gaps(
    modelWith({ th: 200, ed: 260 }),
    new Map([
      ["th", 0.5],
      ["ed", 0.5],
    ]),
    150,
  );

  it("leaves warm up and stretch untargeted", () => {
    for (const phase of [phaseAt(0), phaseAt(11)]) {
      const ins = instruct(phase, ranked, "same-finger");
      expect(ins.targets).toHaveLength(0);
      expect(ins.density).toBe(0);
    }
  });

  it("makes stretch lines short", () => {
    expect(instruct(phaseAt(11), ranked, null).lineLength).toBeLessThan(
      instruct(phaseAt(3), ranked, null).lineLength,
    );
  });

  it("targets the costly pairs during focus and names the movement in plain words", () => {
    const ins = instruct(phaseAt(3), ranked, "same-finger");
    expect(ins.targets.length).toBeGreaterThan(0);
    expect(ins.density).toBeGreaterThan(0);
    expect(ins.say).toContain("one finger has to fire twice");
    expect(ins.say).toContain("th"); // the pairs it is chasing
  });

  it("phrases every movement class so the line stays grammatical", () => {
    const classes = [
      "alternating",
      "space",
      "same-hand-roll",
      "same-hand-stretch",
      "repeat",
      "shift",
      "same-finger",
    ] as const;
    for (const cls of classes) {
      const say = instruct(phaseAt(3), ranked, cls).say;
      // opens with a capital, names pairs after a dash, ends cleanly
      expect(say).toMatch(/^[A-Z]\S*.* — chasing .+\.$/);
      expect(say).not.toMatch(/\s{2,}/);
    }
  });

  it("asks for clean keys, not speed, during precision", () => {
    const ins = instruct(phaseAt(15), ranked, "same-finger");
    expect(ins.targets.length).toBeGreaterThan(0);
    expect(ins.say.toLowerCase()).toContain("clean");
    expect(ins.say.toLowerCase()).not.toContain("faster");
  });

  it("keeps every instruction short enough to read at a glance", () => {
    // he asked for no long explanations: one short line, always
    for (const i of [0, 3, 11, 15]) {
      const say = instruct(phaseAt(i), ranked, "same-finger").say;
      expect(say.length).toBeLessThanOrEqual(80);
      expect(say.split(". ").length).toBeLessThanOrEqual(2);
    }
  });

  it("never mentions a score, a goal or a test", () => {
    for (const i of [0, 3, 11, 15]) {
      const say = instruct(phaseAt(i), ranked, "same-finger").say.toLowerCase();
      for (const word of ["goal", "test", "score", "record", "beat"]) {
        expect(say).not.toContain(word);
      }
    }
  });
});
