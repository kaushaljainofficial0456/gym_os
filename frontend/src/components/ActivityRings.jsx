/**
 * ACTIVITY RINGS — three concentric progress arcs, at-a-glance.
 *
 * The Apple Health ring CONCEPT (nested arcs, one per goal, readable in
 * a glance without a single number being read) rendered in SK OS's own
 * palette. Deliberately NOT Apple's red/green/blue: this app is a warm
 * terracotta-on-near-black theme, and those neons read as a foreign
 * widget pasted onto it. Terracotta (the app's accent) carries the
 * headline Move ring, with sage and gold behind it.
 *
 * Honesty rules that shape the visuals:
 *  - a ring whose value is UNKNOWN (null) renders as a track only, never
 *    as a confident 0% -- "no step data" and "didn't move" are different
 *    things and must not look identical.
 *  - arcs clamp at 100% so a 200% day cannot lap and read as 0%, but the
 *    real number is always shown alongside, never the clamped one.
 */
import { useEffect, useState } from 'react';

const RINGS = [
  { key: 'move', label: 'Move', unit: 'kcal', color: 'var(--accent)' },
  { key: 'exercise', label: 'Exercise', unit: 'min', color: 'var(--good)' },
  { key: 'steps', label: 'Steps', unit: 'steps', color: 'var(--warn)' },
];

function Arc({ radius, stroke, pct, color, dim }) {
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * Math.min(1, Math.max(0, pct ?? 0));
  return (
    <>
      {/* track */}
      <circle
        cx="0" cy="0" r={radius} fill="none" stroke={color} strokeWidth={stroke}
        opacity={dim ? 0.1 : 0.16} strokeLinecap="round"
      />
      {pct != null && dash > 0 && (
        <circle
          cx="0" cy="0" r={radius} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{ transition: 'stroke-dasharray 900ms cubic-bezier(.22,1,.36,1)' }}
        />
      )}
    </>
  );
}

/**
 * @param {object} values  { move: {value, goal}, exercise: {...}, steps: {...} }
 *                         a null/undefined `value` means "not known".
 * @param {number} size    px, the full square the rings occupy
 * @param {boolean} showLegend
 */
export default function ActivityRings({ values, size = 200, showLegend = true, className = '' }) {
  // Animate from empty on mount so the rings visibly fill rather than
  // snapping -- the motion is what makes the glance readable.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const stroke = size * 0.085;
  const gap = stroke * 0.42;
  const outer = (size / 2) - (stroke / 2) - 1;

  return (
    <div className={className}>
      <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img"
        aria-label={RINGS.map((r) => {
          const v = values?.[r.key];
          if (!v || v.value == null) return `${r.label}: no data`;
          return `${r.label}: ${Math.round(v.value)} of ${Math.round(v.goal)} ${r.unit}`;
        }).join('. ')}>
        {/* -90deg so every arc starts at 12 o'clock */}
        <g transform="rotate(-90)">
          {RINGS.map((ring, i) => {
            const v = values?.[ring.key];
            const radius = outer - i * (stroke + gap);
            const pct = v && v.value != null && v.goal > 0 ? v.value / v.goal : null;
            return (
              <Arc key={ring.key} radius={radius} stroke={stroke}
                pct={ready ? pct : 0} color={ring.color} dim={pct == null} />
            );
          })}
        </g>
      </svg>

      {showLegend && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {RINGS.map((ring) => {
            const v = values?.[ring.key];
            const known = v && v.value != null;
            return (
              <div key={ring.key} className="text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: ring.color }} />
                  <span className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
                    {ring.label}
                  </span>
                </div>
                <div className="mt-1 text-[13px] font-bold tabular-nums" style={{ color: known ? 'var(--ink)' : 'var(--faint)' }}>
                  {known
                    ? (ring.key === 'steps' ? Math.round(v.value).toLocaleString() : Math.round(v.value))
                    : '—'}
                </div>
                <div className="text-[9.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
                  {known && v.goal ? `of ${ring.key === 'steps' ? Math.round(v.goal).toLocaleString() : Math.round(v.goal)}` : 'no data'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
