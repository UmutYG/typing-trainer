import type { LineResult } from "./capture";

export interface LineStats {
  wpm: number;
  accuracy: number; // correct keystrokes / total keystrokes
  rolloverRate: number; // among timed keystrokes
  consistency: number; // 1 - coefficient of variation of timed IKIs, clamped to [0,1]
}

export function lineStats(r: LineResult): LineStats {
  const ms = r.endTime - r.startTime;
  const wpm = ms > 0 ? r.line.length / 5 / (ms / 60000) : 0;
  const total = r.line.length + r.totalErrors;
  const accuracy = total > 0 ? r.line.length / total : 1;

  const timed = r.chars.filter((c) => c.timed);
  const rolls = timed.filter((c) => c.rollover).length;
  const rolloverRate = timed.length > 0 ? rolls / timed.length : 0;

  let consistency = 0;
  if (timed.length >= 5) {
    const mean = timed.reduce((a, c) => a + c.iki, 0) / timed.length;
    const varc = timed.reduce((a, c) => a + (c.iki - mean) ** 2, 0) / timed.length;
    consistency = Math.max(0, Math.min(1, 1 - Math.sqrt(varc) / mean));
  }
  return { wpm, accuracy, rolloverRate, consistency };
}
