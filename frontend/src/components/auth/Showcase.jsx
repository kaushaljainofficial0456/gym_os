/**
 * SHOWCASE — the product, floating on the stage.
 *
 * A sign-in screen's job is to make someone want what is behind it. So
 * instead of describing the app, the stage shows it: glass cards in the
 * app's own vocabulary -- a personal record, a fuel ring, the live gym
 * crowd, a streak, a member count -- drifting in depth around the mark,
 * leaning with the pointer or the phone, their numbers counting up as
 * they arrive.
 *
 * Each audience sees its own: members see their training, owners their
 * gym, coaches their clients. These are illustrations of the product,
 * decorative to assistive tech, never claims about anyone's real data.
 */
import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.js';
import './showcase.css';

const SETS = {
  welcome: [
    { kind: 'metric', label: 'New PR', title: 'Bench press', value: 92.5, decimals: 1, unit: 'kg', delta: '+5 kg' },
    { kind: 'ring', label: 'Fuel today', value: 1840, unit: 'kcal', of: '2,200', pct: 0.84 },
    { kind: 'bars', label: 'Gym now', value: 'Quiet', sub: '14% full', live: true },
    { kind: 'metric', label: 'Active members', title: 'Ironforge Fitness', value: 248, unit: '', delta: '+12 this month' },
  ],
  member: [
    { kind: 'metric', label: 'New PR', title: 'Deadlift', value: 140, unit: 'kg', delta: '+7.5 kg' },
    { kind: 'ring', label: 'Fuel today', value: 1840, unit: 'kcal', of: '2,200', pct: 0.84 },
    { kind: 'dots', label: 'Streak', value: 12, unit: 'days', filled: 6, total: 7 },
    { kind: 'spark', label: 'Body weight', value: 74.2, decimals: 1, unit: 'kg', delta: '−1.8 kg', points: [78, 77.6, 77.8, 76.9, 76.4, 76.6, 75.7, 75.1, 74.8, 74.2] },
  ],
  owner: [
    { kind: 'metric', label: 'Active members', title: 'This month', value: 248, unit: '', delta: '+12' },
    { kind: 'ring', label: 'Renewals', value: 31, unit: 'of 36', of: null, pct: 0.86 },
    { kind: 'bars', label: 'Gym now', value: 'Busy', sub: '68% full', live: true, hot: true },
    { kind: 'spark', label: 'Revenue', prefix: '₹', value: 4.2, decimals: 1, unit: 'L', delta: '+9%', points: [2.9, 3.1, 3.0, 3.4, 3.3, 3.6, 3.8, 3.7, 4.0, 4.2] },
  ],
  coach: [
    { kind: 'metric', label: 'Clients', title: 'On plan this week', value: 18, unit: '', delta: '3 to check in' },
    { kind: 'ring', label: 'Adherence', value: 92, unit: '%', of: null, pct: 0.92 },
    { kind: 'dots', label: 'Sessions today', value: 6, unit: 'booked', filled: 4, total: 6 },
    { kind: 'bars', label: 'Gym now', value: 'Quiet', sub: '22% full', live: true },
  ],
};

const CROWD = [0.12, 0.3, 0.72, 0.9, 0.62, 0.34, 0.26, 0.3, 0.44, 0.78, 0.96, 0.7];

function useCountUp(target, { delay = 0, duration = 1400, decimals = 0 } = {}) {
  const reduced = usePrefersReducedMotion();
  const [v, setV] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced || typeof target !== 'number') { setV(target); return undefined; }
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const e = 1 - (1 - p) ** 4;
      setV(target * e);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delay, duration, reduced]);
  if (typeof target !== 'number') return target;
  return v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function Card({ c, i }) {
  const delay = 1100 + i * 160;
  const value = useCountUp(c.value, { delay: delay + 200, decimals: c.decimals || 0 });
  return (
    <div className={`sc sc-${i + 1}`}>
      <div className="sc-float">
        <div className="sc-glass" style={{ animationDelay: `${delay}ms` }}>
          <div className="sc-label">
            {c.live && <span className="sc-live" />}
            {c.label}
          </div>

          {c.kind === 'ring' ? (
            <div className="sc-row">
              <svg className="sc-ring" viewBox="0 0 44 44" aria-hidden="true">
                <circle cx="22" cy="22" r="18" className="sc-ring__track" />
                <circle cx="22" cy="22" r="18" className="sc-ring__fill" pathLength="1"
                  style={{ '--pct': c.pct, animationDelay: `${delay + 250}ms` }} transform="rotate(-90 22 22)" />
              </svg>
              <div>
                <div className="sc-value">{value}<span className="sc-unit">{c.unit}</span></div>
                {c.of && <div className="sc-sub">of {c.of}</div>}
              </div>
            </div>
          ) : (
            <>
              {c.title && <div className="sc-title">{c.title}</div>}
              <div className="sc-value">{c.prefix}{value}{c.unit && <span className="sc-unit">{c.unit}</span>}</div>
              {c.sub && <div className="sc-sub">{c.sub}</div>}
            </>
          )}

          {c.kind === 'bars' && (
            <div className={`sc-bars${c.hot ? ' is-hot' : ''}`} aria-hidden="true">
              {CROWD.map((h, k) => (
                <span key={k} className={k === 10 ? 'is-now' : undefined}
                  style={{ '--h': h, animationDelay: `${delay + 250 + k * 40}ms` }} />
              ))}
            </div>
          )}
          {c.kind === 'dots' && (
            <div className="sc-dots" aria-hidden="true">
              {Array.from({ length: c.total }, (_, k) => (
                <span key={k} className={k < c.filled ? 'is-on' : k === c.filled ? 'is-next' : undefined}
                  style={{ animationDelay: `${delay + 250 + k * 70}ms` }} />
              ))}
            </div>
          )}
          {c.kind === 'spark' && (
            <svg className="sc-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" style={{ animationDelay: `${delay + 250}ms` }}>
              <polyline
                points={c.points.map((p, k) => {
                  const lo = Math.min(...c.points), hi = Math.max(...c.points);
                  return `${(k / (c.points.length - 1)) * 100},${26 - ((p - lo) / (hi - lo || 1)) * 22}`;
                }).join(' ')} />
            </svg>
          )}
          {c.delta && <div className="sc-delta">{c.delta}</div>}
        </div>
      </div>
    </div>
  );
}

export default function Showcase({ set = 'welcome' }) {
  const cards = SETS[set] || SETS.welcome;
  return (
    <div className="auth-showcase" aria-hidden="true" key={set}>
      {cards.map((c, i) => <Card key={`${set}${i}`} c={c} i={i} />)}
    </div>
  );
}
