import { useEffect, useId, useState } from 'react';
import { useCountUp } from '../utils.js';
import { cls } from '../utils.js';
import Icon from './Icon.jsx';

/**
 * SHARED UI PRIMITIVES
 *
 * Every export here keeps its original prop signature — these are consumed
 * by ~40 pages and a rename would be a refactor, not a redesign. What
 * changed in the design pass is what they RENDER: sizes now come from the
 * type scale in theme.css, colour from tokens, and states (loading,
 * disabled, error, empty) from the shared component classes rather than
 * per-component one-offs. New capability is added as OPTIONAL props so
 * existing call sites are untouched.
 */

export function Card({ children, className, style, hover }) {
  return <div className={cls('card p-5', hover && 'card-hover', className)} style={style}>{children}</div>;
}

/**
 * `eyebrow` / `onBack` are optional additions: a page that sits one level
 * down in a stack (Part 9's navigation rule) can now show where it came
 * from without every page hand-rolling its own back affordance.
 */
export function PageHeader({ title, sub, right, className, eyebrow, onBack }) {
  return (
    <div className={cls('flex items-end justify-between flex-wrap gap-3', className)}>
      <div className="min-w-0">
        {onBack && (
          <button onClick={onBack} className="btn-ghost -ml-2 mb-1" aria-label="Back">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            Back
          </button>
        )}
        {eyebrow && <div className="t-micro mb-1.5" style={{ color: 'var(--accent)' }}>{eyebrow}</div>}
        <h1 className="t-title">{title}</h1>
        {sub && <p className="t-sub mt-1">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

/**
 * `size` accepts either Tailwind classes ('w-10 h-10', the original
 * signature every existing caller passes) or a number of pixels, because
 * chrome avatars need sizes that aren't on Tailwind's 4px scale (30px in
 * the header) and `w-[30px]` in a dozen call sites is worse than one
 * branch here.
 *
 * `src` renders an uploaded profile photo. ClientLayout was hand-rolling
 * its own avatar markup purely because this component couldn't show one,
 * which is how the header ended up with a stale gradient of its own.
 */
export function Avatar({ name, src, size = 'w-10 h-10', className, glow }) {
  const numeric = typeof size === 'number';
  const initial = name?.[0]?.toUpperCase() || '?';
  return (
    <div className={cls('rounded-full grid place-items-center font-grotesk font-bold border shrink-0 overflow-hidden',
      !numeric && size, glow && 'shadow-glow', className)}
      /* Was a hardcoded TEAL gradient in dark mode (rgba(10,138,133,…)) —
         a leftover from a palette two repaints ago, so every avatar in the
         dark app was rendering in a colour the design system no longer
         contains. Token-driven now, so it follows the accent like
         everything else. */
      style={{
        background: src ? 'none' : 'linear-gradient(135deg, rgb(var(--accent-rgb) / .28), rgb(var(--accent-deep-rgb) / .12))',
        borderColor: 'rgb(var(--accent-rgb) / .22)',
        color: 'var(--ink)',
        ...(numeric ? { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) } : { fontSize: '.875rem' }),
      }}
      aria-hidden="true">
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : initial}
    </div>
  );
}

/** Heights match the type scale, so a skeleton occupies exactly the space
 *  its resolved content will (no layout shift when data lands). */
export function Skeleton({ className, lines = 1 }) {
  return (
    <div className={cls('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i}
          className={i === 0 && lines > 1 ? 'skeleton-title' : 'skeleton-text'}
          style={{ width: lines === 1 ? '100%' : i === lines - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

export function Kicker({ children, tone }) {
  return <div className={cls('kicker', tone)}>{children}</div>;
}

/**
 * `dot` is a small colour swatch for tiles that need a glance-able "this
 * one wants action" signal; omitted for neutral tiles so the ones that do
 * carry colour actually stand out.
 *
 * `trend` (optional, new) renders a signed delta next to the value —
 * direction is carried by an arrow glyph as well as colour, so it survives
 * greyscale (Part 33).
 */
export function Kpi({ label, value, suffix = '', dec = 0, tone, sub, dot, trend }) {
  const v = useCountUp(value, 1000, dec);
  const up = typeof trend === 'number' && trend > 0;
  const down = typeof trend === 'number' && trend < 0;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-2">
        {dot && <span className={cls('w-1.5 h-1.5 rounded-full shrink-0', dot)} />}
        <span className="stat-label">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <div className={cls('font-grotesk tabular-nums leading-none', tone)}
          style={{ fontSize: '1.625rem', fontWeight: 800, letterSpacing: '-.03em', color: tone ? undefined : 'var(--ink)' }}>
          {v.toLocaleString('en-US', { maximumFractionDigits: dec })}{suffix}
        </div>
        {(up || down) && (
          <span className="font-grotesk tabular-nums shrink-0" style={{ fontSize: '.75rem', fontWeight: 650, color: up ? 'rgb(var(--good-rgb))' : 'rgb(var(--bad-rgb))' }}>
            {up ? '↑' : '↓'} {Math.abs(trend)}%
          </span>
        )}
      </div>
      {sub && <div className="t-sub mt-1.5" style={{ fontSize: '.75rem' }}>{sub}</div>}
    </div>
  );
}

export function Ring({ value, max, size = 170, stroke = 12, color, label, sub }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const C = 2 * Math.PI * ((size - stroke) / 2);
  const gradId = useId();
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
          style={{ transition: 'stroke-dashoffset .8s var(--ease-out)' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="font-grotesk tabular-nums leading-none" style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-.03em', color: 'var(--ink)' }}>{label}</div>
        {sub && <div className="t-micro mt-1.5">{sub}</div>}
      </div>
    </div>
  );
}

export function Bar({ value, max, color, label, right, height = 'h-2' }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const barColor = color || 'var(--accent-grad)';
  return (
    <div>
      {(label || right) && (
        <div className="flex justify-between items-baseline mb-1.5">
          <span className="font-grotesk" style={{ fontSize: '.8125rem', fontWeight: 600, color: 'var(--ink)' }}>{label}</span>
          <span className="font-grotesk tabular-nums" style={{ fontSize: '.75rem', color: 'var(--mute)' }}>{right}</span>
        </div>
      )}
      <div className={cls('rounded-full overflow-hidden', height)} style={{ background: 'var(--line)' }}>
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: barColor, transition: 'width .7s var(--ease-out)' }} />
      </div>
    </div>
  );
}

/** Status carries a dot AND a label (never colour alone) — see `.badge`. */
export function StatusChip({ status }) {
  const meta = {
    ON_TRACK: ['On track', 'badge-good'],
    NEEDS_ATTENTION: ['Needs attention', 'badge-warn'],
    AT_RISK: ['At risk', 'badge-bad'],
    INACTIVE: ['Inactive', ''],
  }[status] || [String(status || '').replace(/_/g, ' ').toLowerCase(), ''];
  return <span className={cls('badge', meta[1])} style={{ textTransform: 'capitalize' }}>{meta[0]}</span>;
}

/** A true segmented control (track + thumb), not free-floating pills —
 *  these are alternative views of one thing, not separate destinations. */
export function Seg({ options, value, onChange }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value}
          className="segmented-item" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Modal / sheet. On phones this presents as a bottom sheet (thumb-reachable,
 * with a grab handle); from `sm` up it centres as a dialog. `onBack` adds a
 * one-level-back affordance distinct from close — Part 18's rule that a
 * nested flow must never conflate ← with ✕.
 */
export function Modal({ open, onClose, title, children, wide, sub, footer, onBack }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim z-50 flex items-end sm:items-center sm:justify-center sm:p-4 anim-fadeIn"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className={cls('sheet w-full flex flex-col anim-scaleIn max-h-[92vh] sm:max-h-[90vh]', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}
        onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle sm:hidden" />
        <div className="sheet-header">
          {onBack && (
            <button onClick={onBack} aria-label="Back" className="btn-icon btn-ghost shrink-0 -ml-2">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="t-card truncate">{title}</h3>
            {sub && <p className="t-sub truncate" style={{ fontSize: '.75rem' }}>{sub}</p>}
          </div>
          <button className="btn-icon btn-ghost shrink-0 -mr-2" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--line)' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Icon, title, one sentence, one action (Part 20) — never bare space. */
export function Empty({ title = 'Nothing here yet', hint, icon = 'empty', action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon"><Icon name={icon} size={24} /></div>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-body">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12" role="status" aria-live="polite">
      <span className="w-5 h-5 rounded-full border-2" style={{ borderColor: 'var(--line)', borderTopColor: 'var(--accent)', animation: 'so-spin .7s linear infinite' }} />
      <span className="t-sub" style={{ fontSize: '.8125rem' }}>{label}</span>
    </div>
  );
}

export function Toast({ message, tone = 'success' }) {
  if (!message) return null;
  const meta = {
    success: ['rgb(var(--good-rgb))', 'M20 6 9 17l-5-5'],
    error: ['rgb(var(--bad-rgb))', 'M18 6 6 18M6 6l12 12'],
    info: ['var(--accent)', 'M12 16v-4M12 8h.01'],
  }[tone] || ['rgb(var(--good-rgb))', 'M20 6 9 17l-5-5'];
  return (
    <div className="fixed bottom-5 left-1/2 z-[90] flex items-center gap-2.5 anim-toast"
      style={{
        transform: 'translateX(-50%)',
        padding: '10px 16px', borderRadius: 'var(--r-pill)',
        background: 'var(--panel)', color: 'var(--ink)',
        border: '1px solid var(--line)', boxShadow: 'var(--e-3)',
      }}
      role="status" aria-live="polite">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={meta[0]} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <path d={meta[1]} />
      </svg>
      <span className="font-grotesk" style={{ fontSize: '.8125rem', fontWeight: 550 }}>{message}</span>
    </div>
  );
}

/**
 * Part 22: users get a human sentence and a way forward. The raw message
 * is still reachable — collapsed, for someone reporting a bug — but it is
 * no longer the headline, because "Validation failed: issues[0]" is not a
 * thing a person can act on.
 */
function humanizeError(error) {
  const raw = (error?.message || String(error || '')).trim();
  if (!raw) return null;
  // A short, prose-y message from our own API is genuinely useful — show it.
  const looksHuman = raw.length < 120 && /[a-z]/.test(raw) && !/^\w*Error\b|\b5\d\d\b|stack|undefined|\[object/i.test(raw);
  return looksHuman ? raw : null;
}

export function ErrorState({ error, onRetry }) {
  const human = humanizeError(error);
  const raw = error?.message || String(error || '');
  return (
    <div className="empty-state" role="alert">
      <div className="empty-state-icon" style={{ background: 'rgb(var(--bad-rgb) / .12)', color: 'rgb(var(--bad-rgb))' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      </div>
      <div className="empty-state-title">Something went wrong</div>
      <div className="empty-state-body">{human || "We couldn't load this just now. Please try again."}</div>
      {onRetry && <button className="btn-primary mt-4" onClick={onRetry}>Try again</button>}
      {!human && raw && (
        <details className="mt-3">
          <summary className="t-micro cursor-pointer" style={{ letterSpacing: '.08em' }}>Technical details</summary>
          <div className="t-sub mt-2 break-words" style={{ fontSize: '.6875rem', maxWidth: '34ch' }}>{raw}</div>
        </details>
      )}
    </div>
  );
}

/** Macro colours are tokens now — the orange was a literal hex that no
 *  longer existed anywhere else in the palette. */
export function MacroPill({ p, c, f }) {
  return (
    <span className="flex gap-2 font-grotesk tabular-nums" style={{ fontSize: '.6875rem', fontWeight: 600 }}>
      <span style={{ color: 'var(--accent)' }}>P {Math.round(p)}</span>
      <span style={{ color: 'rgb(var(--warn-rgb))' }}>C {Math.round(c)}</span>
      <span style={{ color: 'rgb(var(--good-rgb))' }}>F {Math.round(f)}</span>
    </span>
  );
}

/**
 * Button — a thin React wrapper over the CSS button system, added so the
 * loading/disabled contract is expressed once instead of each call site
 * hand-rolling a spinner and a disabled guard. Existing raw
 * `<button className="btn-primary">` usage keeps working untouched; this
 * is for new and upgraded call sites.
 */
export function Button({ variant = 'primary', size, loading, disabled, children, className, ...rest }) {
  const variantCls = {
    primary: 'btn-primary', secondary: 'btn-secondary', ghost: 'btn-ghost',
    danger: 'btn-danger', 'danger-quiet': 'btn-danger-quiet', default: 'btn',
  }[variant] || 'btn-primary';
  return (
    <button
      className={cls(variantCls, size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', className)}
      data-loading={loading ? 'true' : undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}>
      {children}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GLYPH REPLACEMENTS

   Roughly three dozen sites across the app used a literal character as an
   icon — '✕' for close, '✓' for done, '›' for "goes somewhere". Each one
   is a real problem, not a stylistic quibble:

     · the shape comes from whatever font resolves it, so a close button
       rendered in DM Sans, the system fallback, or an emoji font
       depending on the platform;
     · it sits on the TEXT baseline rather than the optical centre of its
       button, so every one of them was a pixel or two low;
     · its stroke weight follows font-weight, so it thickened next to a
       bold label and thinned next to a light one, while the real SVG
       icons beside it never moved.

   These are sized `1em`, deliberately. Every existing call site already
   controls the glyph's size with a text-* class and its colour with
   `color`/`currentColor` — at 1em with `stroke="currentColor"` those keep
   working untouched, so swapping the character for the component needs no
   other change at any of the sites.
   ═══════════════════════════════════════════════════════════════════ */
function GlyphSvg({ children, strokeWidth = 2, className, style }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
      className={className}
      /* `inline-block` + the baseline nudge keep it sitting where the
         character it replaces used to sit inside a line of text. */
      style={{ display: 'inline-block', verticalAlign: '-0.125em', ...style }}>
      {children}
    </svg>
  );
}

export const XIcon = (p) => <GlyphSvg {...p}><path d="M18 6 6 18M6 6l12 12" /></GlyphSvg>;
export const CheckIcon = (p) => <GlyphSvg strokeWidth={2.6} {...p}><path d="M20 6 9 17l-5-5" /></GlyphSvg>;
export const ChevronRightIcon = (p) => <GlyphSvg {...p}><path d="m9 18 6-6-6-6" /></GlyphSvg>;
export const ArrowRightIcon = (p) => <GlyphSvg {...p}><path d="M5 12h14M13 5l7 7-7 7" /></GlyphSvg>;

/**
 * PASSWORD INPUT with a reveal toggle.
 *
 * A password field with no reveal is the single most common cause of a
 * failed sign-in on a phone: you cannot see which character the software
 * keyboard auto-capitalised, and the only feedback is a generic "wrong
 * password". Every password field in the product had this gap.
 *
 * `aria-pressed` (not just a swapped icon) so a screen reader announces
 * the current state, and the eye is CROSSED OUT while the password is
 * visible — the icon shows what clicking will do, matching the platform
 * convention people already have.
 *
 * Takes the same props as a bare <input>; `id` is required so the caller's
 * <label htmlFor> keeps working.
 */
export function PasswordInput({ className, style, ...rest }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        {...rest}
        type={shown ? 'text' : 'password'}
        className={cls('input w-full', className)}
        style={{ paddingRight: 46, ...style }}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="chrome-btn absolute right-1.5 top-1/2 -translate-y-1/2 justify-center"
        style={{ width: 34, height: 34 }}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        tabIndex={-1}>
        {shown ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.4 18.4 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 5.39-1.61" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" /><circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

/**
 * PAGE SKELETON — the loading state for a whole route (Part 21).
 *
 * Fifteen pages gated their entire render on `<Spinner label="…" />`. Two
 * problems with that, both visible on every single load:
 *
 *   1. A centred spinner occupies almost none of the page, so the moment
 *      data lands the layout snaps from "one small dot" to a full screen of
 *      content. That is a guaranteed layout shift, on every page, every
 *      time — and on a slow connection it is the FIRST thing a user sees.
 *   2. The spinner is identical everywhere, so it tells you nothing about
 *      what is coming. A skeleton shaped like the page is a promise the
 *      page keeps.
 *
 * Variants are shape FAMILIES, not per-page pixel copies — the point is to
 * reserve roughly the right space and rhythm, and a page whose shape is
 * genuinely unusual should write its own (Home, Workout, Progress,
 * Membership and Billing do exactly that).
 *
 * `label` is not rendered; it goes to assistive tech via aria-label, which
 * is where "Loading clients…" was actually useful in the first place.
 */
export function PageSkeleton({ variant = 'list', label = 'Loading' }) {
  const head = (
    <div>
      <div className="skeleton-title" style={{ width: '34%' }} />
      <div className="skeleton-text mt-2" style={{ width: '56%' }} />
    </div>
  );
  return (
    <div className="space-y-5" aria-busy="true" aria-label={label} role="status">
      {head}

      {variant === 'dashboard' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 96, borderRadius: 'var(--r-lg)' }} />
            ))}
          </div>
          <div className="skeleton" style={{ height: 220, borderRadius: 'var(--r-lg)' }} />
        </>
      )}

      {variant === 'list' && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton-row" />)}
        </div>
      )}

      {variant === 'detail' && (
        <>
          <div className="skeleton" style={{ height: 150, borderRadius: 'var(--r-lg)' }} />
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="skeleton" style={{ height: 190, borderRadius: 'var(--r-lg)' }} />
            <div className="skeleton" style={{ height: 190, borderRadius: 'var(--r-lg)' }} />
          </div>
        </>
      )}

      {variant === 'form' && (
        <div className="card p-5 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="skeleton-text" style={{ width: '26%' }} />
              <div className="skeleton mt-2" style={{ height: 44, borderRadius: 'var(--r-md)' }} />
            </div>
          ))}
          <div className="skeleton" style={{ height: 44, width: 160, borderRadius: 'var(--r-pill)' }} />
        </div>
      )}

      {variant === 'split' && (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-row" />)}
          </div>
          <div className="lg:col-span-2 skeleton" style={{ height: 320, borderRadius: 'var(--r-lg)' }} />
        </div>
      )}
    </div>
  );
}
