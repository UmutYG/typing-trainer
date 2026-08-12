import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import wordsRaw from "./data/words.txt?raw";
import { buildCorpus } from "./core/words";
import { SkillModel } from "./core/model";
import { generateLine, DEFAULT_OPTIONS } from "./core/generator";
import type { CharResult, LineResult } from "./core/capture";
import { lineStats, type LineStats } from "./core/wpm";
import {
  COACH_PHRASE,
  NEW_SITTING_MS,
  UNLOCKS,
  currentLevel,
  flowStanding,
  gaps,
  instruct,
  isTiring,
  marksFor,
  nextStandard,
  openings,
  phaseAt,
  selectFocus,
  sessionReport,
  settledPairs,
  shouldClose,
  summarizeSet,
  unlockLevel,
  type Instruction,
  type OpeningKey,
  type SetChange,
  type SetSummary,
} from "./core/coach";
import type { TransitionClass } from "./core/keyboard";
import * as persist from "./core/persist";
import {
  Sound,
  loadSound,
  recallSitting,
  rememberSitting,
  type SoundSettings,
} from "./core/sound";
import { DrillScreen } from "./ui/DrillScreen";
import { Standing } from "./ui/Standing";
import { CoachBar } from "./ui/CoachBar";
import { useTypingStream } from "./ui/useTypingStream";

type Tab = "practice" | "standing";

