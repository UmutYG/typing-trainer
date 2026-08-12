import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LineView } from "../core/capture";
import type { Phase } from "../core/coach";
import { rowOf, wrapRows } from "../core/wrap";

/** Characters per visual row. Comfortably inside the 45–75 reading band. */
export const COLS = 48;
/** Row height in pixels — shared by the layout and the scroll maths. */
const ROW_H = 46;
/** Rows on screen at once: the one you are typing, one behind, one ahead. */
const VISIBLE = 3;
/** How many rows are kept in the DOM below the window. */
const RENDERED = 16;
/** Past this far from the window base, re-base — invisibly. */
const REBASE_AFTER = 12;

/** Stands for "nothing typed here yet". Must be a character that cannot be
 *  typed, or a correctly typed space would read back as untyped. */
const NUL = String.fromCharCode(0);

/** One visual row. Memoised on its own typed state, so a keystroke only ever
 *  re-renders the row the caret is on. */
const Row = memo(function Row({
  text,
  typedKey,
  strict,
}: {
  text: string;
  typedKey: string;
  strict: boolean;
}) {
  return (
    <div className="row" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>
      {text.split("").map((ch, i) => {
        const t = typedKey[i];
        if (t === undefined || t === NUL) {
          return (
            <span key={i} className="todo">
              {ch}
            </span>
          );
        }
        if (t === ch) {
          return (
            <span key={i} className="ok">
              {ch}
            </span>
          );
        }
        return (
          <span key={i} className={strict ? "bad" : "bad soft"}>
            {t === " " ? "␣" : t}
          </span>
        );
      })}
    </div>
  );
});

interface Props {
  text: string;
  view: LineView;
  phase: Phase;
  /** precision work: mistakes are called out properly rather than softly */
  strict: boolean;
}

/**
 * The typing surface. The text runs on without stopping — rows scroll up
 * beneath a caret that holds its place, so there is no moment where a passage
 * ends, the screen clears, and the eye has to find its way back to the start.
 */
export function ScrollingText({ text, view, phase, strict }: Props) {
  const rows = wrapRows(text, COLS);
  const caretRow = rowOf(rows, view.pos);
  const [win, setWin] = useState({ base: 0, jump: true });
  const innerRef = useRef<HTMLDivElement>(null);
  const [chWidth, setChWidth] = useState(0);

  // keep the rendered window around the caret; the shift is arranged to be
  // visually identical to where the scroll already was, so it is never seen
  useLayoutEffect(() => {
    if (caretRow - win.base > REBASE_AFTER || caretRow < win.base) {
      setWin({ base: Math.max(0, caretRow - 1), jump: true });
    }
  }, [caretRow, win.base]);

  // re-arm the animation only once the re-based frame has actually painted
  useEffect(() => {
    if (win.jump) setWin((w) => ({ ...w, jump: false }));
  }, [win.jump]);

  useLayoutEffect(() => {
    const measure = () => {
      const el = innerRef.current;
      if (el) setChWidth(el.getBoundingClientRect().width / COLS);
    };
    measure();
    window.addEventListener("resize", measure);
    // a late-loading monospace font changes the advance width under us
    if (document.fonts) void document.fonts.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const last = Math.min(rows.length, win.base + RENDERED);
  const offset = Math.min(0, (1 - caretRow + win.base) * ROW_H);
  const caretCol = view.pos - rows[caretRow];

  const body = [];
  for (let r = win.base; r < last; r++) {
    const from = rows[r];
    const to = r + 1 < rows.length ? rows[r + 1] : text.length;
    let key = "";
    for (let i = from; i < to; i++) key += view.typed[i] ?? NUL;
    body.push(<Row key={r} text={text.slice(from, to)} typedKey={key} strict={strict} />);
  }

  return (
    <div className="viewport" style={{ height: VISIBLE * ROW_H }} aria-label="text to type">
      <div
        ref={innerRef}
        className={"scroller" + (win.jump ? " nojump" : "")}
        style={{ width: `${COLS}ch`, transform: `translateY(${offset}px)` }}
      >
        {body}
        <span
          className={"caret" + (view.fixing ? " blocked" : "")}
          data-phase={phase}
          style={{
            transform: `translate(${caretCol * chWidth}px, ${(caretRow - win.base) * ROW_H}px)`,
            height: ROW_H,
            opacity: chWidth > 0 ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
}
