// QWERTY physical geometry and transition classification.
// The model's explanatory power comes from here: every bigram gets a physical
// class so the app can say WHY a transition is slow, not just that it is.

export type Hand = "L" | "R" | "T"; // T = thumb (space)

export interface KeyInfo {
  hand: Hand;
  finger: number; // 0=pinky 1=ring 2=middle 3=index, 4=thumb
  row: number; // 0=number 1=top 2=home 3=bottom, 4=space
  col: number; // column on the physical board, 0 = leftmost
  shifted: boolean; // char requires shift (capitals, " ? !)
}

export type TransitionClass =
  | "repeat"
  | "same-finger"
  | "same-hand-roll"
  | "same-hand-stretch"
  | "alternating"
  | "space"
  | "shift";

export const CLASS_LABELS: Record<TransitionClass, string> = {
  repeat: "repeated key",
  "same-finger": "same finger",
  "same-hand-roll": "same-hand roll",
  "same-hand-stretch": "same-hand stretch",
  alternating: "hand alternation",
  space: "space transition",
  shift: "shift-involved",
};

const KEYS: Record<string, KeyInfo> = {};

function def(chars: string, hand: Hand, finger: number, row: number, colStart: number) {
  let col = colStart;
  for (const ch of chars) {
    KEYS[ch] = { hand, finger, row, col, shifted: false };
    col++;
  }
}

// Row 1 (top letters)
def("q", "L", 0, 1, 0);
def("w", "L", 1, 1, 1);
def("e", "L", 2, 1, 2);
def("rt", "L", 3, 1, 3);
def("yu", "R", 3, 1, 5);
def("i", "R", 2, 1, 7);
def("o", "R", 1, 1, 8);
def("p", "R", 0, 1, 9);
// Row 2 (home)
def("a", "L", 0, 2, 0);
def("s", "L", 1, 2, 1);
def("d", "L", 2, 2, 2);
def("fg", "L", 3, 2, 3);
def("hj", "R", 3, 2, 5);
def("k", "R", 2, 2, 7);
def("l", "R", 1, 2, 8);
def(";", "R", 0, 2, 9);
def("'", "R", 0, 2, 10);
// Row 3 (bottom)
def("z", "L", 0, 3, 0);
def("x", "L", 1, 3, 1);
def("c", "L", 2, 3, 2);
def("vb", "L", 3, 3, 3);
def("nm", "R", 3, 3, 5);
def(",", "R", 2, 3, 7);
def(".", "R", 1, 3, 8);
def("/", "R", 0, 3, 9);
// Number row keys we care about (for ! via shift+1)
def("1", "L", 0, 0, 0);
def("-", "R", 0, 0, 10);
// Space
KEYS[" "] = { hand: "T", finger: 4, row: 4, col: 5, shifted: false };

// Shifted characters map to a base physical key + shifted flag.
const SHIFT_MAP: Record<string, string> = {
  '"': "'",
  "?": "/",
  "!": "1",
  ":": ";",
};

/** Physical key info for a character; capitals resolve to their base key with shifted=true. */
export function keyInfo(ch: string): KeyInfo | undefined {
  if (ch >= "A" && ch <= "Z") {
    const base = KEYS[ch.toLowerCase()];
    return base ? { ...base, shifted: true } : undefined;
  }
  const shiftBase = SHIFT_MAP[ch];
  if (shiftBase !== undefined) {
    const base = KEYS[shiftBase];
    return base ? { ...base, shifted: true } : undefined;
  }
  return KEYS[ch];
}

/** Center-column keys reached by stretching the index finger inward. */
function isLateral(k: KeyInfo): boolean {
  return k.finger === 3 && (k.hand === "L" ? k.col === 4 : k.col === 5);
}

export function classifyTransition(a: string, b: string): TransitionClass | undefined {
  const ka = keyInfo(a);
  const kb = keyInfo(b);
  if (!ka || !kb) return undefined;
  if (ka.shifted || kb.shifted) return "shift";
  if (ka.hand === "T" || kb.hand === "T") return "space";
  if (a === b) return "repeat";
  if (ka.hand !== kb.hand) return "alternating";
  if (ka.finger === kb.finger) return "same-finger";
  if (Math.abs(ka.row - kb.row) >= 2 || isLateral(ka) || isLateral(kb)) return "same-hand-stretch";
  return "same-hand-roll";
}

/** All characters the model knows the physical location of. */
export function knownChars(): string[] {
  return Object.keys(KEYS);
}
