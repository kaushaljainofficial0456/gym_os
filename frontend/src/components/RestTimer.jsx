/**
 * REST TIMER — between-set countdown.
 *
 * WHY IT IS BUILT ON A DEADLINE, NOT A COUNTER:
 * The obvious implementation is `setInterval(() => setLeft(l => l - 1), 1000)`.
 * That is wrong for this specific use, in two ways that both matter in a gym:
 *
 *   1. setInterval drifts. It guarantees "at least" 1000 ms, never exactly,
 *      so a 90 s rest measured this way runs long — and the error compounds
 *      the whole session.
 *   2. Browsers THROTTLE timers in a backgrounded tab, typically to once a
 *      minute. A phone that locks, or a user who switches to Spotify mid-set
 *      — which is most users, most sets — freezes a counter-based timer. Come
 *      back after 90 real seconds and it still shows 60 s left.
 *
 * So the single source of truth is `endsAt`, an absolute timestamp. Every
 * tick RECOMPUTES the remaining time from the clock, which makes the
 * interval a repaint trigger rather than the timekeeper. Throttled or not,
 * the number is right whenever it is next painted, and re-syncs the instant
 * the tab becomes visible again.
 *
 * COMPLETION FEEDBACK is vibration, not sound. A gym is loud enough that a
 * chime is useless, headphones make it intrusive, and browsers block
 * unprompted audio anyway. navigator.vibrate is a no-op where unsupported
 * (all of iOS Safari), so the visual state change is the real signal and
 * vibration is the enhancement.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, Pressable, useReducedMotion } from '../design/index.js';

/** Remaining whole seconds until `endsAt`, never negative. */
function secondsLeft(endsAt) {
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function RestTimer({
  endsAt,
  totalSec,
  exerciseName,
  nextLabel,
  onSkip,
  onDone,
  onAddTime,
}) {
  const [left, setLeft] = useState(() => secondsLeft(endsAt));
  const reduced = useReducedMotion();
  // onDone must fire exactly once per rest period, even though the effect
  // re-runs on every tick.
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    setLeft(secondsLeft(endsAt));
  }, [endsAt]);

  useEffect(() => {
    let raf = null;

    const sync = () => {
      const remaining = secondsLeft(endsAt);
      setLeft(remaining);
      if (remaining === 0 && !firedRef.current) {
        firedRef.current = true;
        // Enhancement only — absent on iOS Safari, where the visual change
        // is the whole signal.
        try { navigator.vibrate?.([120, 60, 120]); } catch { /* not supported */ }
        onDone?.();
      }
    };

    sync();
    // 250 ms, not 1000: the displayed second then changes within a quarter
    // second of the real boundary instead of lagging by up to a full second.
    // Still trivial work — it reads a clock and maybe sets one number.
    const h = setInterval(sync, 250);

    // A throttled tab can miss ticks entirely. Re-sync the moment it is
    // visible again, before the next interval would have fired.
    const onVis = () => { if (!document.hidden) sync(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', onVis);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [endsAt, onDone]);

  const done = left === 0;
  const frac = totalSec > 0 ? Math.min(1, Math.max(0, left / totalSec)) : 0;
  // Ring geometry. Stroke is drawn from the top and drains clockwise.
  const R = 54;
  const C = 2 * Math.PI * R;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-x-0 bottom-0 z-40 px-4 pb-4"
        initial={reduced ? false : { y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={reduced ? undefined : { y: 80, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <div
          className="card p-4 flex items-center gap-4"
          style={{
            // Lifts on completion so "go" is readable at a glance from
            // across a gym floor, without a colour change carrying the
            // whole message.
            borderColor: done ? 'var(--accent)' : 'var(--line)',
            boxShadow: done ? '0 0 0 1px var(--accent), var(--card-shadow)' : 'var(--card-shadow)',
          }}
        >
          <div className="relative flex-none" style={{ width: 120, height: 120 }}>
            <svg width="120" height="120" className="-rotate-90">
              <circle cx="60" cy="60" r={R} fill="none" stroke="var(--line)" strokeWidth="6" />
              <circle
                cx="60" cy="60" r={R} fill="none"
                stroke="var(--accent)" strokeWidth="6" strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - frac)}
                // No CSS transition: the value is recomputed from the clock
                // four times a second, and a 1 s ease would fight it and
                // make the ring lag visibly behind the digits.
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div
                className="font-black tabular-nums leading-none"
                style={{ fontSize: 28, color: done ? 'var(--accent)' : 'var(--ink)' }}
              >
                {done ? 'GO' : formatClock(left)}
              </div>
              {!done && (
                <div className="mt-1 text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>
                  rest
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>
              {done ? 'Next up' : 'Resting'}
            </div>
            <div className="mt-1 font-bold text-[15px] leading-tight truncate" style={{ color: 'var(--ink)' }}>
              {nextLabel || exerciseName || 'Next set'}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Pressable
                onClick={onSkip}
                className="btn-primary !py-2.5 px-4 text-[12px] font-bold flex-1"
              >
                {done ? 'Start set' : 'Skip rest'}
              </Pressable>
              {!done && (
                <Pressable
                  onClick={() => onAddTime?.(30)}
                  className="btn !py-2.5 px-3 text-[12px] font-semibold whitespace-nowrap"
                  aria-label="Add 30 seconds of rest"
                >
                  +30s
                </Pressable>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
