/**
 * LineNavList — react bits' LineSidebar proximity-hover technique,
 * adapted to render real nav items (icon + label + active state) instead
 * of the source's plain text list, and to live inside an existing 272px
 * drawer instead of a full-height marketing sidebar.
 *
 * Same rAF-driven exponential-smoothing loop as the original (color-mix
 * toward --accent and a horizontal shift both track cursor proximity,
 * eased continuously rather than via a CSS transition, so they never
 * stagger against each other) -- no new dependency, pure React + CSS.
 */
import { useRef, useCallback, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';

const FALLOFF = p => p * p * (3 - 2 * p); // smooth

export default function LineNavList({ items, onNavigate }) {
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const targetsRef = useRef([]);
  const currentRef = useRef([]);
  const rafRef = useRef(null);
  const lastRef = useRef(0);

  const runFrame = useCallback(now => {
    const dt = Math.min((now - lastRef.current) / 1000, 0.05);
    lastRef.current = now;
    const tau = 90 / 1000;
    const k = 1 - Math.exp(-dt / tau);

    let moving = false;
    const els = itemRefs.current;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el) continue;
      const target = targetsRef.current[i] || 0;
      const cur = currentRef.current[i] || 0;
      const next = cur + (target - cur) * k;
      const settled = Math.abs(target - next) < 0.0015;
      const value = settled ? target : next;
      currentRef.current[i] = value;
      el.style.setProperty('--effect', value.toFixed(4));
      if (!settled) moving = true;
    }
    rafRef.current = moving ? requestAnimationFrame(runFrame) : null;
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    lastRef.current = performance.now();
    rafRef.current = requestAnimationFrame(runFrame);
  }, [runFrame]);

  const handlePointerMove = useCallback(e => {
    const list = listRef.current;
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const pointerY = e.clientY - rect.top;
    const els = itemRefs.current;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el) continue;
      const center = el.offsetTop + el.offsetHeight / 2;
      const distance = Math.abs(pointerY - center);
      targetsRef.current[i] = FALLOFF(Math.max(0, 1 - distance / 70));
    }
    startLoop();
  }, [startLoop]);

  const handlePointerLeave = useCallback(() => {
    targetsRef.current = targetsRef.current.map(() => 0);
    startLoop();
  }, [startLoop]);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <nav
      ref={listRef}
      className="line-nav space-y-0.5 flex-1 overflow-y-auto"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {items.map((l, i) => (
        <motion.div key={l.to}
          initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.28, delay: 0.08 + i * 0.045, ease: [0.22, 0.8, 0.3, 1] }}
        >
          <NavLink to={l.to} end={l.end} onClick={onNavigate}
            ref={el => { itemRefs.current[i] = el; }}
            className="line-nav__item flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] font-semibold"
          >
            {({ isActive }) => (
              <>
                <span className="line-nav__icon shrink-0" style={isActive ? { color: 'var(--accent)' } : undefined}>{l.icon}</span>
                <span className="line-nav__label flex-1 min-w-0 truncate" style={isActive ? { color: 'var(--accent)' } : undefined}>{l.label}</span>
                <span className="line-nav__index shrink-0" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                {isActive && <span className="line-nav__marker" aria-hidden="true" />}
              </>
            )}
          </NavLink>
        </motion.div>
      ))}
    </nav>
  );
}
