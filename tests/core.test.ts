import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { newStat, updateStat } from "../src/core/model";
import { CaptureEngine, type KeyEventLite, type LineResult } from "../src/core/capture";
import { classifyTransition } from "../src/core/keyboard";
import { buildCorpus } from "../src/core/words";
import {
  DEFAULT_OPTIONS,
  enrich,
  generateLine,
  measureDensity,
  synthesizeWord,
} from "../src/core/generator";
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

describe("precision mode: nothing wrong is left behind", () => {
  function engine(line: string) {
    const eng = new CaptureEngine();
    let done: LineResult | null = null;
    eng.onComplete = (r) => (done = r);
    eng.setLine(line, { requireCorrection: true });
    return { eng, result: () => done as LineResult | null };
  }

  it("does not finish the line while a mistake is showing", () => {
    const { eng, result } = engine("ab");
    eng.feed(down("a", 0));
    eng.feed(down("x", 100)); // wrong, where 'b' was due
    expect(result()).toBeNull();
    expect(eng.view().fixing).toBe(true);
  });

  it("sends the caret back to the mistake so it can be retyped", () => {
    const { eng } = engine("abc");
    eng.feed(down("a", 0));
    eng.feed(down("x", 100)); // wrong at index 1
    eng.feed(down("c", 200)); // right at index 2
    // typed through, so now it walks back to the one still wrong
    expect(eng.view().pos).toBe(1);
    expect(eng.view().fixing).toBe(true);
  });

  it("finishes once the last mistake is cleared", () => {
    const { eng, result } = engine("abc");
    eng.feed(down("a", 0));
    eng.feed(down("x", 100));
    eng.feed(down("c", 200));
    eng.feed(down("b", 300)); // fixes index 1
    const r = result();
    expect(r).not.toBeNull();
    expect(r!.chars.every((c) => c.correct)).toBe(true);
    expect(r!.totalErrors).toBe(1); // the mistake is still counted
  });

  it("hops between several mistakes until all are clean", () => {
    const { eng, result } = engine("abcd");
    eng.feed(down("x", 0)); // wrong at 0
    eng.feed(down("b", 100));
    eng.feed(down("y", 200)); // wrong at 2
    eng.feed(down("d", 300));
    expect(eng.view().pos).toBe(0);
    eng.feed(down("a", 400)); // fix 0 -> jumps to 2
    expect(eng.view().pos).toBe(2);
    expect(result()).toBeNull();
    eng.feed(down("c", 500)); // fix 2 -> done
    expect(result()).not.toBeNull();
  });

  it("a corrected line still contributes no speed samples for those slots", () => {
    const { eng, result } = engine("abc");
    eng.feed(down("a", 0));
    eng.feed(down("x", 100));
    eng.feed(down("c", 200));
    eng.feed(down("b", 300));
    const r = result()!;
    expect(r.chars[1].timed).toBe(false);
    expect(r.chars[1].errors).toBe(1);
  });

  it("outside precision mode the line finishes with the mistake left in", () => {
    const eng = new CaptureEngine();
    let done: LineResult | null = null;
    eng.onComplete = (r) => (done = r);
    eng.setLine("ab"); // no requireCorrection
    eng.feed(down("a", 0));
    eng.feed(down("x", 100));
    expect(done).not.toBeNull();
    expect(done!.chars[1].correct).toBe(false);
  });
});

