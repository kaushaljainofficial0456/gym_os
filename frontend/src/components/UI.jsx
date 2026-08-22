import { useEffect, useId } from 'react';
import { useCountUp } from '../utils.js';
import { cls } from '../utils.js';
import Icon from './Icon.jsx';

export function Card({ children, className, style, hover }) {
  return <div className={cls('card p-5', hover && 'card-hover', className)} style={style}>{children}</div>;
}

export function PageHeader({ title, sub, right, className }) {
  return (
    <div className={cls('flex items-end justify-between flex-wrap gap-3', className)}>
      <div>
        <h1 className="font-display font-bold text-2xl tracking-tight" style={{ color: 'var(--ink)' }}>{title}</h1>
        {sub && <p className="text-sm mt-0.5" style={{ color: 'var(--mute)' }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function useLight() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('light');
}

export function Avatar({ name, size = 'w-10 h-10', className, glow }) {
  const light = useLight();
  return (
    <div className={cls('rounded-full grid place-items-center font-grotesk font-bold text-sm border shrink-0', size, glow && 'shadow-glow', className)}
      style={{ background: light ? 'linear-gradient(135deg, rgba(140,106,77,.18), rgba(200,169,138,.10))' : 'linear-gradient(135deg, rgba(10,138,133,.25), rgba(20,196,188,.12))', borderColor: 'var(--line)', color: 'var(--ink)' }}
      aria-hidden="true">
      {name?.[0]?.toUpperCase() || '?'}
    </div>
  );
}

export function Skeleton({ className, lines = 1 }) {
  return (
    <div className={cls('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 && lines > 1 ? 16 : 12, width: lines === 1 ? '100%' : i === lines - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

export function Kicker({ children, tone }) {
  return <div className={cls('kicker', tone)}>{children}</div>;
}

/**
 * `icon` used to take a literal glyph ('◉', '✓', '₹', ...) passed straight
 * to <Icon name={...}>. None of those strings match a key in Icon.jsx's
 * PATHS table, so every one of the 9 call sites across the trainer pages
 * silently fell through to the same generic placeholder glyph -- nine
 * different KPIs (active clients, revenue, overdue, attendance...) all
 * showing one meaningless icon, which is worse than no icon at all: it
 * looks intentional and communicates nothing.
 *
 * Replaced with `dot`: a small colour swatch for tiles that need a
 * glance-able "this one wants action" signal (needs attention, at risk,
 * overdue), omitted for neutral tiles (active clients, on track, revenue).
 * Matches the restrained KPI-row treatment already established for the
 * trainer dashboard -- most tiles carry no colour at all, so the ones that
 * do stand out instead of competing with eight others for attention. */
export function Kpi({ label, value, suffix = '', dec = 0, tone, sub, dot }) {
  const v = useCountUp(value, 1000, dec);
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-2">
        {dot && <span className={cls('w-1.5 h-1.5 rounded-full shrink-0', dot)} />}
        <span className="text-[10.5px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--mute)' }}>{label}</span>
      </div>
      <div className={cls('font-grotesk font-bold text-2xl leading-none', tone)} style={{ color: tone ? undefined : 'var(--ink)' }}>
        {v.toLocaleString('en-US', { maximumFractionDigits: dec })}{suffix}
      </div>
      {sub && <div className="mt-1.5 text-[11px]" style={{ color: 'var(--mute)' }}>{sub}</div>}
    </div>
  );
}

export function Ring({ value, max, size = 170, stroke = 12, color, label, sub }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const C = 2 * Math.PI * ((size - stroke) / 2);
  // Unique per instance, not per size: two rings of the SAME size on one
  // screen previously collided on `ringGrad-120` and the second silently
  // inherited the first one's stops.
  const gradId = useId();
  // Was two hardcoded hex pairs behind a `useLight()` branch. Now the
  // gradient reads the accent tokens, so a palette change repaints every
  // ring in the app with no edit here — which is exactly what the peach
  // repaint needed and did not get from the old version.
  const strokeColor = color || `url(#${gradId})`;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent-deep, var(--accent))' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)' }} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={(size - stroke) / 2} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={(size - stroke) / 2} fill="none" stroke={strokeColor} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,.8,.3,1)' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="font-black text-[26px] leading-none" style={{ color: 'var(--ink)' }}>{label}</div>
        {sub && <div className="text-[10px] mt-1 font-grotesk tracking-wide" style={{ color: 'var(--mute)' }}>{sub}</div>}
      </div>
    </div>
  );
}

export function Bar({ value, max, color, label, right, height = 'h-2' }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  // Same reasoning as Ring: token-driven, so it follows the palette.
  const barColor = color || 'var(--accent-grad)';
  return (
    <div>
      {(label || right) && (
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="font-grotesk text-xs font-semibold" style={{ color: 'var(--ink)' }}>{label}</span>
          <span className="font-grotesk text-[11px]" style={{ color: 'var(--mute)' }}>{right}</span>
        </div>
      )}
      <div className={cls('rounded-full overflow-hidden', height)} style={{ background: 'var(--line)' }}>
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: barColor, transition: 'width .7s cubic-bezier(.22,.8,.3,1)' }} />
      </div>
    </div>
  );
}

