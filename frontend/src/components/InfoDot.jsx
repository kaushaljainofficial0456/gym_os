/**
 * INFO DOT — the explanation that isn't on the screen until it's wanted.
 *
 * THE PROBLEM THIS SOLVES: this app explains itself honestly, which over
 * time meant every button grew a sentence underneath it. Individually each
 * one is useful; stacked eight-deep on a phone they are the reason a screen
 * reads as heavy. The sentence is right — its PLACEMENT was wrong. It is
 * reference material, needed once, and it was occupying permanent space.
 *
 * So: a small "i" beside the thing it describes, and the words one tap
 * away. Nothing is deleted, nothing is dumbed down; the screen simply stops
 * saying all of it at once.
 *
 * PORTALLED TO <body>, and that is not stylistic. Half the surfaces this
 * appears on animate in with `.anim-fadeUp`, whose `animation-fill-mode:
 * both` leaves a transform on the element for as long as it exists -- and a
 * transformed ancestor becomes the containing block for any `position:
 * fixed` DESCENDANT. Rendered in place, this panel would anchor to a
 * scrolled card box instead of the viewport and land off-screen. Same bug,
 * same fix, as FoodLogSheet and the Build Today modal.
 *
 * MEASURED, THEN PLACED. The panel is laid out invisibly first, its real
 * height read, and only then positioned -- above the trigger instead of
 * below when below would run off the bottom. Guessing a height is how these
 * end up half off-screen on small phones.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GUTTER = 12;   // minimum distance from any viewport edge
const GAP = 8;       // distance between trigger and panel

export default function InfoDot({
  label,                 // what this explains — used for the accessible name
  title,                 // optional heading inside the panel
  children,              // the explanation itself
  /* 32, matching the exercise info button already on the workout list --
     same bordered circle, same glyph, same accent-tinted open state. Being
     four pixels different from the identical affordance sitting next to it
     would read as a bug, and 32 clears the 24px AA target-size minimum
     comfortably. */
  size = 32,
  className = '',
  align = 'start',       // 'start' | 'center' | 'end' — horizontal anchor
  tone,                  // optional colour override for the dot
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);   // null until measured
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
    // Returning focus matters: without it a keyboard user is dropped at the
    // top of the document every time they read a tooltip.
    btnRef.current?.focus?.();
  }, []);

  /* Measure-then-place. Runs before paint, so the panel is never visible in
     the wrong spot -- `pos === null` renders it hidden and unpositioned
     purely so it can be measured at its natural size. */
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !panelRef.current) return;
    const t = btnRef.current.getBoundingClientRect();
    const p = panelRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const below = vh - t.bottom - GAP - GUTTER;
    const above = t.top - GAP - GUTTER;
    // Prefer below; flip only when below genuinely cannot hold it AND above
    // can hold more. A panel taller than both gets the roomier side and its
    // own scrollbar (maxHeight below).
    const placeAbove = p.height > below && above > below;

    let left = align === 'end' ? t.right - p.width
      : align === 'center' ? t.left + t.width / 2 - p.width / 2
      : t.left;
    left = Math.min(Math.max(GUTTER, left), Math.max(GUTTER, vw - p.width - GUTTER));

    setPos({
      left,
      top: placeAbove ? Math.max(GUTTER, t.top - GAP - p.height) : t.bottom + GAP,
      maxHeight: Math.max(120, (placeAbove ? above : below)),
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false); setPos(null);   // outside click: no focus yank
    };
    // Any scroll invalidates the anchor. Re-measuring on every scroll frame
    // would be the other option; closing is the honest one for a panel this
    // small, and it is what a tap elsewhere means anyway.
    const onScroll = () => { setOpen(false); setPos(null); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('touchstart', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('touchstart', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label ? `About ${label}` : 'More information'}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`rounded-full border grid place-items-center shrink-0 transition-all active:scale-90 ${className}`}
        style={{
          width: size,
          height: size,
          ...(open
            ? { borderColor: tone || 'var(--accent)', color: tone || 'var(--accent)', background: 'var(--accent-soft)' }
            : { borderColor: 'var(--line)', color: tone || 'var(--mute)' }),
        }}
      >
        <svg width={Math.round(size * 0.47)} height={Math.round(size * 0.47)} viewBox="0 0 24 24"
             fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
             strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
        </svg>
      </button>

      {open && createPortal((
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label ? `About ${label}` : 'More information'}
          className="fixed z-[70] rounded-xl overflow-y-auto anim-fadeIn"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: `min(300px, calc(100vw - ${GUTTER * 2}px))`,
            maxHeight: pos?.maxHeight,
            // Hidden until measured — see the layout effect above.
            visibility: pos ? 'visible' : 'hidden',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--e-3, 0 18px 40px -20px rgba(0,0,0,.55))',
            padding: '12px 14px',
          }}
        >
          {title && (
            <div className="font-grotesk font-bold text-[11px] uppercase tracking-[.14em] mb-1.5"
                 style={{ color: 'var(--ink)' }}>
              {title}
            </div>
          )}
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--mute)' }}>
            {children}
          </div>
        </div>
      ), document.body)}
    </>
  );
}
