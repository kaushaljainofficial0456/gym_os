/**
 * ScrollWheel — vertical picker with a real wheel feel.
 *
 * WHAT WAS WRONG BEFORE, because each fix below is undoing a specific
 * cause of the "scrolling doesn't feel right" report:
 *
 * 1. TWO SNAP ENGINES FIGHTING. The list had CSS `scroll-snap-type: y
 *    mandatory` AND a JS snap that called scrollTo({behavior:'smooth'})
 *    80ms after scrolling stopped. The browser was already snapping, so
 *    the JS correction landed on top of it -- and because a programmatic
 *    smooth scroll fires scroll events of its own, it re-armed the same
 *    timer and snapped again. That loop is the stutter you could feel at
 *    the end of every flick. CSS snap now does the snapping alone; JS
 *    only READS the position to report which value is centred.
 *
 * 2. A SECOND CORRECTION LOOP. Reporting a new value re-rendered the
 *    parent with a new `value`, which tripped an effect that scrolled the
 *    list "to where value says it should be" -- while the user was still
 *    dragging it somewhere else. The programmatic scroll is now guarded:
 *    it only runs for a value the wheel did not itself just report.
 *
 * 3. NOTHING MOVED UNTIL YOU STOPPED. Emphasis was binary (selected vs
 *    not) and only recalculated after the debounce, so during the drag
 *    the list was inert. Items are now styled from their live distance to
 *    the centre, updated on every frame, so the wheel responds under the
 *    thumb.
 *
 * 4. ANIMATING font-size. That is a layout property; changing it per
 *    frame on every visible row forces reflow. Scale is a transform and
 *    runs on the compositor.
 *
 * 5. THE PAGE SCROLLED BEHIND IT. The wheel listener used
 *    stopPropagation on a PASSIVE listener -- stopPropagation does not
 *    stop scrolling, and passive listeners may not preventDefault, so the
 *    page moved underneath. The listener is non-passive and prevents the
 *    default only while the wheel has somewhere left to travel.
 *
 * It is also operable from a keyboard now, which it previously was not
 * at all: it is a real listbox with arrow/Home/End/PageUp/PageDown.
 */
import { useRef, useEffect, useCallback, useState } from 'react';

const ITEM_H = 36;
const VISIBLE = 5;
const PAD = Math.floor(VISIBLE / 2) * ITEM_H;

const reduceMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function ScrollWheel({
  value, onChange, min, max, formatItem, style, className = '', label = 'Select a value',
}) {
  const ref = useRef(null);
  const frame = useRef(0);
  // The last value THIS wheel reported. Lets the programmatic-scroll
  // effect below tell "the parent moved us" apart from "we moved
  // ourselves", which is what stops the two from fighting mid-drag.
  const selfReported = useRef(value);
  const [offset, setOffset] = useState(0); // live scroll position, in items

  const count = max - min + 1;
  const items = Array.from({ length: count }, (_, i) => min + i);
  const fmt = formatItem || ((v) => String(v));

  const scrollToIndex = useCallback((idx, smooth) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: idx * ITEM_H, behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
  }, []);

  /* Read-only: report which item is centred and drive the live styling.
     Never writes scrollTop -- CSS snap owns the motion. */
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const pos = el.scrollTop / ITEM_H;
      setOffset(pos);
      const idx = Math.max(0, Math.min(count - 1, Math.round(pos)));
      const next = min + idx;
      if (next !== selfReported.current) {
        selfReported.current = next;
        onChange(next);
      }
    });
  }, [count, min, onChange]);

  // Initial position, without animation.
  useEffect(() => {
    const idx = Math.max(0, Math.min(count - 1, value - min));
    scrollToIndex(idx, false);
    setOffset(idx);
    selfReported.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Only follows a value the wheel did not just report -- e.g. a unit
     switch, or a reset from the parent. Without this guard the parent's
     echo of our own value scrolled the list out from under the thumb. */
  useEffect(() => {
    if (value === selfReported.current) return;
    selfReported.current = value;
    const idx = Math.max(0, Math.min(count - 1, value - min));
    scrollToIndex(idx, true);
  }, [value, min, count, scrollToIndex]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /* Contain the wheel gesture properly. preventDefault is the only thing
     that actually stops the page scrolling, and it requires a
     non-passive listener. Released at the ends so the page can take over
     once the wheel has nowhere left to go. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
      if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) return;
      e.preventDefault();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const step = (delta) => {
    const idx = Math.max(0, Math.min(count - 1, (value - min) + delta));
    selfReported.current = min + idx;
    onChange(min + idx);
    scrollToIndex(idx, true);
  };

  const onKeyDown = (e) => {
    const jump = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
    if (jump[e.key] !== undefined) { e.preventDefault(); step(jump[e.key]); return; }
    if (e.key === 'Home') { e.preventDefault(); step(-count); return; }
    if (e.key === 'End') { e.preventDefault(); step(count); }
  };

  return (
    // The scroller is wrapped so a CENTRE BAND can sit over it. Without
    // one there is nothing marking where "selected" is: the numbers just
    // drift in empty space and you have to infer the target line from the
    // type sizes. Every physical picker this imitates has that band.
    // pointer-events:none so it never eats a drag.
    <div className="relative" style={{ height: VISIBLE * ITEM_H }}>
      <div
        aria-hidden="true"
        className="absolute left-0 right-0 pointer-events-none"
        style={{
          top: PAD,
          height: ITEM_H,
          borderTop: '1px solid var(--line)',
          borderBottom: '1px solid var(--line)',
          background: 'var(--accent-soft)',
          borderRadius: 10,
        }}
      />
      {/* Fade the ends so the list reads as a wheel continuing past the
          window rather than a box that abruptly clips. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 pointer-events-none"
        style={{ height: PAD, background: 'linear-gradient(to bottom, var(--bg), transparent)', zIndex: 2 }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{ height: PAD, background: 'linear-gradient(to top, var(--bg), transparent)', zIndex: 2 }}
      />
    <div
      ref={ref}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`sw-opt-${value}`}
      className={`overflow-y-scroll sw-scroll relative ${className}`}
      style={{
        height: VISIBLE * ITEM_H,
        scrollSnapType: 'y mandatory',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        // The list is its own scroll region; a flick here must not chain
        // into the page behind it.
        overscrollBehavior: 'contain',
        outline: 'none',
        ...style,
      }}
    >
      <div style={{ height: PAD }} aria-hidden="true" />

      {items.map((item, i) => {
        // Distance from the centre line, live. Everything visual below is
        // a function of this one number, so the wheel responds
        // continuously instead of flipping state at the end of a drag.
        const d = Math.abs(i - offset);
        const near = Math.min(d, 3);
        const scale = 1 - near * 0.13;          // 1 -> .61
        const opacity = 1 - near * 0.27;        // 1 -> .19
        const selected = Math.round(offset) === i;
        return (
          <div
            key={item}
            id={`sw-opt-${item}`}
            role="option"
            aria-selected={selected}
            style={{
              height: ITEM_H,
              scrollSnapAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 19,
              fontWeight: selected ? 700 : 500,
              color: selected ? 'var(--ink)' : 'var(--mute)',
              // transform + opacity only: both composited, neither
              // triggers layout the way the old font-size animation did.
              transform: `scale(${scale})`,
              opacity,
              transition: 'color .18s ease, font-weight .18s ease',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          >
            {fmt(item)}
          </div>
        );
      })}

      <div style={{ height: PAD }} aria-hidden="true" />

      <style>{`
        .sw-scroll::-webkit-scrollbar{display:none}
        .sw-scroll:focus-visible{box-shadow:0 0 0 2px var(--accent);border-radius:12px}
      `}</style>
    </div>
    </div>
  );
}

export { ITEM_H, VISIBLE, PAD };
