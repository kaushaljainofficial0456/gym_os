import { useEffect } from 'react';
import { useCountUp } from '../utils.js';
import { cls } from '../utils.js';

export function Card({ children, className, style, hover }) {
  return <div className={cls('card p-5', hover && 'card-hover', className)} style={style}>{children}</div>;
}

export function PageHeader({ title, sub, right, className }) {
  return (
    <div className={cls('flex items-end justify-between flex-wrap gap-3', className)}>
      <div>
        <h1 className="font-grotesk font-bold text-2xl tracking-tight">{title}</h1>
        {sub && <p className="text-mute text-sm mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Avatar({ name, size = 'w-10 h-10', className, glow }) {
  return (
    <div className={cls('rounded-full grid place-items-center font-grotesk font-bold text-sm bg-gradient-to-br from-ember/35 to-gold/20 border border-line shrink-0', size, glow && 'shadow-glow', className)}
      aria-hidden="true">
      {name?.[0]?.toUpperCase() || '?'}
    </div>
  );
}

export function Skeleton({ className, lines = 1 }) {
  return (
    <div className={cls('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 && lines > 1 ? 18 : 14, width: lines === 1 ? '100%' : i === lines - 1 ? '62%' : '100%' }} />
      ))}
    </div>
  );
}

export function Kicker({ children, tone }) {
  return <div className={cls('kicker', tone)}>{children}</div>;
}

export function Kpi({ label, value, suffix = '', dec = 0, tone = 'text-ink', sub, icon }) {
  const v = useCountUp(value, 1000, dec);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">{label}</span>
        {icon && <span className="text-sm">{icon}</span>}
      </div>
      <div className={cls('font-grotesk font-bold text-2xl leading-none', tone)}>
        {v.toLocaleString('en-US', { maximumFractionDigits: dec })}{suffix}
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-mute">{sub}</div>}
    </div>
  );
}

export function Ring({ value, max, size = 170, stroke = 12, color = 'url(#ringGrad)', label, sub }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const C = 2 * Math.PI * ((size - stroke) / 2);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF6A3D" /><stop offset="100%" stopColor="#FFC24B" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={(size - stroke) / 2} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={(size - stroke) / 2} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,.8,.3,1)', filter: 'drop-shadow(0 0 8px rgba(255,106,61,.45))' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="font-grotesk font-bold text-[28px] leading-none">{label}</div>
        {sub && <div className="text-[10px] text-mute mt-1 font-grotesk tracking-wide">{sub}</div>}
      </div>
    </div>
  );
}

export function Bar({ value, max, color = 'linear-gradient(92deg,#FF6A3D,#FFC24B)', label, right, height = 'h-2' }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div>
      {(label || right) && (
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="font-grotesk text-xs font-semibold">{label}</span>
          <span className="font-grotesk text-[11px] text-mute">{right}</span>
        </div>
      )}
      <div className={cls('rounded-full bg-white/8 overflow-hidden', height)}>
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: color, transition: 'width .7s cubic-bezier(.22,.8,.3,1)' }} />
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
    <div className="flex gap-1.5 bg-white/5 border border-line rounded-full p-1 overflow-x-auto">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm anim-fadeIn" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className={cls('card w-full p-6 anim-scaleIn max-h-[90vh] overflow-auto', wide ? 'max-w-2xl' : 'max-w-md')} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-grotesk font-bold text-lg">{title}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title = 'Nothing here yet', hint, icon = '🫙', action }) {
  return (
    <div className="text-center py-12">
      <div className="w-14 h-14 mx-auto rounded-2xl border border-line bg-white/[.03] grid place-items-center text-2xl mb-3">{icon}</div>
      <div className="font-grotesk font-semibold text-sm">{title}</div>
      {hint && <div className="text-xs text-mute mt-1 max-w-xs mx-auto">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-mute text-sm" role="status">
      <span className="w-4 h-4 rounded-full border-2 border-white/15 border-t-ember animate-spin" style={{ animationDuration: '.7s' }} />
      {label}
    </div>
  );
}

export function Toast({ message, tone = 'success' }) {
  if (!message) return null;
  const clsMap = {
    success: 'border-good/40 text-ink',
    error: 'border-bad/50 text-ink',
    info: 'border-gold/40 text-ink'
  };
  return (
    <div className={`fixed bottom-5 left-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border font-grotesk text-xs shadow-card anim-toast ${clsMap[tone] || clsMap.success}`}
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
      <div className="text-xs text-mute mt-1 max-w-sm mx-auto break-words">{error?.message || String(error)}</div>
      {onRetry && <button className="btn mt-4" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function MacroPill({ p, c, f }) {
  return (
    <span className="flex gap-2 font-grotesk text-[10.5px]">
      <span className="text-[#FF9A7A]">P {Math.round(p)}</span>
      <span className="text-gold">C {Math.round(c)}</span>
      <span className="text-cyanx">F {Math.round(f)}</span>
    </span>
  );
}
