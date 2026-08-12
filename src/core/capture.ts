// Keystroke capture over a continuous stream of text. Text is appended in
// segments; the caret never restarts, so typing is one unbroken run rather than
// a series of passages. A segment reports itself the moment the caret leaves it.
//
// Correction is real-life: a wrong key is shown where it happened, backspace
// deletes it, and you retype. Timing is only collected from keystrokes that were
// right the first time, so corrections never pollute the speed model.
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

/** Live view of the stream, for rendering. */
export interface LineView {
  pos: number;
  typed: (string | null)[];
  wrong: boolean[];
  /** a wrong character is sitting under the caret and blocking it */
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

export interface SegmentOptions {
  /**
   * When true a wrong key does not let the caret past: it sits there until it is
   * backspaced away and the right key is typed. Used for precision work, where
   * the point is to leave nothing wrong behind.
   */
  requireCorrection?: boolean;
}

interface Segment {
  start: number;
  end: number;
  requireCorrection: boolean;
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

  /** the appended chunks, in order; the caret is inside `segments[segIndex]` */
  private segments: Segment[] = [];
  private segIndex = 0;
  /** when typing of the current segment began — the previous segment's last key */
  private segStartTime: number | null = null;

  private pressed = new Map<string, number>(); // physical keys currently held
  private lastDown: { code: string; time: number } | null = null; // for rollover
  /** previous keystroke considered for timing; null after a correction */
  private prevClean: { index: number; time: number } | null = null;
  /** null until the first keystroke — 0 is a legitimate timestamp, so it
   * cannot double as "not started" */
  private startTime: number | null = null;
  private lastTime = 0;

  onProgress: ((view: LineView) => void) | null = null;
  /** fires each time the caret leaves a segment */
  onComplete: ((result: LineResult) => void) | null = null;

  /** Throw the stream away and start empty. */
  reset(): void {
    this.line = "";
    this.pos = 0;
    this.typed = [];
    this.touched = [];
    this.errorCount = [];
    this.wrongChars = [];
    this.transposed = [];
    this.ikis = [];
    this.timedFlags = [];
    this.rollFlags = [];
    this.segments = [];
    this.segIndex = 0;
    this.segStartTime = null;
    this.prevClean = null;
    this.startTime = null;
  }

  /**
   * Add the next stretch of text to the end of the stream. Whatever is already
   * typed stays where it is — this is what makes the text continuous.
   */
  append(text: string, opts: SegmentOptions = {}): void {
    if (text.length === 0) return;
    // segments meet at a word boundary, never mid-word
    const joined = this.line.length > 0 && !/\s$/.test(this.line) && !/^\s/.test(text);
    const chunk = joined ? " " + text : text;
    const start = this.line.length;

    this.line += chunk;
    for (let i = 0; i < chunk.length; i++) {
      this.typed.push(null);
      this.touched.push(false);
      this.errorCount.push(0);
      this.wrongChars.push([]);
      this.transposed.push(false);
      this.ikis.push(0);
      this.timedFlags.push(false);
      this.rollFlags.push(false);
    }
    this.segments.push({
      start,
      end: this.line.length,
      requireCorrection: opts.requireCorrection ?? false,
    });
  }

  /** Reset the stream to a single segment. */
  setLine(line: string, opts: SegmentOptions = {}): void {
    this.reset();
    this.append(line, opts);
  }

  get position(): number {
    return this.pos;
  }

  get text(): string {
    return this.line;
  }

  get active(): boolean {
    return this.pos < this.line.length;
  }

  /** How many segments have been appended — the caller's index space. */
  get segmentCount(): number {
    return this.segments.length;
  }

  /** Where the segment being typed starts — nothing before this can be edited. */
  private get floor(): number {
    return this.segments[this.segIndex]?.start ?? 0;
  }

  private get blocking(): boolean {
    return this.segments[this.segIndex]?.requireCorrection ?? false;
  }

  /** A wrong character is under the caret and the caret is not allowed past it. */
  private get stuck(): boolean {
    const t = this.typed[this.pos];
    return this.blocking && t !== null && t !== undefined && t !== this.line[this.pos];
  }

  view(): LineView {
    return {
      pos: this.pos,
      typed: [...this.typed],
      wrong: this.typed.map((t, i) => t !== null && t !== this.line[i]),
      fixing: this.stuck,
    };
  }

  /** Partial results for an interrupted segment. */
  snapshot(): { chars: CharResult[]; totalErrors: number } {
    const from = this.floor;
    const chars = this.buildChars().slice(from, this.pos);
    return { chars, totalErrors: this.errorsIn(from, this.pos) };
  }

  private errorsIn(from: number, to: number): number {
    let n = 0;
    for (let i = from; i < to; i++) n += this.errorCount[i];
    return n;
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

  /** Hand the finished segment to the coach and move the window to the next. */
  private emitSegment(time: number): void {
    const seg = this.segments[this.segIndex];
    if (!seg) return;
    const all = this.buildChars();
    this.onComplete?.({
      line: this.line.slice(seg.start, seg.end),
      chars: all.slice(seg.start, seg.end),
      startTime: this.segStartTime ?? this.startTime ?? time,
      endTime: time,
      totalErrors: this.errorsIn(seg.start, seg.end),
    });
    this.segIndex++;
    // the next segment's clock starts where this one stopped, so a continuous
    // run is measured continuously
    this.segStartTime = time;
  }

  feed(ev: KeyEventLite): void {
    if (ev.type === "up") {
      this.pressed.delete(ev.code);
      return;
    }
    if (ev.key === "Backspace") {
      if (this.stuck) {
        // clear the blocking mistake in place; the caret has not moved past it
        this.typed[this.pos] = null;
        this.onProgress?.(this.view());
      } else if (this.pos > this.floor) {
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
    if (this.segStartTime === null) this.segStartTime = ev.time;
    this.lastTime = ev.time;

    this.typed[i] = ev.key;
    if (!correct) {
      this.errorCount[i]++;
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

    // precision: the wrong key stays under the caret until it is cleared
    if (!correct && this.blocking) {
      this.onProgress?.(this.view());
      return;
    }

    this.pos++;

    const seg = this.segments[this.segIndex];
    if (seg && this.pos >= seg.end) {
      this.onProgress?.(this.view());
      this.emitSegment(ev.time);
      return;
    }
    this.onProgress?.(this.view());
  }

  /**
   * Abandon the rest of the current segment. What was typed is still reported,
   * the untyped remainder is dropped, and the stream carries on from here.
   */
  skip(): void {
    const seg = this.segments[this.segIndex];
    if (!seg || this.pos <= seg.start) return;
    // drop everything the caret has not reached, including any lookahead
    this.line = this.line.slice(0, this.pos);
    this.typed.length = this.pos;
    this.touched.length = this.pos;
    this.errorCount.length = this.pos;
    this.wrongChars.length = this.pos;
    this.transposed.length = this.pos;
    this.ikis.length = this.pos;
    this.timedFlags.length = this.pos;
    this.rollFlags.length = this.pos;
    seg.end = this.pos;
    this.segments.length = this.segIndex + 1;
    this.emitSegment(this.lastTime);
    this.onProgress?.(this.view());
  }

  /** End the current segment where it stands (used when the coach moves on). */
  abort(): void {
    if (this.startTime !== null) this.emitSegment(this.lastTime);
  }
}
