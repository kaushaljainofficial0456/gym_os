/**
 * The tournament's graphics, all plain SVG and CSS so the chunk stays small.
 *
 * Every competition owns one colour pair (EVENT_COLORS in shared.jsx), and it
 * follows that competition from its icon to its bars and its ring. The base
 * colours were checked for colour-blind separation on both surfaces; the
 * brighter end of each pair is the glow. Medals are metal and carry their
 * number as well, so a place is never told by colour alone.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Crown } from './icons.jsx';
import { EVENT_COLORS, initialsOf, ordinal } from './shared.jsx';

const OTHER = ['#8D8A8C', '#B5B3B4'];

export const Medal = ({ rank }) => {
  const place = rank >= 1 && rank <= 3 ? rank : 0;
  return <span className="tr-medal" data-place={place}>{rank ?? '–'}</span>;
};

/** Stable gym -> colour pair, by name, so a gym keeps its colour on every chart. */
export const gymColors = (gyms) => {
  const names = [...gyms].map((g) => g.gym).sort();
  return Object.fromEntries(names.map((name, i) => [name, EVENT_COLORS[i] || OTHER]));
};

export function Podium({ rows, labelOf = (r) => r.display, onPick }) {
  const top = rows.filter((r) => r.rank != null).slice(0, 3);
  if (!top.length) return null;
  const order = [top[1], top[0], top[2]];
  return (
    <div className="tr-podium">
      {order.map((r, i) => {
        const place = [2, 1, 3][i];
        if (!r) return <div key={place} />;
        return (
          <button type="button" key={r.id} className="tr-podium-col" data-place={place} onClick={() => onPick?.(r)}>
            {place === 1 && <Crown size={22} className="tr-podium-crown" aria-hidden="true" />}
            <span className="tr-podium-avatar" aria-hidden="true">{initialsOf(r.name)}</span>
            <span className="tr-podium-name">{r.name}{r.is_me ? ' (you)' : ''}</span>
            <span className="tr-podium-score">{labelOf(r)}</span>
            <span className="tr-podium-block">{r.rank}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A leaderboard: every row, its place, and how far off the best it is. */
export function RankBars({ rows, lowerWins, selected, onSelect, labelOf = (r) => r.display, scoreOf = (r) => r.best }) {
  const scored = rows.filter((r) => scoreOf(r) != null);
  const values = scored.map(scoreOf);
  const best = values.length ? (lowerWins ? Math.min(...values) : Math.max(...values)) : 0;
  const share = (v) => {
    if (v == null || !best) return 0;
    return Math.max(0.03, lowerWins ? best / v : v / best);
  };
  return (
    <div className="tr-rank">
      {rows.map((r) => (
        <button type="button" key={r.id} className="tr-rank-row" data-on={selected === r.id || undefined} onClick={() => onSelect?.(r)}>
          <Medal rank={r.rank} />
          <span className="tr-grow">
            <span className="tr-rank-line">
              <span className="tr-rank-name">{r.name}{r.is_me ? ' (you)' : ''}</span>
              <span className="tr-rank-value">{labelOf(r)}</span>
            </span>
            <span className="tr-bar" data-me={r.is_me || undefined} data-place={r.rank >= 1 && r.rank <= 3 ? r.rank : undefined}>
              <i style={{ width: `${share(scoreOf(r)) * 100}%` }} />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Everyone on one line: where the field sat and where you sat in it. Dots
 * that would overlap stack upward, and a tap names the dot.
 */
export function DotStrip({ rows, average, selected, onSelect }) {
  const W = 320; const PAD = 16; const R = 7; const BASE = 58;
  const scored = useMemo(() => rows.filter((r) => r.best != null), [rows]);
  const placed = useMemo(() => {
    if (!scored.length) return null;
    const values = scored.map((r) => r.best);
    const min = Math.min(...values); const max = Math.max(...values);
    const span = max - min || 1;
    const x = (v) => (max === min ? W / 2 : PAD + ((v - min) / span) * (W - PAD * 2));
    const out = [];
    [...scored].sort((a, b) => a.best - b.best).forEach((r) => {
      const cx = x(r.best);
      let level = 0;
      while (out.some((d) => d.level === level && Math.abs(d.cx - cx) < R * 2 + 2)) level += 1;
      out.push({ r, cx, level });
    });
    return { dots: out, x, min, max };
  }, [scored]);
  if (!placed) return null;
  const { dots, x, min, max } = placed;
  const rise = Math.max(...dots.map((d) => d.level));
  const H = BASE + rise * (R * 2 + 2) + 24;
  const baseY = H - 24;
  const on = dots.find((d) => d.r.id === selected)?.r || dots.find((d) => d.r.is_me)?.r;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Every score on one line">
        <line x1={PAD} x2={W - PAD} y1={baseY} y2={baseY} stroke="rgb(var(--tint-rgb) / .14)" strokeWidth="2" strokeLinecap="round" />
        {average != null && max !== min && (
          <g>
            <line x1={x(average)} x2={x(average)} y1={baseY - 8} y2={baseY + 6} stroke="var(--mute)" strokeWidth="1.5" />
            <text x={x(average)} y={baseY + 18} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--mute)">average</text>
          </g>
        )}
        {dots.map(({ r, cx, level }) => {
          const active = on?.id === r.id;
          const cy = baseY - 11 - level * (R * 2 + 2);
          return (
            <g key={r.id} role="button" tabIndex={0} aria-label={`${r.name}: ${r.display}`} style={{ cursor: 'pointer', outline: 'none' }}
              onClick={() => onSelect?.(r)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(r); }}>
              <circle cx={cx} cy={cy} r={15} fill="transparent" />
              <circle cx={cx} cy={cy} r={active ? R + 2 : R} fill={active || r.is_me ? 'var(--e-a)' : 'rgb(var(--tint-rgb) / .38)'} stroke="var(--panel)" strokeWidth="2" />
            </g>
          );
        })}
      </svg>
      {on && <div className="tr-muted" style={{ textAlign: 'center' }}><b style={{ color: 'var(--ink)' }}>{on.name}</b> · {on.display}{on.rank ? ` · ${ordinal(on.rank)}` : ''}</div>}
    </div>
  );
}

/** Percentile per competition, each point in its competition's colour. */
export function Radar({ axes }) {
  const uid = useId();
  const [active, setActive] = useState(null);
  const n = axes.length;
  if (n < 3) return null;
  const S = 320; const C = S / 2; const R = 88;
  const at = (i, v) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const r = (R * v) / 100;
    return [C + Math.cos(a) * r, C + Math.sin(a) * r];
  };
  const shape = axes.map((p, i) => at(i, p.value).join(',')).join(' ');
  const shown = active != null ? axes[active] : null;
  return (
    <div>
      <svg viewBox={`0 0 ${S} ${S}`} width="100%" style={{ maxWidth: 320, display: 'block', margin: '0 auto' }} role="img"
        aria-label={axes.map((a) => `${a.name}: beat ${a.value}%`).join(', ')}>
        <defs>
          <linearGradient id={`${uid}-r`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--t-a))" /><stop offset="1" stopColor="rgb(var(--t-b))" />
          </linearGradient>
        </defs>
        {[25, 50, 75, 100].map((g) => (
          <polygon key={g} points={axes.map((_, i) => at(i, g).join(',')).join(' ')} fill="none" stroke="rgb(var(--tint-rgb) / .1)" />
        ))}
        {axes.map((_, i) => { const [x, y] = at(i, 100); return <line key={i} x1={C} y1={C} x2={x} y2={y} stroke="rgb(var(--tint-rgb) / .1)" />; })}
        <polygon points={shape} fill={`url(#${uid}-r)`} fillOpacity=".3" stroke={`url(#${uid}-r)`} strokeWidth="2.5" strokeLinejoin="round" />
        {axes.map((p, i) => {
          const [x, y] = at(i, p.value);
          const [lx, ly] = at(i, 116);
          return (
            <g key={p.name} role="button" tabIndex={0} aria-label={`${p.name}: beat ${p.value}%`} style={{ cursor: 'pointer', outline: 'none' }}
              onClick={() => setActive(i)} onKeyDown={(e) => { if (e.key === 'Enter') setActive(i); }}>
              <circle cx={x} cy={y} r="17" fill="transparent" />
              <circle cx={x} cy={y} r={active === i ? 8 : 6} fill={(EVENT_COLORS[i] || OTHER)[0]} stroke="var(--panel)" strokeWidth="2" />
              <text x={lx} y={ly + 3} textAnchor={Math.abs(lx - C) < 12 ? 'middle' : lx > C ? 'start' : 'end'} fontSize="11" fontWeight="700" fill="var(--mute)">
                {p.name.length > 11 ? `${p.name.slice(0, 10)}…` : p.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="tr-muted" style={{ textAlign: 'center', minHeight: 20 }}>
        {shown ? <><b style={{ color: 'var(--ink)' }}>{shown.name}</b>: beat {shown.value}% of the field</> : 'Tap a point'}
      </div>
    </div>
  );
}

/** Gym against gym: a rope split by points. The legend carries the numbers. */
export function GymWar({ gyms }) {
  const colors = gymColors(gyms);
  const total = gyms.reduce((a, g) => a + g.points, 0) || 1;
  return (
    <div className="tr-section">
      <div className="tr-war" role="img" aria-label={gyms.map((g) => `${g.gym} ${g.points} points`).join(', ')}>
        {gyms.map((g) => <i key={g.gym} style={{ flexGrow: Math.max(g.points, total * 0.02), background: `linear-gradient(90deg, ${colors[g.gym][0]}, ${colors[g.gym][1]})` }} />)}
      </div>
      <div className="tr-legend">
        {gyms.map((g) => (
          <div key={g.gym} className="tr-legend-row">
            <span className="tr-legend-swatch" style={{ background: colors[g.gym][0] }} />
            <span className="tr-grow tr-ellipsis" style={{ fontWeight: 700 }}>{g.gym}</span>
            <span className="tr-medal-counts">
              <span><i data-place="1" />{g.gold}</span><span><i data-place="2" />{g.silver}</span><span><i data-place="3" />{g.bronze}</span>
            </span>
            <b className="tr-num">{g.points}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function Arc({ id, cx, r, width, a, b, value }) {
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(value, 1.5) / 100);
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} /></linearGradient>
      </defs>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={a} strokeOpacity=".16" strokeWidth={width} />
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={width} strokeLinecap="round" strokeDasharray={c}
        className="tr-ring-arc" style={{ '--tr-full': c, strokeDashoffset: offset }} />
    </>
  );
}

/** One ring in one competition's colours, with whatever belongs in the middle. */
export function GradientRing({ value, a = 'rgb(var(--t-a))', b = 'rgb(var(--t-b))', size = 76, stroke = 10, children }) {
  const uid = useId();
  return (
    <span className="tr-ring-solo" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <Arc id={uid} cx={size / 2} r={(size - stroke) / 2} width={stroke} a={a} b={b} value={value ?? 0} />
        </g>
      </svg>
      <div>{children}</div>
    </span>
  );
}

/**
 * One ring per competition, closed by how much of the field you beat. Past
 * six the rest stay in the list below the rings rather than gaining a colour.
 */
export function CompetitionRings({ items, colorOf = (i) => EVENT_COLORS[i] || OTHER }) {
  const uid = useId();
  const [active, setActive] = useState(null);
  const shown = items.slice(0, EVENT_COLORS.length);
  const S = 212; const W = shown.length > 4 ? 12 : 14; const GAP = 4;
  const average = items.length ? Math.round(items.reduce((a, i) => a + i.value, 0) / items.length) : 0;
  const focus = active != null ? items[active] : null;
  return (
    <div className="tr-rings">
      <div className="tr-rings-chart" style={{ width: S, height: S }}>
        <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={shown.map((i) => `${i.name}: beat ${i.value}%`).join(', ')}>
          {shown.map((item, i) => (
            <g key={item.name} className="tr-ring-group" transform={`rotate(-90 ${S / 2} ${S / 2})`} opacity={active != null && active !== i ? 0.22 : 1}>
              <Arc id={`${uid}-${i}`} cx={S / 2} r={S / 2 - W / 2 - i * (W + GAP)} width={W} a={colorOf(i)[0]} b={colorOf(i)[1]} value={item.value} />
            </g>
          ))}
        </svg>
        {shown.length <= 4 && (
          <div className="tr-rings-center">
            <b>{focus ? focus.value : average}%</b>
            <span className="tr-ellipsis" style={{ maxWidth: '100%' }}>{focus ? focus.name : 'beaten'}</span>
          </div>
        )}
      </div>
      <div className="tr-legend">
        {items.map((item, i) => (
          <button type="button" key={item.name} className="tr-legend-row" data-dim={active != null && active !== i} onClick={() => setActive(active === i ? null : i)}>
            <span className="tr-legend-swatch" style={{ background: `linear-gradient(135deg, ${colorOf(i)[0]}, ${colorOf(i)[1]})` }} />
            <span className="tr-grow tr-ellipsis" style={{ textAlign: 'left', fontWeight: 600 }}>{item.name}</span>
            <b className="tr-num">{item.value}%</b>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One short burst for a podium finish. */
export function Confetti({ run }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!run || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return undefined;
    const w = (canvas.width = window.innerWidth);
    const h = (canvas.height = window.innerHeight);
    const colors = ['#FFC53D', ...EVENT_COLORS.map((c) => c[1]), '#FFFFFF'];
    const bits = Array.from({ length: 130 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.4, y: h * 0.3, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 11 - 3,
      s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const started = performance.now();
    let raf;
    const frame = (t) => {
      const age = t - started;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = Math.max(0, 1 - age / 2800);
      for (const b of bits) {
        b.x += b.vx; b.y += b.vy; b.vy += 0.24; b.vx *= 0.99; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore();
      }
      if (age < 2800) raf = requestAnimationFrame(frame); else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [run]);
  return <canvas ref={ref} aria-hidden="true" style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 80 }} />;
}
