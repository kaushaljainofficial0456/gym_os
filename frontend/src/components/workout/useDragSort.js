/**
 * Reorder a vertical list by dragging a handle.
 *
 * Pointer events, so one code path serves a thumb, a mouse and a pen. The
 * handle carries `touch-action: none` (see .wk-grip) -- without it a phone
 * reads the drag as a page scroll and the card never moves. The arrow keys
 * on the handle do the same job without a pointer.
 *
 * The list is measured once when a drag starts. While it runs, the dragged
 * item follows the finger and the items it passes slide out of its way with
 * transforms only -- nothing re-lays out until the finger lifts, so the
 * order changes exactly once, on drop. Near the top or bottom edge of
 * whatever scrolls the list (the page in a session, the sheet body in the
 * builder) it scrolls, so a long session can be reordered end to end.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

function scrollerOf(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement || document.documentElement;
}

const isDoc = (el) => el === document.scrollingElement || el === document.documentElement || el === document.body;

export function moveItem(list, from, to) {
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/**
 * @param ids      current order (stable keys)
 * @param onMove   (from, to) => void -- commit a move
 * @param nameOf   id => text, for what a screen reader is told
 * @param edges    { top, bottom } px of the scroller's visible box that
 *                 sticky or fixed chrome covers (auto-scroll starts past it)
 */
export function useDragSort({ ids, onMove, nameOf = () => 'Item', edges = { top: 0, bottom: 0 } }) {
  const items = useRef(new Map());
  const handles = useRef(new Map());
  const st = useRef(null);
  const refocus = useRef(null);
  const [drag, setDrag] = useState(null);       // { id, from, to, dy }
  const [said, setSaid] = useState('');

  const itemRef = useCallback((id) => (el) => {
    if (el) items.current.set(id, el); else items.current.delete(id);
  }, []);

  // A keyboard move can re-insert the focused handle's card, which drops
  // focus; put it back on the same handle.
  useEffect(() => {
    if (!refocus.current) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [ids]);

  const scrollTop = (sc) => (isDoc(sc) ? window.scrollY : sc.scrollTop);

  const update = () => {
    const s = st.current;
    if (!s) return;
    const dy = (s.y - s.y0) + (scrollTop(s.sc) - s.top0);
    const r = s.rects[s.from];
    const centre = r.top + r.height / 2 + dy;
    let to = 0;
    s.rects.forEach((q, i) => { if (i !== s.from && q.top + q.height / 2 < centre) to += 1; });
    s.to = to;
    setDrag({ id: s.id, from: s.from, to, dy });
  };

  const tick = () => {
    const s = st.current;
    if (!s) return;
    const box = isDoc(s.sc) ? { top: 0, bottom: window.innerHeight } : s.sc.getBoundingClientRect();
    const top = box.top + (edges.top || 0) + 48;
    const bottom = box.bottom - (edges.bottom || 0) - 48;
    let v = 0;
    if (s.y < top) v = -Math.min(18, (top - s.y) / 3);
    else if (s.y > bottom) v = Math.min(18, (s.y - bottom) / 3);
    if (v) {
      if (isDoc(s.sc)) window.scrollBy(0, v); else s.sc.scrollTop += v;
      update();
    }
    s.raf = requestAnimationFrame(tick);
  };

  const finish = (commit) => {
    const s = st.current;
    if (!s) return;
    st.current = null;
    cancelAnimationFrame(s.raf);
    document.documentElement.classList.remove('wk-dragging');
    setDrag(null);
    if (commit && s.to !== s.from) {
      onMove(s.from, s.to);
      setSaid(`${nameOf(s.id)} moved to position ${s.to + 1} of ${ids.length}`);
    }
  };

  const handleProps = (id) => {
    const index = ids.indexOf(id);
    return {
      ref: (el) => { if (el) handles.current.set(id, el); else handles.current.delete(id); },
      onPointerDown: (e) => {
        if (e.button > 0 || ids.length < 2) return;
        const rects = ids.map((k) => items.current.get(k)?.getBoundingClientRect());
        if (rects.some((r) => !r)) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
        const sc = scrollerOf(items.current.get(id));
        st.current = { id, from: index, to: index, y0: e.clientY, y: e.clientY, sc, top0: scrollTop(sc), rects, raf: 0 };
        document.documentElement.classList.add('wk-dragging');
        try { navigator.vibrate?.(8); } catch { /* not supported */ }
        setDrag({ id, from: index, to: index, dy: 0 });
        st.current.raf = requestAnimationFrame(tick);
      },
      onPointerMove: (e) => {
        if (!st.current) return;
        st.current.y = e.clientY;
        update();
      },
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => finish(true),
      onKeyDown: (e) => {
        const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : null;
        if (to == null) return;
        e.preventDefault();
        if (to < 0 || to >= ids.length) return;
        refocus.current = id;
        onMove(index, to);
        setSaid(`${nameOf(id)} moved to position ${to + 1} of ${ids.length}`);
      },
    };
  };

  /** The transform for an item while a drag is running. */
  const styleFor = (id) => {
    const s = st.current;
    if (!drag || !s) return undefined;
    const i = ids.indexOf(id);
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, position: 'relative', zIndex: 15 };
    const { from, to } = drag;
    const r = s.rects;
    if (from < to && i > from && i <= to) return { transform: `translateY(${-(r[from + 1].top - r[from].top)}px)` };
    if (to < from && i >= to && i < from) return { transform: `translateY(${r[from].bottom - r[from - 1].bottom}px)` };
    return { transform: 'translateY(0)' };
  };

  return { drag, itemRef, handleProps, styleFor, announcement: said };
}
