/**
 * PORTION WHEEL — an animated vertical quantity picker for a single
 * portion ("Small bowl · 220g" → how many small bowls?). Native scroll +
 * CSS scroll-snap does the actual wheel physics (momentum, swipe, mouse
 * wheel, touch) — no drag-gesture math to hand-roll, and it's free
 * keyboard/assistive-tech support the moment the row itself is focusable,
 * unlike a from-scratch drag implementation.
 *
 * Always paired with a direct numeric fallback (below the wheel) per the
 * spec's own explicit requirement — the wheel is a fast path, never the
 * only path.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable } from '../design/index.js';

const ROW_H = 40;
// Fractional near 1 (½ bowl / 1 bowl / 1½ bowls reads naturally for most
// portions), then whole numbers further out -- a bounded, scannable list,
// not "scroll through 100 items".
const QTY_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function formatQty(n) {
  if (Number.isInteger(n)) return String(n);
  const whole = Math.floor(n);
  const frac = n - whole;
  const fracLabel = frac === 0.5 ? '½' : frac === 0.25 ? '¼' : frac === 0.75 ? '¾' : `.${Math.round(frac * 100)}`;
  return whole === 0 ? fracLabel : `${whole}${fracLabel}`;
}

function nearestIndex(v) {
  let best = 0, bestDiff = Infinity;
  QTY_OPTIONS.forEach((o, i) => { const d = Math.abs(o - v); if (d < bestDiff) { bestDiff = d; best = i; } });
  return best;
}

function unitWord(label) {
  // "Small bowl" -> "small bowl" / "small bowls" -- first two words is
  // enough for every portion label in the catalogue (see foodEstimate
  // .reference.js's VOLUME_PORTIONS/COUNT_PORTIONS labels).
  return label.replace(/\s*·.*$/, '').trim().toLowerCase();
}

export default function PortionWheel({ open, portion, initialQty = 1, onCancel, onDone }) {
  const [qty, setQty] = useState(initialQty);
  const [customText, setCustomText] = useState(String(initialQty));
  const listRef = useRef(null);
  const scrollTimer = useRef(null);
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!open) return;
    setQty(initialQty);
    setCustomText(String(initialQty));
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = nearestIndex(initialQty) * ROW_H;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, portion?.key]);

  // Self-contained Escape-to-cancel -- this is a generic, independently
  // reusable component (not FoodLogSheet-specific), so it owns its own
  // dismiss behavior rather than relying on whatever happens to host it
  // to wire that up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open || !portion) return null;

  const onScroll = () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      if (!listRef.current) return;
      const idx = Math.max(0, Math.min(QTY_OPTIONS.length - 1, Math.round(listRef.current.scrollTop / ROW_H)));
      const val = QTY_OPTIONS[idx];
      setQty(val);
      setCustomText(String(val));
      listRef.current.scrollTo({ top: idx * ROW_H, behavior: reducedMotion ? 'auto' : 'smooth' });
    }, 90);
  };

  const selectIndex = (i) => {
    if (listRef.current) listRef.current.scrollTo({ top: i * ROW_H, behavior: reducedMotion ? 'auto' : 'smooth' });
    setQty(QTY_OPTIONS[i]);
    setCustomText(String(QTY_OPTIONS[i]));
  };

  const applyCustom = () => {
    const n = Number(customText);
    if (Number.isFinite(n) && n > 0) setQty(Math.round(n * 100) / 100);
  };

  const word = unitWord(portion.label);
  const totalGrams = Math.round((portion.grams || 0) * qty * 10) / 10;

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center sm:justify-center"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={onCancel} role="dialog" aria-modal="true" aria-label={`${portion.label} quantity`}>
      <div className="card w-full sm:max-w-xs rounded-b-none sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-1 text-center">
          <div className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>{portion.label}</div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>{portion.grams}g each</div>
        </div>

        <div className="relative px-5 mt-2" style={{ height: ROW_H * 5 }}>
          <div className="absolute left-5 right-5 pointer-events-none rounded-xl" style={{ top: ROW_H * 2, height: ROW_H, background: 'var(--accent-soft)' }} />
          <div
            ref={listRef} onScroll={onScroll}
            role="listbox" aria-label={`${portion.label} quantity`} tabIndex={0}
            onKeyDown={(e) => {
              const cur = nearestIndex(qty);
              if (e.key === 'ArrowUp' && cur > 0) { e.preventDefault(); selectIndex(cur - 1); }
              if (e.key === 'ArrowDown' && cur < QTY_OPTIONS.length - 1) { e.preventDefault(); selectIndex(cur + 1); }
            }}
            className="h-full overflow-y-auto outline-none"
            style={{ scrollSnapType: 'y mandatory', paddingTop: ROW_H * 2, paddingBottom: ROW_H * 2 }}>
            {QTY_OPTIONS.map((o, i) => {
              const dist = Math.abs(o - qty);
              const isSel = o === qty;
              return (
                <div key={o} role="option" aria-selected={isSel} onClick={() => selectIndex(i)}
                     className="flex items-center justify-center cursor-pointer select-none"
                     style={{
                       height: ROW_H, scrollSnapAlign: 'center',
                       fontSize: isSel ? 19 : 14, fontWeight: isSel ? 800 : 500,
                       color: isSel ? 'var(--ink)' : 'var(--faint)',
                       opacity: isSel ? 1 : Math.max(0.35, 1 - dist * 0.3),
                       transition: reducedMotion ? 'none' : 'font-size .15s ease, opacity .15s ease',
                     }}>
                  {formatQty(o)} {word}{o !== 1 ? 's' : ''}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 pt-3 flex items-center justify-center gap-2">
          <span className="text-[9px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>Custom quantity</span>
          <input type="number" min="0.05" step="0.05" value={customText}
                 onChange={(e) => setCustomText(e.target.value)}
                 onBlur={applyCustom}
                 aria-label="Custom quantity"
                 className="w-16 text-center text-[13px] rounded-lg px-1.5 py-1 tabular-nums"
                 style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' }} />
        </div>
        <div className="px-5 pt-1.5 text-center text-[10px]" style={{ color: 'var(--mute)' }}>≈ {totalGrams}g total</div>

        <div className="px-5 pt-3 pb-5 flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold" style={{ border: '1px solid var(--line)', color: 'var(--mute)' }}>Cancel</button>
          <Pressable onClick={() => onDone(qty)} className="flex-1 btn-primary !py-2.5 text-[12px] font-bold">Done</Pressable>
        </div>
      </div>
    </div>
  );
}
