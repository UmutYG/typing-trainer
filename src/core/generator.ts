// Lesson generation: real words, weighted toward the current bottleneck
// transitions. An awkward same-hand bigram gets trained inside ordinary
// hand-alternating words that contain it — never keybr-style pseudo-words.

import type { Corpus } from "./words";
import type { Bottleneck } from "./model";

export interface GeneratorOptions {
  lineLength: number; // target chars per line
  targetDensity: number; // fraction of words that should carry a target bigram
  topN: number; // how many bottleneck bigrams to target at once
}

export const DEFAULT_OPTIONS: GeneratorOptions = {
  lineLength: 58,
  targetDensity: 0.45,
  topN: 8,
};

export interface GeneratedLine {
  text: string;
  targets: string[]; // bigrams this line was built around
  targetWordCount: number;
  wordCount: number;
}

/** Weighted random pick among the most common candidate words (softly favors frequent, real chunks). */
function pickWord(candidates: number[], rng: () => number): number {
  // candidates are word indices sorted by frequency rank (ascending = more common)
  const pool = Math.min(candidates.length, 24);
  // triangular weighting over the pool: common words more likely, but variety kept
  const r = Math.floor(pool * (1 - Math.sqrt(rng())));
  return candidates[Math.min(r, pool - 1)];
}

export function generateLine(
  corpus: Corpus,
  bottlenecks: Bottleneck[],
  opts: GeneratorOptions = DEFAULT_OPTIONS,
  rng: () => number = Math.random,
): GeneratedLine {
  const targets = bottlenecks.slice(0, opts.topN).map((b) => b.bigram);
  const words: string[] = [];
  let targetWordCount = 0;
  let length = 0;
  let lastWord = "";
  let ti = Math.floor(rng() * Math.max(1, targets.length));

  // `length` counts a trailing space per word; the joined text is one shorter
  while (length <= opts.lineLength) {
    const wantTarget = targets.length > 0 && rng() < opts.targetDensity;
    let word: string | null = null;

    if (wantTarget) {
      // round-robin through targets so all bottlenecks get reps in a lesson
      for (let attempt = 0; attempt < targets.length && word === null; attempt++) {
        const bigram = targets[(ti + attempt) % targets.length];
        const candidates = corpus.byBigram.get(bigram);
        if (candidates && candidates.length > 0) {
          const idx = pickWord(candidates, rng);
          const w = corpus.words[idx];
          if (w !== lastWord) {
            word = w;
            targetWordCount++;
            ti = (ti + attempt + 1) % Math.max(1, targets.length);
          }
        }
      }
    }

    if (word === null) {
      // filler: a common word, zipf-ish via triangular pick over the top slice
      const pool = Math.min(corpus.words.length, 1500);
      const idx = Math.floor(pool * (1 - Math.sqrt(rng())) * 0.999);
      const w = corpus.words[idx];
      if (w === lastWord) continue;
      word = w;
    }

    words.push(word);
    lastWord = word;
    length += word.length + 1;
  }

  return {
    text: words.join(" "),
    targets,
    targetWordCount,
    wordCount: words.length,
  };
}

/** Fraction of a line's words that contain at least one target bigram (diagnostic). */
export function measureDensity(line: string, targets: string[]): number {
  const words = line.split(" ");
  if (words.length === 0) return 0;
  let hit = 0;
  for (const w of words) {
    const padded = " " + w + " ";
    if (targets.some((t) => padded.includes(t))) hit++;
  }
  return hit / words.length;
}
