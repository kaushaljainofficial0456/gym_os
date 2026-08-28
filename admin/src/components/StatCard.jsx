import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

/** Animates from 0 to `value` once, on mount/value-change -- skipped
 *  entirely for prefers-reduced-motion (jumps straight to the final
 *  number) and for non-numeric values ("N/A", "No data yet"), which
 *  are rendered as-is, never coerced into a fake 0. */
function useCountUp(value, duration = 700) {
  const [display, setDisplay] = useState(typeof value === 'number' ? 0 : value);
  const frameRef = useRef();

  useEffect(() => {
    if (typeof value !== 'number') { setDisplay(value); return undefined; }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) { setDisplay(value); return undefined; }
    const start = performance.now();
    const from = 0;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [value, duration]);

  return display;
}

/**
 * A KPI card. `value` may be a number (animates in) or a string like
 * "N/A" / "No data yet" (rendered plainly, never faked into a number).
 * `format` optionally transforms the animating number for display
 * (e.g. money()) without affecting the animation's own math.
 */
export default function StatCard({ icon, label, value, description, format, interactive = false, onClick }) {
  const display = useCountUp(typeof value === 'number' ? value : null);
  const shown = typeof value === 'number' ? (format ? format(display) : display) : value;
  const isNA = typeof value !== 'number';

  return (
    <div className={`kpi-card stat-card ${interactive ? 'interactive' : ''}`} onClick={onClick}>
      {icon && <div className="stat-icon"><Icon name={icon} size={34} strokeWidth={1.3} /></div>}
      <div className="label">{label}</div>
      <div className={`value ${isNA ? 'na' : ''}`}>{shown}</div>
      {description && <div className="stat-desc">{description}</div>}
    </div>
  );
}