export default function App() {
  const corpus = useMemo(() => buildCorpus(wordsRaw), []);
  const modelRef = useRef(new SkillModel());
  const soundRef = useRef<Sound | null>(null);
  if (!soundRef.current) soundRef.current = new Sound();

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("practice");
  const [sessions, setSessions] = useState<persist.SessionRecord[]>([]);
  const [days, setDays] = useState<persist.DayRecord[]>([]);
  const [modelVersion, setModelVersion] = useState(0);
  const [sound, setSound] = useState<SoundSettings>(() => loadSound());

  /** null until the sitting's one choice has been made */
  const [opening, setOpening] = useState<OpeningKey | null>(null);
  const openingRef = useRef<OpeningKey>("coach");
  /** segments finished in this sitting — drives the shape of the session */
  const [lineIndex, setLineIndex] = useState(0);
  const lineIndexRef = useRef(0);
  const [lastStats, setLastStats] = useState<LineStats | null>(null);
  const [summary, setSummary] = useState<SetSummary | null>(null);
  const [closing, setClosing] = useState(false);
  const [stopped, setStopped] = useState(false);

  /** what the coach decided for each segment, by index */
  const planRef = useRef<Instruction[]>([]);
  const [planVersion, setPlanVersion] = useState(0);

  /** what the current set started from, so it can report what it changed */
  const setTracker = useRef({
    phase: "warmup" as Instruction["phase"],
    number: 1,
    targets: [] as string[],
    before: new Map<string, number>(),
    wpms: [] as number[],
  });
  const prevPhaseWpm = useRef<Record<string, number>>({});
  const lastFocusClass = useRef<TransitionClass | null>(null);
  const announcedLevel = useRef(1);
  const tiring = useRef(false);
  const sittingLines = useRef<{ wpm: number; accuracy: number }[]>([]);
  const sittingStart = useRef<number | null>(null);
  /** every improvement seen this sitting, for the closing word */
  const sittingChanges = useRef<SetChange[]>([]);
  /** once set, the session closes after this segment */
  const closeAfter = useRef<number | null>(null);

  useEffect(() => {
    (window as unknown as { dumpData: () => Promise<string> }).dumpData = persist.exportAll;
  }, []);

  useEffect(() => {
    soundRef.current!.settings = sound;
  }, [sound]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await persist.ensureBackup();
        const [savedModel, savedSessions, savedDays] = await Promise.all([
          persist.loadModel(),
          persist.getSessions(),
          persist.getDays(),
        ]);
        if (cancelled) return;
        if (savedModel) {
          try {
            modelRef.current = SkillModel.deserialize(savedModel);
          } catch (e) {
            // never start from zero over a parse failure: put the unreadable
            // copy aside, then fall back to the last good snapshot
            await persist.quarantine("model", savedModel);
            const backup = await persist.latestBackup();
            if (backup) modelRef.current = SkillModel.deserialize(backup);
            console.warn("model could not be read; recovered from backup", e);
          }
        }
        setSessions(savedSessions);
        setDays(savedDays);
        const last = savedSessions.length > 0 ? savedSessions[savedSessions.length - 1].time : 0;
        // still inside the same sitting: pick up where it was, with the shape
        // that was chosen, rather than asking the same question again
        const resumed = recallSitting(NEW_SITTING_MS) as OpeningKey | null;
        if (resumed && Date.now() - last < NEW_SITTING_MS && savedSessions.length > 0) {
          openingRef.current = resumed;
          setOpening(resumed);
          sittingStart.current = Date.now();
        }
        setReady(true);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const meansFor = useCallback((bigrams: string[]) => {
    const m = new Map<string, number>();
    for (const bg of bigrams) {
      const s = modelRef.current.bigrams.get(bg);
      if (s && s.count > 0) m.set(bg, s.mean);
    }
    return m;
  }, []);

  /** The coach's read of where things stand, right now. */
  const read = useCallback(() => {
    const model = modelRef.current;
    const level = currentLevel(model, corpus.engFreq);
    const tier = nextStandard(level?.wpm ?? null);
    const ranked = gaps(model, corpus.engFreq, tier);
    return { model, level, tier, ranked };
  }, [corpus]);

  /**
   * Decide what segment `index` is for, build its text, and hand it to the
   * engine. Called one segment ahead of the caret so there is always text to
   * read into — a typist looks several words past the one being typed.
   */
  const appendSegment = useCallback(
    (index: number, engine: ReturnType<typeof useTypingStream>["engine"]) => {
      const { model, level, tier, ranked } = read();
      const ps = phaseAt(index, openingRef.current);
      const focus = selectFocus(ranked, { avoidClass: lastFocusClass.current });
      if (ps.phase === "focus" && ps.indexInPhase === 0) lastFocusClass.current = focus.cls;
      const flow = flowStanding(model);
      const stage = unlockLevel(model, tier);

      let announce: string | null = null;
      if (stage > announcedLevel.current) {
        announce = UNLOCKS[stage]?.announce ?? null;
        announcedLevel.current = stage;
      }

      const finishing = closeAfter.current === index;
      const ins = instruct({
        phaseState: ps,
        focus,
        flow,
        marks: marksFor(stage),
        announce,
        tiring: tiring.current,
        finishing,
        settled: finishing ? settledPairs(ranked) : undefined,
      });

      planRef.current[index] = ins;
      const text = generateLine(corpus, ins.targets, {
        ...DEFAULT_OPTIONS,
        lineLength: ins.lineLength,
        targetDensity: ins.density,
        marks: ins.marks,
        capitals: ins.capitals,
      }).text;
      engine.append(text, { requireCorrection: ins.phase === "precision" });
      void level;
    },
    [corpus, read],
  );

  const recordIntoModel = useCallback((text: string, chars: CharResult[]) => {
    const model = modelRef.current;
    for (let i = 1; i < chars.length; i++) {
      const bigram = text[i - 1] + text[i];
      const c = chars[i];
      if (c.errors > 0) {
        model.recordErrors(bigram, c.errors, {
          wrongChars: c.wrongChars,
          transposed: c.transposed,
        });
      }
      if (c.timed) model.recordSample(bigram, c.iki, c.rollover);
      else model.recordUntimed(bigram);
    }
  }, []);

  const onSegment = useCallback(
    (result: LineResult) => {
      const done = lineIndexRef.current;
      recordIntoModel(result.line, result.chars);
      const stats = lineStats(result);
      setLastStats(stats);
      setTracker.current.wpms.push(stats.wpm);
      setSummary(null); // the moment you type again, the last set is behind you
      if (sittingStart.current === null) sittingStart.current = Date.now();

      const rec: persist.SessionRecord = {
        time: Date.now(),
        ms: Math.max(0, result.endTime - result.startTime),
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        rolloverRate: stats.rolloverRate,
        consistency: stats.consistency,
        chars: result.line.length,
        errors: result.totalErrors,
        targets: planRef.current[done]?.targets ?? [],
        mode: planRef.current[done]?.phase ?? "focus",
      };
      sittingLines.current = [
        ...sittingLines.current,
        { wpm: stats.wpm, accuracy: stats.accuracy },
      ].slice(-30);
      tiring.current = isTiring(sittingLines.current);

      setSessions((prev) => [...prev, rec]);
      void persist.addSession(rec).then(() =>
        persist.compactSessions().then((n) => {
          if (n > 0) void persist.getSessions().then(setSessions);
        }),
      );
      void persist.saveModel(modelRef.current.serialize());
      setModelVersion((v) => v + 1);

      const next = done + 1;
      lineIndexRef.current = next;

      // that was the last passage of the session
      if (closeAfter.current !== null && done >= closeAfter.current) {
        setClosing(true);
        setLineIndex(next);
        return;
      }

      // a set has ended: report what it changed
      const ps = phaseAt(next, openingRef.current);
      const t = setTracker.current;
      if (ps.indexInPhase === 0) {
        if (t.wpms.length > 0) {
          const s = summarizeSet({
            phase: t.phase,
            setNumber: t.number,
            targets: t.targets,
            before: t.before,
            after: meansFor(t.targets),
            wpms: t.wpms,
            prevPhaseWpm: prevPhaseWpm.current[t.phase] ?? null,
          });
          setSummary(s);
          sittingChanges.current.push(...s.changes.filter((c) => c.better));
          prevPhaseWpm.current[t.phase] = t.wpms.reduce((a, b) => a + b, 0) / t.wpms.length;
        }
        const nextIns = planRef.current[next];
        setTracker.current = {
          phase: ps.phase,
          number: t.wpms.length > 0 ? t.number + 1 : t.number,
          targets: nextIns?.targets ?? [],
          before: meansFor(nextIns?.targets ?? []),
          wpms: [],
        };
      }

      // has another passage stopped buying anything?
      const elapsed = Date.now() - (sittingStart.current ?? Date.now());
      if (
        closeAfter.current === null &&
        shouldClose({
          elapsedMs: elapsed,
          tiring: tiring.current,
          atSetBoundary: ps.indexInPhase === 0,
        })
      ) {
        // one more, built from what is already yours, then the door
        closeAfter.current = next + 1;
      }

      setLineIndex(next);
      setPlanVersion((v) => v + 1);
    },
    [recordIntoModel, meansFor],
  );

  const onKey = useCallback((correct: boolean) => {
    soundRef.current!.key(correct);
  }, []);

  const typingEnabled = ready && opening !== null && !closing && !stopped && tab === "practice";
  const { view, engine, typing } = useTypingStream(onSegment, onKey, typingEnabled);

  // keep one segment of text queued past the caret at all times
  useEffect(() => {
    if (!typingEnabled) return;
    while (engine.segmentCount < lineIndex + 2) {
      appendSegment(engine.segmentCount, engine);
    }
    setPlanVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingEnabled, lineIndex, engine]);

  // the plan is written by an effect, so the render that follows it needs a
  // reason to look again
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const instruction = useMemo(() => planRef.current[lineIndex] ?? null, [lineIndex, planVersion]);
  const phaseState = phaseAt(lineIndex, openingRef.current);

  // the pacer runs only where speed is the thing being trained
  useEffect(() => {
    const s = soundRef.current!;
    if (!typingEnabled || instruction?.phase !== "stretch" || !sound.pacer) {
      s.stopPacer();
      return;
    }
    const { level, tier } = read();
    const target = Math.min(tier, Math.max(60, (level?.wpm ?? 90) * 1.12));
    s.startPacer(target);
    return () => s.stopPacer();
  }, [typingEnabled, instruction?.phase, sound.pacer, read, modelVersion]);

  // Escape abandons a passage you have no appetite for
  useEffect(() => {
    if (!typingEnabled) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        engine.skip();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [typingEnabled, engine]);

  const beginSitting = useCallback((key: OpeningKey) => {
    openingRef.current = key;
    rememberSitting(key);
    sittingStart.current = Date.now();
    sittingLines.current = [];
    sittingChanges.current = [];
    closeAfter.current = null;
    lineIndexRef.current = 0;
    planRef.current = [];
    setLineIndex(0);
    setSummary(null);
    setLastStats(null);
    setOpening(key);
  }, []);

  const keepGoing = useCallback(() => {
    closeAfter.current = null;
    sittingStart.current = Date.now();
    sittingLines.current = [];
    tiring.current = false;
    setClosing(false);
  }, []);

  const onExport = useCallback(async () => {
    const json = await persist.exportAll();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `typing-trainer-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const onReset = useCallback(() => {
    if (!window.confirm("Delete all typing data and start fresh? This cannot be undone.")) return;
    indexedDB.deleteDatabase("typing-trainer");
    location.reload();
  }, []);

  const minutesToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = sessions.filter((s) => s.time >= start.getTime()).reduce((a, s) => a + s.ms, 0);
    return Math.round(ms / 60000);
  }, [sessions]);

  const toggle = (k: keyof SoundSettings) => {
    const next = { ...sound, [k]: !sound[k] };
    setSound(next);
    soundRef.current!.update(next);
  };

  const openingList = useMemo(() => {
    if (!ready) return [];
    const { ranked } = read();
    return openings(selectFocus(ranked).cls);
  }, [ready, read]);

  const report = useMemo(() => {
    if (!closing && !stopped) return null;
    const { ranked } = read();
    const cls = selectFocus(ranked, { avoidClass: lastFocusClass.current }).cls;
    return sessionReport({
      minutes: minutesToday,
      passages: sittingLines.current.length,
      changes: sittingChanges.current,
      nextPhrase: cls ? COACH_PHRASE[cls] : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing, stopped, minutesToday]);

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <div className="hint">
        {loadError}
        <div style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  } else if (!ready) {
    body = <div className="hint">loading…</div>;
  } else if (tab === "standing") {
    body = (
      <Standing
        key={modelVersion}
        model={modelRef.current}
        sessions={sessions}
        days={days}
        corpus={corpus}
        onExport={onExport}
        onReset={onReset}
      />
    );
  } else if (stopped) {
    body = (
      <div className="close-card">
        <div className="close-title">Good.</div>
        <div className="close-body">{report?.thread ?? "Come back when you feel like it."}</div>
      </div>
    );
  } else if (opening === null) {
    body = (
      <div className="opening">
        <div className="opening-title">What kind of session?</div>
        <div className="opening-list">
          {openingList.map((o) => (
            <button className="opening-card" key={o.key} onClick={() => beginSitting(o.key)}>
              <span className="ol">{o.label}</span>
              <span className="on">{o.note}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (closing) {
    body = (
      <div className="close-card">
        <div className="close-title">{report?.title}</div>
        <div className="close-body">
          {report?.body}
          {report?.thread && <div className="thread">{report.thread}</div>}
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={() => setStopped(true)}>
            Stop here
          </button>
          <button className="btn" onClick={keepGoing}>
            Keep going
          </button>
        </div>
      </div>
    );
  } else if (instruction === null) {
    body = <div className="hint">loading…</div>;
  } else {
    body = (
      <>
        <CoachBar
          instruction={instruction}
          phaseState={phaseState}
          minutesToday={minutesToday}
          summary={summary}
          setNumber={setTracker.current.number}
          receded={typing}
        />
        <DrillScreen
          text={engine.text}
          view={view}
          phase={instruction.phase}
          strict={instruction.phase === "precision"}
          last={lastStats}
          typing={typing}
        />
      </>
    );
  }

  return (
    <>
      <div className="header">
        <span className="brand">
          <span className="dot" />
          typing trainer
        </span>
        <div className="nav">
          <button className={tab === "practice" ? "active" : ""} onClick={() => setTab("practice")}>
            Practice
          </button>
          <button className={tab === "standing" ? "active" : ""} onClick={() => setTab("standing")}>
            Standing
          </button>
        </div>
        <div className="spacer" />
        <div className="sound-row">
          <button
            className={"chip" + (sound.tick ? " on" : "")}
            onClick={() => toggle("tick")}
            title="A soft click under each keystroke, so uneven rhythm becomes audible"
          >
            tick
          </button>
          <button
            className={"chip" + (sound.pacer ? " on" : "")}
            onClick={() => toggle("pacer")}
            title="A click track during stretch sets, beating once per word"
          >
            pace
          </button>
        </div>
      </div>
      {body}
    </>
  );
}
