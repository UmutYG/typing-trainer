// Line breaking done in code rather than by the browser.
//
// Two reasons. A word split across a line break destroys the motor chunk that
// carries an experienced typist — at speed you are typing whole words, not
// letters, and half a word at the end of a line stalls the hand. And knowing
// exactly which visual row each character sits on is what lets the text scroll
// smoothly under a caret that stays put.

/**
 * Index where each visual row begins. Rows never exceed `cols` characters and
 * are broken at spaces, with the space staying at the end of the row it ends —
 * so every character keeps its position in the stream and nothing is inserted.
 * A word longer than a whole row is the one case that breaks mid-word.
 */
export function wrapRows(text: string, cols: number): number[] {
  if (cols < 2) return [0];
  const rows = [0];
  let i = 0;
  while (text.length - i > cols) {
    const last = i + cols - 1;
    let br = -1;
    for (let j = last; j > i; j--) {
      if (text[j] === " ") {
        br = j;
        break;
      }
    }
    const next = br === -1 ? i + cols : br + 1;
    rows.push(next);
    i = next;
  }
  return rows;
}

/** Which visual row a character sits on. */
export function rowOf(rows: number[], index: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (rows[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
