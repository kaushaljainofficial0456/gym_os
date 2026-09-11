/**
 * RING — a progress arc.
 *
 * Used wherever a value has a genuine CEILING (percent of a goal, days hit
 * out of days available). Deliberately NOT used for open-ended numbers:
 * a ring around "443 sets" implies a target that doesn't exist, which is
 * the most common way this shape gets misused.
 *
 * Draws with stroke-dasharray on a circle rather than an arc path, so the
 * geometry stays correct at any size and the sweep can be animated with a
 * single transition.
 */
import { useEffect, useState } from 'react';

export default function Ring({
  value = 0,              // 0..1
  size = 44,
  stroke = 4,
  color = 'var(--accent)',
  track = 'var(--line)',
  children,
  label,
  animate = true,
}) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  const [shown, setShown] = useState(animate ? 0 : clamped);

  useEffect(() => {
    if (!animate) { setShown(clamped); return undefined; }
    // Respect the user's motion preference — the ring still reaches the
    // right value, it just arrives there immediately.
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setShown(clamped); return undefined; }
    const t = requestAnimationFrame(() => setShown(clamped));
    return () => cancelAnimationFrame(t);
  }, [clamped, animate]);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden={!label} role={label ? 'img' : undefined} aria-label={label}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - shown)}
          // -90deg so the arc starts at 12 o'clock, which is where people
          // read a dial from.
          style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%', transition: 'stroke-dashoffset .8s cubic-bezier(.22,.61,.36,1)' }}
        />
      </svg>
      {children != null && (
        <span className="absolute inset-0 flex items-center justify-center">{children}</span>
      )}
    </div>
  );
}
