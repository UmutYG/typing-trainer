import type { LineView } from "../core/capture";

/**
 * The typing surface: untyped text recedes, typed text is bright, mistakes show
 * the character you actually hit, and the caret sits before the next character.
 */
export function TypedLine({ text, view }: { text: string; view: LineView }) {
  return (
    <div className="line" aria-label="text to type">
      {text.split("").map((ch, i) => {
        const typed = view.typed[i];
        const isWrong = i < view.pos && typed !== null && typed !== ch;
        const cls =
          i === view.pos ? "cur" : i < view.pos ? (isWrong ? "bad" : "ok") : "todo";
        const shown = isWrong ? (typed === " " ? "␣" : typed) : ch;
        return (
          <span key={i} className={cls}>
            {shown}
          </span>
        );
      })}
    </div>
  );
}
