// Keystroke capture with real-life correction: a wrong key is shown where it
// happened, backspace deletes it, and you retype. Timing is only collected from
// keystrokes that were right the first time, so corrections never pollute the
// speed model.
//
// Pure state machine over (type, code, key, time) events so it is fully testable
// with synthetic streams.

export interface KeyEventLite {
  type: "down" | "up";
  key: string; // event.key
  code: string; // event.code (physical key identity, for rollover)
  time: number; // performance.now() ms
}

export interface CharResult {
  char: string; // the expected character
  typedChar: string | null; // what is currently sitting in this slot
  correct: boolean; // final state matches the expected character
  errors: number; // wrong keystrokes made at this position
  /** every wrong key tried here, in order — the raw material for error patterns */
  wrongChars: string[];
  /** the wrong key was the character that comes next: the hands fired out of order */
  transposed: boolean;
  iki: number; // ms since previous keystroke (0 if untimed)
  timed: boolean; // usable for speed stats
  rollover: boolean;
}

export interface LineResult {
  line: string;
  chars: CharResult[];
  startTime: number;
  endTime: number;
  totalErrors: number;
}

/** Live view of the line, for rendering. */
export interface LineView {
  pos: number;
  typed: (string | null)[];
  wrong: boolean[];
  /** true once the line has been typed through but still holds mistakes */
  fixing: boolean;
}

const PAUSE_MS = 2500; // gaps beyond this are hesitation, not typing speed

const IGNORED_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Tab",
  "Escape",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Delete",
  "Home",
  "End",
]);

export interface LineOptions {
  /**
   * When true the line will not finish while a wrong letter is still on screen:
   * after the last character the caret jumps back to each mistake in turn. Used
   * for precision work, where the point is to leave nothing wrong behind.
   */
  requireCorrection?: boolean;
}

export class CaptureEngine {
  private line = "";
  private pos = 0;
  private typed: (string | null)[] = [];
  /** this slot has been mistyped or backspaced into — never counts for speed */
  private touched: boolean[] = [];
  private errorCount: number[] = [];
  private wrongChars: string[][] = [];
  private transposed: boolean[] = [];
  private ikis: number[] = [];
  private timedFlags: boolean[] = [];
  private rollFlags: boolean[] = [];

  private pressed = new Map<string, number>(); // physical keys currently held
  private lastDown: { code: string; time: number } | null = null; // for rollover
  /** previous keystroke considered for timing; null after a correction */
  private prevClean: { index: number; time: number } | null = null;
  /** null until the first keystroke — 0 is a legitimate timestamp, so it
   * cannot double as "not started" */
  private startTime: number | null = null;
  private lastTime = 0;
  private totalErrors = 0;
  private requireCorrection = false;
  /** the line has been typed to the end and we are now cleaning up mistakes */
  private fixing = false;

  onProgress: ((view: LineView) => void) | null = null;
  onComplete: ((result: LineResult) => void) | null = null;

  setLine(line: string, opts: LineOptions = {}): void {
    this.line = line;
    this.pos = 0;
    this.typed = new Array(line.length).fill(null);
    this.touched = new Array(line.length).fill(false);
    this.errorCount = new Array(line.length).fill(0);
    this.wrongChars = Array.from({ length: line.length }, () => []);
    this.transposed = new Array(line.length).fill(false);
    this.ikis = new Array(line.length).fill(0);
    this.timedFlags = new Array(line.length).fill(false);
    this.rollFlags = new Array(line.length).fill(false);
    this.prevClean = null;
    this.startTime = null;
    this.totalErrors = 0;
    this.requireCorrection = opts.requireCorrection ?? false;
    this.fixing = false;
  }

  get position(): number {
    return this.pos;
  }

  get active(): boolean {
    return this.pos < this.line.length;
  }

  private firstWrongFrom(start: number): number {
    for (let i = start; i < this.line.length; i++) {
      if (this.typed[i] !== this.line[i]) return i;
    }
    for (let i = 0; i < start; i++) {
      if (this.typed[i] !== this.line[i]) return i;
    }
    return -1;
  }

