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
  flowStanding,
  gaps,
  headline,
  ikiForWpm,
  instruct,
  isTiring,
  marksFor,
  nextStandard,
  openings,
  phaseAt,
  selectFocus,
  sessionReport,
  settledPairs,
  shouldClose,
  summarizeSet,
  unlockLevel,
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

describe("keeping the work varied", () => {
  // a model where space pairs are both the commonest and among the slowest,
  // which is the situation that used to let them own every set
  function spaceHeavy() {
    const m = new SkillModel();
    const slow: Record<string, number> = {
      " t": 150, "e ": 150, " a": 150, "s ": 150, " o": 150, "t ": 150,
      ed: 220, un: 215, ce: 210, // same-finger, rarer but further from target
      th: 140, he: 138,
    };
    for (const [bg, iki] of Object.entries(slow)) {
      for (let i = 0; i < 20; i++) m.recordSample(bg, iki, true);
    }
    return m;
  }
  const freq = new Map<string, number>([
    [" t", 0.036], ["e ", 0.044], [" a", 0.022], ["s ", 0.022], [" o", 0.018], ["t ", 0.017],
    ["ed", 0.004], ["un", 0.003], ["ce", 0.003], ["th", 0.031], ["he", 0.026],
  ]);

  it("does not let one kind of movement fill the whole set", () => {
    const ranked = gaps(spaceHeavy(), freq, 150);
    const focus = selectFocus(ranked);
    const counts = new Map<string, number>();
    for (const bg of focus.targets) {
      const cls = ranked.find((g) => g.bigram === bg)!.cls;
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
    expect(counts.size).toBeGreaterThan(1); // more than one thing to work on
  });

  it("changes subject when asked to avoid the last set's movement", () => {
    const ranked = gaps(spaceHeavy(), freq, 150);
    const first = selectFocus(ranked);
    const second = selectFocus(ranked, { avoidClass: first.cls });
    expect(second.cls).not.toBe(first.cls);
  });

  it("stays on the worst movement if nothing else is close", () => {
    const m = new SkillModel();
    for (let i = 0; i < 20; i++) {
      m.recordSample("ed", 400, false); // ruinous
      m.recordSample("th", 66, true); // already at target
    }
    const ranked = gaps(m, new Map([["ed", 0.3], ["th", 0.3]]), 150);
    expect(selectFocus(ranked, { avoidClass: "same-finger" }).cls).toBe("same-finger");
  });

  it("prefers a steady pair over an erratic one of equal speed", () => {
    const steady = new SkillModel();
    const erratic = new SkillModel();
    for (let i = 0; i < 30; i++) {
      steady.recordSample("th", 150, true);
      erratic.recordSample("th", i % 2 === 0 ? 80 : 220, true);
    }
    const f = new Map([["th", 0.3]]);
    expect(gaps(erratic, f, 150)[0].cost).toBeGreaterThan(gaps(steady, f, 150)[0].cost);
  });

  it("gives nothing to work on when everything already meets the standard", () => {
    const m = new SkillModel();
    for (let i = 0; i < 20; i++) m.recordSample("th", 50, true);
    expect(selectFocus(gaps(m, new Map([["th", 0.3]]), 150)).targets).toHaveLength(0);
  });
});

describe("overlap and evenness", () => {
  it("reads overlap straight from the keystrokes", () => {
    const m = new SkillModel();
    for (let i = 0; i < 10; i++) m.recordSample("th", 120, i < 6); // 6 of 10 overlapped
    expect(flowStanding(m).rollover).toBeCloseTo(0.6, 5);
  });

  it("scores a metronomic hand above a lurching one", () => {
    const even = new SkillModel();
    const lurchy = new SkillModel();
    for (let i = 0; i < 30; i++) {
      even.recordSample("th", 120, true);
      lurchy.recordSample("th", i % 2 === 0 ? 60 : 200, true);
    }
    expect(flowStanding(even).rhythm).toBeGreaterThan(flowStanding(lurchy).rhythm);
    expect(flowStanding(even).rhythm).toBeGreaterThan(0.9);
  });
});

describe("meeting punctuation a stage at a time", () => {
  it("starts you on sentences, not on bare letters", () => {
    expect(unlockLevel(new SkillModel(), 150)).toBe(1);
    expect(marksFor(1)).toEqual([".", ","]);
  });

  it("holds the next stage back until the current marks settle", () => {
    const m = new SkillModel();
    // full stops are being typed, but slowly
    for (let i = 0; i < 40; i++) m.recordSample("e.", 400, false);
    expect(unlockLevel(m, 150)).toBe(1);
  });

  it("opens the next stage once they land near the target", () => {
    const m = new SkillModel();
    for (let i = 0; i < 40; i++) {
      m.recordSample("e.", 70, true);
      m.recordSample("t,", 70, true);
    }
    expect(unlockLevel(m, 150)).toBeGreaterThan(1);
  });

  it("hands the generator every mark unlocked so far", () => {
    expect(marksFor(3)).toContain("'");
    expect(marksFor(3)).toContain("?");
    expect(marksFor(3)).not.toContain(";");
  });
});

describe("knowing when to ease off", () => {
  const steady = Array.from({ length: 14 }, () => ({ wpm: 120, accuracy: 0.98 }));

  it("says nothing while you are holding your level", () => {
    expect(isTiring(steady)).toBe(false);
  });

  it("notices when speed and accuracy slide together", () => {
    const sliding = [
      ...Array.from({ length: 6 }, () => ({ wpm: 130, accuracy: 0.99 })),
      ...Array.from({ length: 6 }, () => ({ wpm: 112, accuracy: 0.95 })),
    ];
    expect(isTiring(sliding)).toBe(true);
  });

  it("does not call slowing down alone fatigue", () => {
    // easing off on purpose, still clean: that is precision work, not tiring
    const careful = [
      ...Array.from({ length: 6 }, () => ({ wpm: 130, accuracy: 0.97 })),
      ...Array.from({ length: 6 }, () => ({ wpm: 110, accuracy: 0.995 })),
    ];
    expect(isTiring(careful)).toBe(false);
  });

  it("waits for enough evidence before judging", () => {
    expect(isTiring([{ wpm: 200, accuracy: 1 }, { wpm: 50, accuracy: 0.5 }])).toBe(false);
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
  const focus = selectFocus(ranked);
  const calmFlow = { rollover: 0.5, rhythm: 0.8, samples: 500 };
  const say = (i: number, over: Partial<Parameters<typeof instruct>[0]> = {}) =>
    instruct({ phaseState: phaseAt(i), focus, flow: calmFlow, marks: [".", ","], ...over });

  it("leaves warm up and stretch untargeted", () => {
    for (const i of [0, 11]) {
      const ins = say(i);
      expect(ins.targets).toHaveLength(0);
      expect(ins.density).toBe(0);
    }
  });

  it("makes stretch passages shorter than focus ones", () => {
    expect(say(11).lineLength).toBeLessThan(say(3).lineLength);
  });

  it("targets the costly pairs during focus and names the movement in plain words", () => {
    const ins = instruct({
      phaseState: phaseAt(3),
      focus: { targets: focus.targets, cls: "same-finger" },
      flow: calmFlow,
      marks: [],
    });
    expect(ins.targets.length).toBeGreaterThan(0);
    expect(ins.density).toBeGreaterThan(0);
    expect(ins.say).toContain("one finger has to fire twice");
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
      const line = instruct({
        phaseState: phaseAt(3),
        focus: { targets: focus.targets, cls },
        flow: calmFlow,
        marks: [],
      }).say;
      expect(line).toMatch(/^[A-Z]\S*.* — chasing .+\.$/);
      expect(line).not.toMatch(/\s{2,}/);
    }
  });

  it("asks for clean keys, not speed, during precision", () => {
    const ins = say(15);
    expect(ins.targets.length).toBeGreaterThan(0);
    expect(ins.say.toLowerCase()).toContain("clean");
    expect(ins.say.toLowerCase()).not.toContain("faster");
  });

  it("calls out overlap during stretch when it is the thing holding you back", () => {
    const flat = instruct({
      phaseState: phaseAt(11),
      focus,
      flow: { rollover: 0.12, rhythm: 0.7, samples: 900 },
      marks: [],
    });
    expect(flat.say.toLowerCase()).toContain("overlap");
    // and stays quiet about it once overlap is healthy
    expect(say(11).say.toLowerCase()).not.toContain("overlap");
  });

  it("eases off instead of pushing when you are tiring", () => {
    const ins = say(3, { tiring: true });
    expect(ins.say.toLowerCase()).toContain("ease off");
  });

  it("announces a new punctuation stage once, on its own", () => {
    const ins = say(3, { announce: "Adding apostrophes." });
    expect(ins.say).toBe("Adding apostrophes.");
    expect(ins.targets).toHaveLength(0);
  });

  it("passes the unlocked marks through to the generator", () => {
    expect(say(3).marks).toEqual([".", ","]);
    expect(say(3).capitals).toBe(true);
  });

  it("keeps every instruction short enough to read at a glance", () => {
    for (const i of [0, 3, 11, 15]) {
      expect(say(i).say.length).toBeLessThanOrEqual(80);
      expect(say(i).say.split(". ").length).toBeLessThanOrEqual(2);
    }
  });

  it("never mentions a score, a goal or a test", () => {
    for (const i of [0, 3, 11, 15]) {
      const line = say(i).say.toLowerCase();
      for (const word of ["goal", "test", "score", "record", "beat"]) {
        expect(line).not.toContain(word);
      }
    }
  });
});

/** A pair with a controlled number of samples at a controlled speed. */
function seed(m: SkillModel, bigram: string, iki: number, n: number) {
  for (let i = 0; i < n; i++) m.recordSample(bigram, iki, false);
}

describe("optimism about what has barely been measured", () => {
  it("ranks a thinly-sampled pair above an identical well-known one", () => {
    const m = new SkillModel();
    const freq = new Map([
      ["th", 0.02],
      ["nd", 0.02],
    ]);
    seed(m, "th", 160, 400); // long since settled at this speed
    seed(m, "nd", 160, 8); // same speed, but the coach has barely seen it
    const ranked = gaps(m, freq, 140);
    const th = ranked.find((g) => g.bigram === "th")!;
    const nd = ranked.find((g) => g.bigram === "nd")!;
    expect(nd.cost).toBeGreaterThan(th.cost);
  });

  it("but the bonus fades as the pair becomes known", () => {
    const thin = new SkillModel();
    const known = new SkillModel();
    const freq = new Map([["nd", 0.02]]);
    seed(thin, "nd", 160, 8);
    seed(known, "nd", 160, 400);
    const a = gaps(thin, freq, 140)[0].cost;
    const b = gaps(known, freq, 140)[0].cost;
    expect(a).toBeGreaterThan(b);
    // and it never dominates: the pair is the same distance off either way
    expect(a).toBeLessThan(b * 2.2);
  });
});

describe("where a minute buys the most", () => {
  it("prefers a pair still coming down over one that has settled", () => {
    const freq = new Map([
      ["th", 0.02],
      ["nd", 0.02],
    ]);
    const m = new SkillModel();
    // 'th' has sat at 170 forever; 'nd' arrived at 170 from much slower
    seed(m, "th", 170, 300);
    seed(m, "nd", 260, 200);
    seed(m, "nd", 170, 40);
    const ranked = gaps(m, freq, 140);
    const th = ranked.find((g) => g.bigram === "th")!;
    const nd = ranked.find((g) => g.bigram === "nd")!;
    // the comparison only means anything between pairs held to the same
    // standard, so the premise is that these are the same kind of movement
    expect(th.cls).toBe(nd.cls);
    expect(th.target).toBeCloseTo(nd.target, 6);
    expect(nd.trend).toBeGreaterThan(0);
    expect(Math.abs(th.trend)).toBeLessThan(nd.trend);
    expect(nd.cost).toBeGreaterThan(th.cost);
  });

  it("never abandons a plateaued pair entirely", () => {
    const m = new SkillModel();
    seed(m, "ab", 240, 300); // flat, and a long way off the standard
    const ranked = gaps(m, new Map([["ab", 0.02]]), 140);
    expect(ranked[0].cost).toBeGreaterThan(0);
  });
});

describe("knowing when to stop", () => {
  it("says nothing until a session has actually happened", () => {
    expect(
      shouldClose({ elapsedMs: 4 * 60 * 1000, tiring: true, atSetBoundary: true }),
    ).toBe(false);
  });

  it("offers the door once the work has started costing more than it buys", () => {
    expect(
      shouldClose({ elapsedMs: 14 * 60 * 1000, tiring: true, atSetBoundary: true }),
    ).toBe(true);
  });

  it("waits for a set to finish rather than cutting in mid-set", () => {
    expect(
      shouldClose({ elapsedMs: 40 * 60 * 1000, tiring: true, atSetBoundary: false }),
    ).toBe(false);
  });

  it("offers it eventually even to someone showing no sign of tiring", () => {
    expect(
      shouldClose({ elapsedMs: 40 * 60 * 1000, tiring: false, atSetBoundary: true }),
    ).toBe(true);
  });
});

describe("the last passage, and the way out", () => {
  it("builds the closing passage from pairs already at the standard", () => {
    const m = new SkillModel();
    const freq = new Map([
      ["ab", 0.02],
      ["cd", 0.02],
    ]);
    seed(m, "ab", 300, 60); // nowhere near
    seed(m, "cd", 40, 60); // comfortably inside the standard
    const settled = settledPairs(gaps(m, freq, 140), 1);
    expect(settled).toEqual(["cd"]);
  });

  it("leaves a thread hanging rather than closing the loop", () => {
    const r = sessionReport({
      minutes: 22,
      passages: 40,
      changes: [{ pair: "nd", from: 150, to: 138, better: true }],
      nextPhrase: "your same-hand rolls",
    });
    expect(r.thread).toContain("nd");
    expect(r.thread).toContain("12ms");
    expect(r.thread).toContain("pick up");
  });

  it("still has something to say on a session where nothing measurably moved", () => {
    const r = sessionReport({
      minutes: 9,
      passages: 12,
      changes: [],
      nextPhrase: "your hand switches",
    });
    expect(r.thread).not.toBeNull();
    expect(r.body).toContain("9 minutes");
  });
});

describe("the one choice that is yours", () => {
  it("offers three shapes of session, always including the coach's own", () => {
    const o = openings("same-finger");
    expect(o).toHaveLength(3);
    expect(o[0].key).toBe("coach");
    expect(o.map((x) => x.key)).toEqual(["coach", "loose", "clean"]);
  });

  it("each opening leads with different work after the warm up", () => {
    expect(phaseAt(3, "coach").phase).toBe("focus");
    expect(phaseAt(3, "loose").phase).toBe("stretch");
    expect(phaseAt(3, "clean").phase).toBe("precision");
  });

  it("every opening still cycles through all three kinds of work", () => {
    for (const key of ["coach", "loose", "clean"] as const) {
      const seen = new Set<string>();
      for (let i = 3; i < 40; i++) seen.add(phaseAt(i, key).phase);
      expect(seen).toEqual(new Set(["focus", "stretch", "precision"]));
    }
  });
});

describe("the standing, in one sentence", () => {
  it("names where you are and what is in the way", () => {
    const s = headline({ levelWpm: 118, tier: 140, lead: "same-finger" });
    expect(s).toContain("118");
    expect(s).toContain("140");
    expect(s).toContain("one finger");
  });

  it("admits when it does not know yet", () => {
    expect(headline({ levelWpm: null, tier: 120, lead: null })).toContain("Not enough");
  });

  it("stays short enough to read in one glance", () => {
    const s = headline({ levelWpm: 118, tier: 140, lead: "same-hand-stretch" });
    expect(s.length).toBeLessThan(130);
  });
});
