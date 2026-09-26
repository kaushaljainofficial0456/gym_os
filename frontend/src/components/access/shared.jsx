/**
 * Small pieces shared by the Access Control panels.
 *
 * Kept deliberately plain. The panels are an operational tool that an
 * owner uses when something is wrong, so every status here is a word as
 * well as a colour, and every time is absolute ("14:05") or relative with
 * the absolute one on hover -- never just "5 minutes ago" on a screen that
 * may have been open for an hour.
 */
import { useEffect, useState } from 'react';

export const TONE = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  mute: 'var(--faint)',
  info: 'var(--accent)',
};

export function Pill({ tone = 'mute', children, title }) {
  const c = TONE[tone] || tone;
  return (
    <span title={title}
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 shrink-0"
          style={{ minHeight: 26, border: `1px solid ${c}` }}>
      <span className="rounded-full" style={{ width: 6, height: 6, background: c }} aria-hidden="true" />
      <span className="text-[10px] font-grotesk font-bold uppercase tracking-[.1em]" style={{ color: c }}>
        {children}
      </span>
    </span>
  );
}

export function Label({ children, right }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>{children}</div>
      {right}
    </div>
  );
}

export function Field({ label, help, children }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block text-[10.5px] mt-1 leading-snug" style={{ color: 'var(--faint)' }}>{help}</span>}
    </label>
  );
}

export function ErrorLine({ children }) {
  if (!children) return null;
  return <div role="alert" className="text-[12px] leading-snug" style={{ color: 'var(--bad)' }}>{children}</div>;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="py-8 text-center text-[12px]" style={{ color: 'var(--faint)' }} role="status" aria-busy="true">
      {label}
    </div>
  );
}

/** "14:05" today, "18 Sep 14:05" otherwise; full timestamp on hover. */
export function When({ at, fallback = '—' }) {
  if (!at) return <span>{fallback}</span>;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return <span>{fallback}</span>;
  const today = new Date().toDateString() === d.toDateString();
  const text = today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return <time dateTime={d.toISOString()} title={d.toLocaleString()}>{text}</time>;
}

/** A toast that clears itself. Returns [node, show]. */
export function useToast(ms = 3200) {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(''), ms);
    return () => clearTimeout(t);
  }, [msg, ms]);
  const node = msg ? <div className="toast anim-toast" role="status">{msg}</div> : null;
  return [node, setMsg];
}

export const ACCESS_STATUS = {
  ALLOWED: { tone: 'good', label: 'Allowed' },
  DENIED: { tone: 'bad', label: 'Denied' },
  PENDING_SYNC: { tone: 'warn', label: 'Pending sync' },
  SYNC_FAILED: { tone: 'bad', label: 'Sync failed' },
  NOT_SUPPORTED: { tone: 'mute', label: 'Not synced' },
  MANUAL_REVIEW: { tone: 'warn', label: 'Needs review' },
};

export const JOB_STATUS = {
  PENDING: { tone: 'mute', label: 'Queued' },
  RUNNING: { tone: 'info', label: 'Running' },
  SUCCEEDED: { tone: 'good', label: 'Done' },
  FAILED: { tone: 'bad', label: 'Failed' },
  CANCELLED: { tone: 'mute', label: 'Cancelled' },
};

export const PROVIDER_STATE = {
  healthy: { tone: 'good', label: 'Healthy' },
  degraded: { tone: 'warn', label: 'Degraded' },
  disconnected: { tone: 'bad', label: 'Not working' },
  not_verified: { tone: 'warn', label: 'Not verified' },
  no_recent_events: { tone: 'warn', label: 'No recent events' },
};