export function StatusChip({ status }) {
  const meta = {
    ON_TRACK: ['ON TRACK', 'text-good border-good/40 bg-good/10'],
    NEEDS_ATTENTION: ['NEEDS ATTENTION', 'text-warn border-warn/40 bg-warn/10'],
    AT_RISK: ['AT RISK', 'text-bad border-bad/40 bg-bad/10'],
    INACTIVE: ['INACTIVE', 'text-mute border-line bg-white/5']
  }[status] || [status, 'text-mute border-line bg-white/5'];
  return <span className={cls('chip border', meta[1])}>{meta[0]}</span>;
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="flex gap-1.5 border rounded-full p-1 overflow-x-auto" style={{ background: 'rgba(128,128,128,.06)', borderColor: 'var(--line)' }}>
      {options.map((o) => (
        <button key={o.value} className={cls('tab', value === o.value && 'active')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 anim-fadeIn" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}
      style={{ background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(8px)' }}>
      <div className={cls('card w-full p-6 anim-scaleIn max-h-[90vh] overflow-auto', wide ? 'max-w-2xl' : 'max-w-md')} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-bold text-lg" style={{ color: 'var(--ink)' }}>{title}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title = 'Nothing here yet', hint, icon = 'empty', action }) {
  return (
    <div className="text-center py-12">
      <div className="w-14 h-14 mx-auto rounded-2xl border grid place-items-center text-2xl mb-3" style={{ borderColor: 'var(--line)', background: 'var(--bg2)', color: 'var(--faint)' }}><Icon name={icon} size={24} /></div>
      <div className="font-grotesk font-semibold text-sm" style={{ color: 'var(--ink)' }}>{title}</div>
      {hint && <div className="text-xs mt-1 max-w-xs mx-auto" style={{ color: 'var(--mute)' }}>{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm" style={{ color: 'var(--mute)' }} role="status">
      <span className="w-4 h-4 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--line)', borderTopColor: 'var(--accent)', animationDuration: '.7s' }} />
      {label}
    </div>
  );
}

export function Toast({ message, tone = 'success' }) {
  if (!message) return null;
  const clsMap = {
    success: 'border-good/40',
    error: 'border-bad/50',
    info: 'border-gold/40'
  };
  return (
    <div className={`fixed bottom-5 left-1/2 z-50 px-4 py-2.5 rounded-full border font-grotesk text-xs shadow-card anim-toast ${clsMap[tone] || clsMap.success}`}
      style={{ background: 'var(--panel)', color: 'var(--ink)' }}
      role="status">
      <span className={`mr-2 ${tone === 'error' ? 'text-bad' : tone === 'info' ? 'text-gold' : 'text-good'}`}>{tone === 'error' ? '✕' : '✓'}</span>
      {message}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="text-center py-10">
      <div className="text-2xl mb-2">⚠️</div>
      <div className="text-sm text-bad font-semibold font-grotesk">Something went wrong</div>
      <div className="text-xs mt-1 max-w-sm mx-auto break-words" style={{ color: 'var(--mute)' }}>{error?.message || String(error)}</div>
      {onRetry && <button className="btn mt-4" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function MacroPill({ p, c, f }) {
  return (
    <span className="flex gap-2 font-grotesk text-[10.5px]">
      <span className="text-[#FF8C42]">P {Math.round(p)}</span>
      <span className="text-gold">C {Math.round(c)}</span>
      <span className="text-cyanx">F {Math.round(f)}</span>
    </span>
  );
}
