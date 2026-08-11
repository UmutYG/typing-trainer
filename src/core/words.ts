// Word corpus: top ~10k real English words ordered by frequency, with
// Zipf-weighted English bigram frequencies (including space boundaries)
// and an index from bigram -> words containing it.

export interface Corpus {
  words: string[]; // frequency-ordered
  weights: number[]; // zipf weight per word, normalized to sum 1
  engFreq: Map<string, number>; // bigram -> share of English transitions
  byBigram: Map<string, number[]>; // bigram -> word indices (boundary bigrams use start/end)
}

export function buildCorpus(rawWordList: string, maxWords = 6000): Corpus {
  const words = rawWordList
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, maxWords);

  const weights = words.map((_, i) => 1 / (i + 1));
  const wSum = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) weights[i] /= wSum;

  const engFreq = new Map<string, number>();
  const byBigram = new Map<string, number[]>();

  const addFreq = (bg: string, w: number) => {
    engFreq.set(bg, (engFreq.get(bg) ?? 0) + w);
  };
  const addIndex = (bg: string, idx: number) => {
    let arr = byBigram.get(bg);
    if (!arr) {
      arr = [];
      byBigram.set(bg, arr);
    }
    arr.push(idx);
  };

  words.forEach((word, idx) => {
    const w = weights[idx];
    const seen = new Set<string>();
    addFreq(" " + word[0], w);
    if (!seen.has(" " + word[0])) {
      addIndex(" " + word[0], idx);
      seen.add(" " + word[0]);
    }
    for (let i = 0; i < word.length - 1; i++) {
      const bg = word.slice(i, i + 2);
      addFreq(bg, w);
      if (!seen.has(bg)) {
        addIndex(bg, idx);
        seen.add(bg);
      }
    }
    addFreq(word[word.length - 1] + " ", w);
    if (!seen.has(word[word.length - 1] + " ")) {
      addIndex(word[word.length - 1] + " ", idx);
      seen.add(word[word.length - 1] + " ");
    }
  });

  // normalize transition shares to sum 1
  let fSum = 0;
  for (const v of engFreq.values()) fSum += v;
  for (const [k, v] of engFreq) engFreq.set(k, v / fSum);

  return { words, weights, engFreq, byBigram };
}
