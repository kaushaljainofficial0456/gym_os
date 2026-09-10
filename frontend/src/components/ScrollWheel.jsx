/**
 * ScrollWheel — reusable vertical scroll-wheel selector.
 *
 * Touch-first, snap-to-center, with center-emphasis styling.
 * Pure React + CSS — zero new dependencies.
 */
import { useRef, useEffect, useCallback } from 'react';

const ITEM_H = 36;
const VISIBLE = 5;
const PAD = Math.floor(VISIBLE / 2) * ITEM_H; // 72px top+bottom padding

export default function ScrollWheel({ value, onChange, min, max, formatItem, style, className = '' }) {
  const ref = useRef(null);
  const lockRef = useRef(null); // debounce timer for snap-back

  // ── Snap to nearest item ──
  const snap = useCallback((el) => {
    if (!el) return;
    const raw = (el.scrollTop - PAD) / ITEM_H;
    const idx = Math.round(raw);
    const clamped = Math.max(0, Math.min(max - min, idx));
    const target = clamped * ITEM_H + PAD;
    if (Math.abs(el.scrollTop - target) > 0.5) {
      el.scrollTo({ top: target, behavior: 'smooth' });
    }
    const newVal = min + clamped;
    if (newVal !== value) onChange(newVal);
  }, [min, max, value, onChange]);

  // ── Scroll listener (debounced snap) ──
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    clearTimeout(lockRef.current);
    lockRef.current = setTimeout(() => snap(el), 80);
  }, [snap]);

  // ── Initial scroll position ──
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = (value - min) * ITEM_H + PAD;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Programmatic value changes (e.g. unit switch) ──
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = (value - min) * ITEM_H + PAD;
    if (Math.abs(el.scrollTop - target) > 1) {
      el.scrollTo({ top: target, behavior: 'smooth' });
    }
  }, [value, min]);

  // ── Prevent page scroll when wheeling inside the component ──
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e) => {
      if (e.deltaY === 0) return;
      const atTop = el.scrollTop <= 0 && e.deltaY < 0;
      const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight && e.deltaY > 0;
      if (!atTop && !atBottom) e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const count = max - min + 1;
  const items = Array.from({ length: count }, (_, i) => min + i);
  const fmt = formatItem || ((v) => String(v));

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={`overflow-y-scroll sw-scroll ${className}`}
      style={{
        height: VISIBLE * ITEM_H,
        scrollSnapType: 'y mandatory',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        ...style,
      }}
    >
      {/* top padding — creates space so first item can center */}
      <div style={{ height: PAD, scrollSnapAlign: 'none' }} />

      {items.map((item) => {
        const isSelected = item === value;
        return (
          <div
            key={item}
            style={{
              height: ITEM_H,
              scrollSnapAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: isSelected ? '22px' : '16px',
              fontWeight: isSelected ? 700 : 500,
              color: isSelected ? 'var(--ink)' : 'var(--faint)',
              opacity: isSelected ? 1 : 0.35,
              transition: 'opacity .15s, font-size .15s, font-weight .15s',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              willChange: 'opacity',
            }}
          >
            {fmt(item)}
          </div>
        );
      })}

      {/* bottom padding — creates space so last item can center */}
      <div style={{ height: PAD, scrollSnapAlign: 'none' }} />

      {/* Hide scrollbar (Webkit) */}
      <style>{`.sw-scroll::-webkit-scrollbar{display:none}`}</style>
    </div>
  );
}

export { ITEM_H, VISIBLE, PAD };
