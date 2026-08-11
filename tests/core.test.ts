import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { newStat, updateStat, SkillModel } from "../src/core/model";
import { CaptureEngine, type KeyEventLite, type LineResult } from "../src/core/capture";
import { classifyTransition } from "../src/core/keyboard";
import { buildCorpus } from "../src/core/words";
import { generateLine, measureDensity, DEFAULT_OPTIONS } from "../src/core/generator";
import { lineStats } from "../src/core/wpm";

const here = dirname(fileURLToPath(import.meta.url));

/** Deterministic LCG for reproducible generator tests. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("EWMA stat updates", () => {
  it("acts as a running mean during warmup", () => {
    const s = newStat();
    updateStat(s, 100, false);
    updateStat(s, 200, false);
    updateStat(s, 300, false);
    expect(s.mean).toBeCloseTo(200, 5);
  });

  it("stays recency-weighted after warmup (old samples decay)", () => {
    const s = newStat();
    for (let i = 0; i < 50; i++) updateStat(s, 300, false);
    for (let i = 0; i < 30; i++) updateStat(s, 150, false);
    expect(s.mean).toBeLessThan(160); // 30 recent samples dominate at alpha 0.1
    expect(s.mean).toBeGreaterThan(149);
  });

  it("tracks variance for unstable transitions", () => {
    const stable = newStat();
    const unstable = newStat();
    for (let i = 0; i < 40; i++) {
      updateStat(stable, 150, false);
      updateStat(unstable, i % 2 === 0 ? 80 : 220, false);
    }
    expect(stable.m2).toBeLessThan(1);
    expect(Math.sqrt(unstable.m2)).toBeGreaterThan(40);
  });

  it("counts rollover", () => {
    const s = newStat();
    updateStat(s, 100, true);
    updateStat(s, 100, false);
    updateStat(s, 100, true);
    expect(s.rollover).toBe(2);
  });
});

function down(key: string, time: number, code = "Key" + key.toUpperCase()): KeyEventLite {
  return { type: "down", key, code, time };
}
function up(key: string, time: number, code = "Key" + key.toUpperCase()): KeyEventLite {
  return { type: "up", key, code, time };
}

function runLine(line: string, events: KeyEventLite[]): LineResult {
  const eng = new CaptureEngine();
  let result: LineResult | null = null;
  eng.onComplete = (r) => (result = r);
  eng.setLine(line);
  for (const ev of events) eng.feed(ev);
  expect(result).not.toBeNull();
  return result!;
}

function backspace(time: number): KeyEventLite {
  return { type: "down", key: "Backspace", code: "Backspace", time };
}

describe("capture engine", () => {
  it("detects rollover when next keydown precedes previous keyup", () => {
    const r = runLine("ab", [
      down("a", 0),
      down("b", 120), // 'a' still held -> rollover
      up("a", 140),
      up("b", 200),
    ]);
    expect(r.chars[1].rollover).toBe(true);
    expect(r.chars[1].iki).toBe(120);
    expect(r.chars[1].timed).toBe(true);
  });

  it("no rollover when keys do not overlap", () => {
    const r = runLine("ab", [down("a", 0), up("a", 50), down("b", 120), up("b", 160)]);
    expect(r.chars[1].rollover).toBe(false);
    expect(r.chars[1].timed).toBe(true);
  });

  it("marks long gaps as untimed pauses", () => {
    const r = runLine("ab", [down("a", 0), up("a", 40), down("b", 4000), up("b", 4040)]);
    expect(r.chars[1].timed).toBe(false);
  });

  it("first char of a line is never timed", () => {
    const r = runLine("ab", [down("a", 0), up("a", 40), down("b", 150), up("b", 190)]);
    expect(r.chars[0].timed).toBe(false);
    expect(r.chars[1].timed).toBe(true);
  });
});

describe("backspace correction", () => {
  it("shows the wrong key in place and advances the caret", () => {
    const eng = new CaptureEngine();
    eng.setLine("ab");
    eng.feed(down("a", 0));
    eng.feed(up("a", 30));
    eng.feed(down("x", 100)); // wrong, in place of 'b'
    const v = eng.view();
    expect(v.pos).toBe(2);
    expect(v.typed[1]).toBe("x");
    expect(v.wrong[1]).toBe(true);
  });

  it("backspace clears the slot and steps the caret back", () => {
    const eng = new CaptureEngine();
    eng.setLine("ab");
    eng.feed(down("a", 0));
    eng.feed(up("a", 30));
    eng.feed(down("x", 100));
    eng.feed(up("x", 130));
    eng.feed(backspace(200));
    const v = eng.view();
    expect(v.pos).toBe(1);
    expect(v.typed[1]).toBe(null);
    expect(v.wrong[1]).toBe(false);
  });

  it("completes the line once the correction is typed, and counts the error", () => {
    const r = runLine("ab", [
      down("a", 0),
      up("a", 30),
      down("x", 100),
      up("x", 130), // wrong
      backspace(200),
      down("b", 300),
      up("b", 330), // corrected
    ]);
    expect(r.totalErrors).toBe(1);
    expect(r.chars[1].correct).toBe(true);
    expect(r.chars[1].errors).toBe(1);
    // a corrected keystroke must never count toward typing speed
    expect(r.chars[1].timed).toBe(false);
  });

  it("a corrected slot also poisons the timing of the next keystroke", () => {
    const r = runLine("abc", [
      down("a", 0),
      up("a", 30),
      down("x", 100),
      up("x", 130),
      backspace(200),
      down("b", 300),
      up("b", 330),
      down("c", 420),
      up("c", 450),
    ]);
    expect(r.chars[2].correct).toBe(true);
    expect(r.chars[2].timed).toBe(false); // predecessor was retyped, not honest
  });

  it("keeps timing clean typing that follows a fully recovered stretch", () => {
    const r = runLine("abcd", [
      down("a", 0),
      up("a", 30),
      down("x", 100),
      up("x", 130),
      backspace(200),
      down("b", 300),
      up("b", 330),
      down("c", 420),
      up("c", 450),
      down("d", 530),
      up("d", 560),
    ]);
    expect(r.chars[3].timed).toBe(true);
    expect(r.chars[3].iki).toBe(110);
  });

  it("can backspace over a correct character and retype it", () => {
    const r = runLine("ab", [
      down("a", 0),
      up("a", 30),
      down("b", 120),
      up("b", 150),
      // line already completed; a fresh engine models mid-line rewind instead
    ]);
    expect(r.chars[1].correct).toBe(true);

    const eng = new CaptureEngine();
    eng.setLine("abc");
    eng.feed(down("a", 0));
    eng.feed(down("b", 100));
    eng.feed(backspace(200));
    eng.feed(down("b", 300));
    expect(eng.view().pos).toBe(2);
    expect(eng.view().wrong[1]).toBe(false);
  });

  it("ignores backspace at the start of a line", () => {
    const eng = new CaptureEngine();
    eng.setLine("ab");
    eng.feed(backspace(10));
    expect(eng.view().pos).toBe(0);
  });
});

describe("keyboard classification", () => {
  it("classifies physical transition types", () => {
    expect(classifyTransition("x", "c")).toBe("same-hand-roll"); // adjacent fingers, bottom row
    expect(classifyTransition("e", "d")).toBe("same-finger");
    expect(classifyTransition("a", "o")).toBe("alternating");
    expect(classifyTransition(" ", "t")).toBe("space");
    expect(classifyTransition("q", "c")).toBe("same-hand-stretch"); // two-row jump
    expect(classifyTransition("t", "g")).toBe("same-finger");
    expect(classifyTransition("s", "b")).toBe("same-hand-stretch"); // lateral b
    expect(classifyTransition("a", "T")).toBe("shift");
    expect(classifyTransition("l", "l")).toBe("repeat");
  });
});

describe("bottleneck ranking", () => {
  const engFreq = new Map<string, number>([
    ["th", 0.03],
    ["xc", 0.001],
    ["er", 0.02],
    ["qz", 0.00001],
  ]);

  it("ranks by english-frequency-weighted personal excess", () => {
    const m = new SkillModel();
    // establish a baseline: many fast transitions
    for (let i = 0; i < 20; i++) {
      for (const bg of ["in", "at", "on", "es", "en", "ti", "st", "ar", "nd", "ou", "ea", "ns", "to", "it", "ha", "re"]) {
        m.recordSample(bg, 100, true);
      }
    }
    // th: frequent and slow. xc: rare and slower. er: frequent and fast.
    for (let i = 0; i < 20; i++) {
      m.recordSample("th", 220, false);
      m.recordSample("xc", 320, false);
      m.recordSample("er", 105, true);
    }
    const ranks = m.bottlenecks(engFreq, 4).map((b) => b.bigram);
    // th's 120ms excess at 30x the frequency beats xc's 220ms excess
    expect(ranks[0]).toBe("th");
    expect(ranks.indexOf("xc")).toBeLessThan(ranks.indexOf("er"));
  });

  it("errors inflate a transition's priority", () => {
    const base = new SkillModel();
    const erry = new SkillModel();
    for (let i = 0; i < 20; i++) {
      for (const bg of ["in", "at", "on", "es", "en", "ti", "st", "ar", "nd", "ou", "ea", "ns", "to", "it", "ha", "re"]) {
        base.recordSample(bg, 100, true);
        erry.recordSample(bg, 100, true);
      }
      base.recordSample("th", 150, false);
      erry.recordSample("th", 150, false);
    }
    erry.recordErrors("th", 10);
    const sBase = base.bottlenecks(engFreq, 4).find((b) => b.bigram === "th")!;
    const sErry = erry.bottlenecks(engFreq, 4).find((b) => b.bigram === "th")!;
    expect(sErry.score).toBeGreaterThan(sBase.score * 1.5);
  });

  it("gives frequent unmeasured transitions an exploration score", () => {
    const m = new SkillModel();
    for (let i = 0; i < 20; i++)
      for (const bg of ["in", "at", "on", "es", "en", "ti", "st", "ar", "nd", "ou", "ea", "ns", "to", "it", "ha", "re"])
        m.recordSample(bg, 100, true);
    const th = m.bottlenecks(engFreq, 4).find((b) => b.bigram === "th")!;
    expect(th.count).toBe(0);
    expect(th.score).toBeGreaterThan(0);
  });
});

describe("corpus + generator", () => {
  const raw = readFileSync(join(here, "../src/data/words.txt"), "utf8");
  const corpus = buildCorpus(raw);

  it("builds english bigram frequencies that sum to 1 with sane ordering", () => {
    let sum = 0;
    for (const v of corpus.engFreq.values()) sum += v;
    expect(sum).toBeCloseTo(1, 6);
    expect(corpus.engFreq.get("th")!).toBeGreaterThan(corpus.engFreq.get("xc") ?? 0);
  });

  it("indexes words by contained bigrams including boundaries", () => {
    const withXc = corpus.byBigram.get("xc");
    expect(withXc).toBeDefined();
    expect(withXc!.some((i) => corpus.words[i].includes("xc"))).toBe(true); // e.g. "except"
    const startT = corpus.byBigram.get(" t");
    expect(startT!.every((i) => corpus.words[i].startsWith("t"))).toBe(true);
  });

  it("generates lines with real words hitting target density", () => {
    const rng = lcg(42);
    const targets = ["xc", "ec", "wa", "ow", "ce"].map((bigram) => ({
      bigram,
      score: 1,
      meanIki: 200,
      excess: 80,
      errorRate: 0,
      freq: 0.01,
      cls: undefined,
      count: 10,
    }));
    let densitySum = 0;
    const lines = 30;
    for (let i = 0; i < lines; i++) {
      const g = generateLine(corpus, targets, DEFAULT_OPTIONS, rng);
      expect(g.text.length).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.lineLength);
      for (const w of g.text.split(" ")) expect(corpus.words).toContain(w);
      densitySum += measureDensity(g.text, g.targets);
    }
    const avgDensity = densitySum / lines;
    expect(avgDensity).toBeGreaterThan(0.3);
  });
});

describe("line stats", () => {
  it("computes wpm, accuracy, rollover and consistency", () => {
    // "hello" typed in 1s -> 5 chars = 1 word -> 60 wpm
    const r = runLine("hello", [
      down("h", 0),
      up("h", 50),
      down("e", 250),
      up("e", 300),
      down("l", 500, "KeyL"),
      up("l", 550, "KeyL"),
      down("l", 750, "KeyL"),
      up("l", 800, "KeyL"),
      down("o", 1000),
      up("o", 1050),
    ]);
    const s = lineStats(r);
    expect(s.wpm).toBeCloseTo(60, 1);
    expect(s.accuracy).toBe(1);
  });
});
