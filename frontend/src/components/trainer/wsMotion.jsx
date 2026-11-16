/**
 * Motion for the owner & trainer workspace, on Apple's terms (WWDC
 * "Designing Fluid Interfaces"; Emil Kowalski's apple-design notes):
 *
 *   - SPRINGS, NOT DURATIONS. Everything that moves settles like a
 *     physical thing: a quick start, a soft landing, the faintest
 *     overshoot. One spring for the whole workspace, so it feels like one
 *     product.
 *   - RESPONSIVE. Feedback starts on the same frame as the tap; nothing
 *     waits for an animation to finish before it can be used again
 *     (springs are interruptible by nature).
 *   - QUIET. Motion explains a change -- where the highlight went, that a
 *     number arrived -- and then stops. Nothing loops; an idle workspace
 *     draws nothing (the app-wide lag fix depends on that).
 *   - OPTIONAL. Reduce Motion turns movement into a plain cross-fade
 *     (MotionConfig reducedMotion="user" in TrainerLayout, and the CSS
 *     media query in workspace.css).
 *
 * The CSS half of the same spring is --ws-spring in workspace.css, a
 * linear() curve sampled from this spring, for transitions that do not
 * need JavaScript.
 */
import { useEffect, useRef, useState } from 'react';

/** The workspace spring: ~0.5 s, bounce 0.15. */
export const SPRING = { type: 'spring', duration: 0.5, bounce: 0.15 };
/** For things that slide under a finger (a selection pill): stiffer, no bounce. */
export const GLIDE = { type: 'spring', duration: 0.38, bounce: 0 };

const reduced = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/**
 * A number that counts up to its value once, the first time it is shown
 * -- the way Apple's Fitness and Health summaries land their figures. A
 * later change of value jumps straight to it (a re-count on every refresh
 * would read as the number being unsure of itself).
 *
 * @param value  the number
 * @param format how to print it (money, a plain count...)
 */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString('en-IN'), duration = 900 }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(() => (reduced() ? target : 0));
  const done = useRef(false);
  useEffect(() => {
    if (done.current || reduced() || target === 0) { setShown(target); done.current = true; return undefined; }
    done.current = true;
    let raf = 0;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / duration);
      // ease-out-expo: fast, then settles -- reads as "arriving".
      const e = k === 1 ? 1 : 1 - 2 ** (-10 * k);
      setShown(target * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return <span className="tabular-nums">{format(shown)}</span>;
}
