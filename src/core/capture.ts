// Keystroke capture: precise inter-key intervals from keydown timestamps,
// rollover detection from overlapping keydown/keyup, forced-correction errors.
// Pure state machine over (type, code, key, time) events so it is fully testable
// with synthetic streams.

export interface KeyEventLite {
  type: "down" | "up";
  key: string; // event.key
  code: string; // event.code (physical key identity, for rollover)
  time: number; // performance.now() ms
}

export interface CharResult {
  char: string;
  iki: number; // ms since previous correct keydown (0 if untimed)
  timed: boolean; // usable for speed stats
  rollover: boolean;
  errorsBefore: number; // wrong keystrokes made at this position
}

export interface LineResult {
  line: string;
  chars: CharResult[];
  startTime: number;
  endTime: number;
  totalErrors: number;
}

const PAUSE_MS = 2500; // gaps beyond this are hesitation/pauses, not typing speed

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Tab",
  "Escape",
  "Enter",
  "Backspace",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export class CaptureEngine {
  private line = "";
  private pos = 0;
  private results: CharResult[] = [];
  private errorsAtPos = 0;
  private pressed = new Map<string, number>(); // code -> downTime
  private prevDown: { code: string; time: number } | null = null;
  private startTime = 0;
  private totalErrors = 0;

  onProgress: ((pos: number, errorAtPos: boolean) => void) | null = null;
  onComplete: ((result: LineResult) => void) | null = null;

  setLine(line: string): void {
    this.line = line;
    this.pos = 0;
    this.results = [];
    this.errorsAtPos = 0;
    this.startTime = 0;
    this.totalErrors = 0;
    // deliberately keep prevDown/pressed: the transition from the last char of
    // the previous line into the first char of this one is not scored anyway
  }

  get position(): number {
    return this.pos;
  }

  get active(): boolean {
    return this.pos < this.line.length;
  }

  feed(ev: KeyEventLite): void {
    if (ev.type === "up") {
      this.pressed.delete(ev.code);
      return;
    }
    if (MODIFIER_KEYS.has(ev.key) || ev.key.length !== 1) return;
    if (!this.active) return;

    const expected = this.line[this.pos];
    const wasPressed = this.prevDown !== null && this.pressed.has(this.prevDown.code);
    this.pressed.set(ev.code, ev.time);

    if (ev.key !== expected) {
      this.errorsAtPos++;
      this.totalErrors++;
      this.prevDown = { code: ev.code, time: ev.time };
      this.onProgress?.(this.pos, true);
      return;
    }

    if (this.pos === 0) this.startTime = ev.time;
    const iki = this.prevDown ? ev.time - this.prevDown.time : 0;
    const timed =
      this.pos > 0 && this.errorsAtPos === 0 && this.prevDown !== null && iki > 0 && iki < PAUSE_MS;

    this.results.push({
      char: expected,
      iki: timed ? iki : 0,
      timed,
      rollover: timed && wasPressed,
      errorsBefore: this.errorsAtPos,
    });

    this.errorsAtPos = 0;
    this.prevDown = { code: ev.code, time: ev.time };
    this.pos++;
    this.onProgress?.(this.pos, false);

    if (this.pos >= this.line.length) {
      this.onComplete?.({
        line: this.line,
        chars: this.results,
        startTime: this.startTime,
        endTime: ev.time,
        totalErrors: this.totalErrors,
      });
    }
  }
}
