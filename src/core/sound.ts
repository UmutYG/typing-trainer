// Sound, for the one thing the eye is bad at.
//
// Evenness of rhythm is what separates two typists of the same average speed,
// and it is almost impossible to judge visually — a chart of your own timing
// after the fact is not the same sense as hearing yourself lurch. Auditory
// entrainment is far stronger than visual, which is why every other discipline
// that trains timing uses a metronome and not a flashing light.
//
// The pacer beats once per word, so its tempo in beats per minute *is* the
// words per minute it is asking for.

export interface SoundSettings {
  /** a soft click under each keystroke, so unevenness becomes audible */
  tick: boolean;
  /** the click track during stretch work */
  pacer: boolean;
}

export const DEFAULT_SOUND: SoundSettings = { tick: true, pacer: true };

const STORE_KEY = "typing-trainer:sound";

export function loadSound(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_SOUND };
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      tick: typeof v.tick === "boolean" ? v.tick : DEFAULT_SOUND.tick,
      pacer: typeof v.pacer === "boolean" ? v.pacer : DEFAULT_SOUND.pacer,
    };
  } catch {
    return { ...DEFAULT_SOUND };
  }
}

export function saveSound(s: SoundSettings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // a browser refusing storage is not a reason to stop making noise
  }
}

const SITTING_KEY = "typing-trainer:sitting";

/**
 * The session shape you chose, remembered for as long as the sitting lasts —
 * reloading the page mid-session should not quietly hand the choice back to
 * the coach.
 */
export function rememberSitting(key: string): void {
  try {
    localStorage.setItem(SITTING_KEY, JSON.stringify({ key, at: Date.now() }));
  } catch {
    /* storage refused; the choice simply will not survive a reload */
  }
}

export function recallSitting(withinMs: number): string | null {
  try {
    const raw = localStorage.getItem(SITTING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { key?: string; at?: number };
    if (typeof v.key !== "string" || typeof v.at !== "number") return null;
    return Date.now() - v.at < withinMs ? v.key : null;
  } catch {
    return null;
  }
}

/** how far ahead of the clock beats are queued, in seconds */
const LOOKAHEAD = 0.12;
/** how often the queue is topped up, in ms */
const TICK_MS = 25;

export class Sound {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private interval = 0.5; // seconds between beats
  settings: SoundSettings = { ...DEFAULT_SOUND };

  /**
   * The context can only be created once the user has interacted with the page,
   * so it is built on the first keystroke rather than at load.
   */
  private ac(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private blip(at: number, freq: number, gain: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at);
    // a hard start or stop on a sine is a click of its own; ramp both ends
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(gain, at + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(amp).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** Under a keystroke. Quiet enough to sit below the keyboard's own noise. */
  key(correct: boolean): void {
    if (!this.settings.tick) return;
    const ctx = this.ac();
    if (!ctx) return;
    if (correct) this.blip(ctx.currentTime, 1650, 0.022, 0.014);
    else this.blip(ctx.currentTime, 320, 0.05, 0.055);
  }

  /**
   * Start the click track at a given words per minute — one beat per word, so
   * the tempo is the target speed rather than a number standing in for it.
   */
  startPacer(wpm: number): void {
    if (!this.settings.pacer) return;
    const ctx = this.ac();
    if (!ctx) return;
    this.interval = Math.max(0.2, Math.min(2, 60 / wpm));
    if (this.timer !== null) return; // already running; the tempo is updated above
    this.nextBeat = ctx.currentTime + 0.1;
    this.timer = setInterval(() => {
      const c = this.ctx;
      if (!c) return;
      // queue every beat that falls inside the lookahead window, so the tempo
      // is held by the audio clock rather than by a drifting javascript timer
      while (this.nextBeat < c.currentTime + LOOKAHEAD) {
        this.blip(this.nextBeat, 900, 0.045, 0.03);
        this.nextBeat += this.interval;
      }
    }, TICK_MS);
  }

  stopPacer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  update(s: SoundSettings): void {
    this.settings = s;
    if (!s.pacer) this.stopPacer();
    saveSound(s);
  }
}