  view(): LineView {
    return {
      pos: this.pos,
      typed: [...this.typed],
      wrong: this.typed.map((t, i) => t !== null && t !== this.line[i]),
      fixing: this.fixing,
    };
  }

  /** Partial results for an interrupted line. */
  snapshot(): { chars: CharResult[]; totalErrors: number } {
    return { chars: this.buildChars().slice(0, this.pos), totalErrors: this.totalErrors };
  }

  private buildChars(): CharResult[] {
    return this.line.split("").map((ch, i) => ({
      char: ch,
      typedChar: this.typed[i],
      correct: this.typed[i] === ch,
      errors: this.errorCount[i],
      wrongChars: [...this.wrongChars[i]],
      transposed: this.transposed[i],
      iki: this.ikis[i],
      timed: this.timedFlags[i],
      rollover: this.rollFlags[i],
    }));
  }

  private finish(time: number): void {
    this.onComplete?.({
      line: this.line,
      chars: this.buildChars(),
      startTime: this.startTime ?? time,
      endTime: time,
      totalErrors: this.totalErrors,
    });
  }

  feed(ev: KeyEventLite): void {
    if (ev.type === "up") {
      this.pressed.delete(ev.code);
      return;
    }
    if (ev.key === "Backspace") {
      if (this.pos > 0) {
        this.pos--;
        this.typed[this.pos] = null;
        this.touched[this.pos] = true;
        this.timedFlags[this.pos] = false;
        this.prevClean = null; // the next keystroke has no honest predecessor
        this.onProgress?.(this.view());
      }
      return;
    }
    if (IGNORED_KEYS.has(ev.key) || ev.key.length !== 1) return;
    if (this.pos >= this.line.length) return;

    const i = this.pos;
    const expected = this.line[i];
    const correct = ev.key === expected;
    const rolledOver = this.lastDown !== null && this.pressed.has(this.lastDown.code);

    this.pressed.set(ev.code, ev.time);
    if (this.startTime === null) this.startTime = ev.time;
    this.lastTime = ev.time;

    this.typed[i] = ev.key;
    if (!correct) {
      this.errorCount[i]++;
      this.totalErrors++;
      this.touched[i] = true;
      if (this.wrongChars[i].length < 6) this.wrongChars[i].push(ev.key);
      // typing the character that comes next means the hands fired out of order
      if (i + 1 < this.line.length && ev.key === this.line[i + 1]) this.transposed[i] = true;
    }

    // only a first-try-correct keystroke following another first-try-correct
    // keystroke describes real typing speed
    const clean = correct && !this.touched[i];
    const iki = this.prevClean ? ev.time - this.prevClean.time : 0;
    const timed =
      clean &&
      this.prevClean !== null &&
      this.prevClean.index === i - 1 &&
      iki > 0 &&
      iki < PAUSE_MS;

    this.ikis[i] = timed ? iki : 0;
    this.timedFlags[i] = timed;
    this.rollFlags[i] = timed && rolledOver;

    this.lastDown = { code: ev.code, time: ev.time };
    this.prevClean = clean ? { index: i, time: ev.time } : null;

    if (this.fixing) {
      // hop straight to whatever is still wrong
      const next = this.firstWrongFrom(i + 1);
      if (next === -1) {
        this.pos = this.line.length;
        this.onProgress?.(this.view());
        this.finish(ev.time);
        return;
      }
      this.pos = next;
      this.onProgress?.(this.view());
      return;
    }

    this.pos++;

    if (this.pos >= this.line.length) {
      const firstWrong = this.requireCorrection ? this.firstWrongFrom(0) : -1;
      if (firstWrong === -1) {
        this.onProgress?.(this.view());
        this.finish(ev.time);
        return;
      }
      // stay on the line and walk back through the mistakes
      this.fixing = true;
      this.pos = firstWrong;
      this.prevClean = null;
    }
    this.onProgress?.(this.view());
  }

  /** End the line where it stands (used when the coach moves on). */
  abort(): void {
    if (this.startTime !== null) this.finish(this.lastTime);
  }
}