describe("what the mistake was", () => {
  it("remembers the wrong key that was hit", () => {
    const r = runLine("ab", [down("a", 0), down("x", 100), down("b", 200)]);
    // 'x' was hit at index 1 before 'b' landed there... in free mode the caret
    // moved on, so index 1 holds 'x'
    expect(r.chars[1].wrongChars).toEqual(["x"]);
  });

  it("flags typing the next letter early as a transposition", () => {
    // line 'the': typing 'e' where 'h' is due is the next-but-one letter
    const r = runLine("the", [down("t", 0), down("e", 100), down("e", 200)]);
    expect(r.chars[1].transposed).toBe(true);
  });

  it("does not call an unrelated wrong key a transposition", () => {
    const r = runLine("the", [down("t", 0), down("q", 100), down("e", 200)]);
    expect(r.chars[1].transposed).toBe(false);
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

  it("generates lines hitting the requested target density", () => {
    const rng = lcg(42);
    const targets = ["ec", "wa", "ow", "ce", "th"];
    let densitySum = 0;
    const lines = 30;
    for (let i = 0; i < lines; i++) {
      const g = generateLine(corpus, targets, DEFAULT_OPTIONS, rng);
      expect(g.text.length).toBeGreaterThanOrEqual(DEFAULT_OPTIONS.lineLength);
      densitySum += measureDensity(g.text, g.targets);
    }
    expect(densitySum / lines).toBeGreaterThan(0.3);
  });

  it("uses only real words when the targets are common", () => {
    const rng = lcg(7);
    const g = generateLine(corpus, ["th", "er", "in"], DEFAULT_OPTIONS, rng);
    for (const w of g.text.split(" ")) expect(corpus.words).toContain(w);
  });

  it("honours a zero density request (untargeted warmup lines)", () => {
    const rng = lcg(3);
    const g = generateLine(corpus, [], { ...DEFAULT_OPTIONS, targetDensity: 0 }, rng);
    expect(g.targetWordCount).toBe(0);
    for (const w of g.text.split(" ")) expect(corpus.words).toContain(w);
  });

  it("respects a shorter requested line length", () => {
    const rng = lcg(11);
    const g = generateLine(corpus, [], { ...DEFAULT_OPTIONS, lineLength: 30 }, rng);
    expect(g.text.length).toBeGreaterThanOrEqual(30);
    expect(g.text.length).toBeLessThan(48);
  });
});

describe("writing, not just words", () => {
  const rng = lcg(9);
  const words = "the quick brown fox jumps over a lazy dog and then runs home again today".split(" ");

  it("leaves the words alone when nothing is unlocked", () => {
    expect(enrich(words, { marks: [], capitals: false }, lcg(1))).toEqual(words);
  });

  it("opens sentences with a capital and closes them with a stop", () => {
    const out = enrich(words, { marks: [".", ","], capitals: true }, rng).join(" ");
    expect(out[0]).toBe(out[0].toUpperCase());
    expect(out.trim().endsWith(".")).toBe(true);
    // every sentence after a full stop also starts capitalised
    for (const m of out.matchAll(/[.?!]\s+(\S)/g)) {
      expect(m[1]).toBe(m[1].toUpperCase());
    }
  });

  it("never invents a mark that is not unlocked yet", () => {
    for (let i = 0; i < 40; i++) {
      const out = enrich(words, { marks: [".", ","], capitals: true }, rng).join(" ");
      expect(out).not.toMatch(/[?!;:'"-]/);
    }
  });

  it("brings in the later marks once they are unlocked", () => {
    const seen = new Set<string>();
    const r = lcg(4);
    for (let i = 0; i < 200; i++) {
      const out = enrich(words, { marks: [".", ",", "'", "?", "!"], capitals: true }, r).join(" ");
      for (const ch of "?!'") if (out.includes(ch)) seen.add(ch);
    }
    expect(seen.has("'")).toBe(true);
    expect(seen.has("?")).toBe(true);
  });

  it("keeps the practice words themselves intact", () => {
    const out = enrich(words, { marks: [".", ","], capitals: true }, lcg(12));
    const bare = out.join(" ").toLowerCase().replace(/[.,?!;:'"-]/g, "");
    expect(bare.split(/\s+/)).toEqual(words);
  });

  it("hands whole sentences to the typist, never a dangling fragment", () => {
    for (let i = 0; i < 30; i++) {
      const out = enrich(words, { marks: [".", ","], capitals: true }, rng).join(" ");
      expect(out.trim()).toMatch(/[.?!]$/);
    }
  });
});

describe("invented words for rare transitions", () => {
  const raw = readFileSync(join(here, "../src/data/words.txt"), "utf8");
  const corpus = buildCorpus(raw);

  it("builds a pronounceable token that contains the pair", () => {
    const rng = lcg(5);
    for (const bg of ["xc", "qv", "zx", "kg"]) {
      for (let i = 0; i < 12; i++) {
        const w = synthesizeWord(bg, rng);
        expect(w).toContain(bg);
        expect(w.length).toBeGreaterThanOrEqual(bg.length + 2);
        expect(w).toMatch(/^[a-z]+$/);
      }
    }
  });

  it("falls back to invented words for a pair real English cannot supply", () => {
    const rng = lcg(21);
    // no common English word contains 'zq', so it can only be trained invented
    const g = generateLine(corpus, ["zq"], { ...DEFAULT_OPTIONS, targetDensity: 0.6 }, rng);
    const invented = g.text.split(" ").filter((w) => w.includes("zq"));
    expect(invented.length).toBeGreaterThan(0);
    for (const w of invented) expect(corpus.words).not.toContain(w);
  });

  it("still prefers real words for an awkward pair that English does supply", () => {
    const rng = lcg(23);
    // 'xc' is awkward but lives in except/exchange/exclude, so no inventing
    for (let i = 0; i < 10; i++) {
      const g = generateLine(corpus, ["xc"], { ...DEFAULT_OPTIONS, targetDensity: 0.6 }, rng);
      for (const w of g.text.split(" ")) expect(corpus.words).toContain(w);
    }
  });

  it("never invents words for pairs that touch a space", () => {
    const rng = lcg(31);
    for (let i = 0; i < 20; i++) {
      const g = generateLine(corpus, [" q", "q "], { ...DEFAULT_OPTIONS, targetDensity: 0.8 }, rng);
      for (const w of g.text.split(" ")) expect(corpus.words).toContain(w);
    }
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
