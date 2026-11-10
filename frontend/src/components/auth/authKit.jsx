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

/**
 * Google refuses to sign anyone in inside an embedded WebView ("Error 403:
 * disallowed_useragent"). That is exactly what the Barbell Android app is
 * (a WebView around this site, which appends "GymOS-Android" to its user
 * agent), and also what in-app browsers like Instagram's and Facebook's
 * are. There the Google button could only ever fail, so it is not shown
 * and people sign in with email and password instead.
 */
export function isEmbeddedWebView(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return /GymOS-Android|; wv\)|FBAN|FBAV|Instagram/.test(ua || '');
}
/**
 * The Barbell Android app's native Google sign-in. From the APK that added
 * it, mobile/src/shell.js puts googleSignIn on window.__gymosShell, asking
 * Android's Credential Manager for the same kind of Google ID token the web
 * button produces. The shell is installed at document start, before this
 * module runs, so reading it once here is enough. Older APKs do not have
 * it, and the button stays hidden there.
 */
function nativeShell() {
  const shell = typeof window !== 'undefined' ? window.__gymosShell : null;
  return shell && typeof shell.googleSignIn === 'function' ? shell : null;
}
export const googleNative = !!GOOGLE_CLIENT_ID && !!nativeShell();
/** Inside an embedded WebView with no native sign-in to fall back on. */
export const googleBlockedHere = isEmbeddedWebView() && !googleNative;
/** True where Google sign-in can actually work: configured, and either a real browser or the app's native sign-in. */
export const googleAvailable = !!GOOGLE_CLIENT_ID && !googleBlockedHere;

/** `onCredential` gets a Google ID token, from the app's native sign-in or Google's own web button. */
export function GoogleButton(props) {
  return googleNative ? <NativeGoogleButton {...props} /> : <WebGoogleButton {...props} />;
}

const NATIVE_LABELS = { continue_with: 'Continue with Google', signin_with: 'Sign in with Google', signup_with: 'Sign up with Google' };

/** Google's "G", for the app's own button -- the one part of Google's button the app has to draw itself. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * The app's button: looks like Google's (which cannot be drawn inside a
 * WebView), and opens Android's own Google account sheet. Closing that
 * sheet is not an error, so nothing is shown for it.
 */
function NativeGoogleButton({ onCredential, onError, text = 'continue_with' }) {
  const { resolved } = useTheme();
  const [busy, setBusy] = useState(false);
  const tap = async () => {
    setBusy(true);
    try {
      const { idToken } = await nativeShell().googleSignIn({ serverClientId: GOOGLE_CLIENT_ID });
      await onCredential?.(idToken);
    } catch (e) {
      if (e?.code !== 'CANCELED') onError?.(e?.message || 'Google sign-in failed. Try again, or use email.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-google">
      <button type="button" className="auth-google-native" data-theme={resolved === 'dark' ? 'dark' : 'light'}
        onClick={tap} disabled={busy} aria-busy={busy}>
        <GoogleG />
        <span>{NATIVE_LABELS[text] || NATIVE_LABELS.continue_with}</span>
      </button>
    </div>
  );
}

/**
 * Google's own button (Google Identity Services draws it; it cannot be
 * restyled beyond its theme and shape). `onCredential` gets the ID token.
 * Re-rendered when the theme flips, since GIS bakes the theme in.
 */
function WebGoogleButton({ onCredential, onError, text = 'continue_with' }) {
  const ref = useRef(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;
  const { resolved } = useTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!googleAvailable) return undefined;
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

  if (!googleAvailable) return null;
  return (
    <div className="auth-google" aria-busy={!ready}>
      <div ref={ref} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
    </div>
  );
}
