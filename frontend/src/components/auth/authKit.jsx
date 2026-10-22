/**
 * The pieces every sign-in screen is built from, so ten screens read as
 * one product: a heading with an optional way back, choice cards, a role
 * switch, labelled fields, the primary action, a divider, an error, step
 * progress and the Google button.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert } from 'lucide-react';
import { useTheme } from '../../themeContext.jsx';
import { loadGoogleIdentity } from '../../googleIdentity.js';

export function AuthTitle({ title, sub, eyebrow, onBack, backLabel = 'Back' }) {
  return (
    <header className="auth-head">
      {onBack && (
        <button type="button" className="auth-back" onClick={onBack}>
          <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          {backLabel}
        </button>
      )}
      {eyebrow && <div className="auth-eyebrow">{eyebrow}</div>}
      <h1 className="auth-title">{title}</h1>
      {sub && <p className="auth-sub">{sub}</p>}
    </header>
  );
}

/** A path into the app: a ruled row with a name and one short line. The
 *  rule beneath fills in under the pointer. Rows go inside `.auth-rows`. */
export function ChoiceRow({ icon: IconCmp, title, sub, onClick }) {
  return (
    <button type="button" className="auth-row" onClick={onClick}>
      {IconCmp && <span className="auth-row__icon"><IconCmp size={20} strokeWidth={1.6} aria-hidden="true" /></span>}
      <span className="auth-row__body">
        <span className="auth-row__title">{title}</span>
        {sub && <span className="auth-row__sub">{sub}</span>}
      </span>
      <ArrowRight className="auth-row__go" size={18} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/** One of N, as underline tabs. Arrow keys move between options, as a
 *  radio group's should. */
export function RoleSwitch({ label, options, value, onChange }) {
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  const refs = useRef([]);
  const onKey = (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + options.length) % options.length;
    onChange(options[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="auth-tabs" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, k) => (
        <button
          key={o.id}
          ref={(el) => { refs.current[k] = el; }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ id, label, aside, children }) {
  return (
    <div>
      <div className="auth-label-row">
        <label htmlFor={id} className="auth-label">{label}</label>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Cta({ busy, children, ...rest }) {
  return (
    <button className="auth-cta" data-loading={busy ? 'true' : undefined} {...rest} disabled={busy || rest.disabled}>
      {children}
    </button>
  );
}

export function Divider({ children = 'or' }) {
  return <div className="auth-divider">{children}</div>;
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="auth-error" role="alert">
      <CircleAlert size={17} strokeWidth={2} aria-hidden="true" style={{ color: 'rgb(var(--bad-rgb))', flex: 'none', marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

export function Steps({ count, at }) {
  return (
    <div className="auth-steps" role="progressbar" aria-valuemin={1} aria-valuemax={count} aria-valuenow={at + 1} aria-label={`Step ${at + 1} of ${count}`}>
      {Array.from({ length: count }, (_, k) => <span key={k} data-on={k <= at ? 'true' : undefined} />)}
    </div>
  );
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
export const googleConfigured = !!GOOGLE_CLIENT_ID;

/**
 * Google's own button (Google Identity Services draws it; it cannot be
 * restyled beyond its theme and shape). `onCredential` gets the ID token.
 * Re-rendered when the theme flips, since GIS bakes the theme in.
 */
export function GoogleButton({ onCredential, onError, text = 'continue_with' }) {
  const ref = useRef(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const { resolved } = useTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return undefined;
    let cancelled = false;
    loadGoogleIdentity().then(() => {
      if (cancelled || !ref.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (r) => handler.current?.(r.credential),
        auto_select: false,
      });
      window.google.accounts.id.renderButton(ref.current, {
        type: 'standard',
        theme: resolved === 'dark' ? 'filled_black' : 'outline',
        size: 'large',
        shape: 'pill',
        text,
        logo_alignment: 'center',
        width: Math.min(400, Math.max(240, ref.current.offsetWidth || 320)),
      });
      setReady(true);
    }).catch((e) => onError?.(e.message));
    return () => { cancelled = true; };
  }, [resolved, text]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!GOOGLE_CLIENT_ID) return null;
  return (
    <div className="auth-google" aria-busy={!ready}>
      <div ref={ref} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
    </div>
  );
}
