/**
 * RESET PASSWORD — the destination the reset emails were already
 * pointing at.
 *
 * POST /auth/reset-password has existed and worked: single-use token,
 * one-hour expiry, and a distinct message per failure reason (expired,
 * already used, malformed). The link in every reset email pointed at
 * /reset-password, and this app had no such route -- so the flow ended
 * in a 404 and the careful server-side messages were never read by
 * anyone.
 *
 * The failure reasons are surfaced as written, because they differ in
 * what the person should DO: an expired link and an already-used link
 * both need a new one, while a malformed link usually means the email
 * client truncated it and the fix is to copy the whole URL.
 *
 * The server clears this browser's session cookie on success, so the
 * next step is always a fresh sign-in with the new password.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { api } from '../api.js';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, ErrorNote, Field } from '../components/auth/authKit.jsx';

const MIN_LENGTH = 6;   // matches the server's own z.string().min(6)
const HEADLINE = [{ text: 'Back in' }, { text: 'a minute.', accent: true }];

function Badge() {
  return (
    <div className="auth-icon"><KeyRound size={22} strokeWidth={1.4} aria-hidden="true" /></div>
  );
}

export default function ResetPassword() {
  useAuthStage('compact', HEADLINE);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const toSignIn = () => nav('/login', { state: { view: 'signin' } });

  /* A link with no token at all is its own case: the person most likely
     opened /reset-password directly, and telling them the link is
     "invalid" would be misleading -- there is no link. */
  if (!token) {
    return (
      <>
        <Badge />
        <AuthTitle title="This page needs a reset link" sub="Open the link from your reset email, or request a new one." />
        <Link to="/forgot-password" className="auth-cta">Request a reset link</Link>
      </>
    );
  }

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) return setErr('Those passwords do not match.');
    if (password.length < MIN_LENGTH) return setErr(`Use at least ${MIN_LENGTH} characters.`);

    setBusy(true); setErr('');
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (e2) {
      setErr(e2.message || 'This reset link is invalid or has expired.');
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="auth-view">
        <Badge />
        <AuthTitle title="Password changed" sub="Sign in with your new password." />
        <Cta onClick={toSignIn}>Go to sign in</Cta>
      </div>
    );
  }

  return (
    <>
      <AuthTitle title="Choose a new password" sub="This link works once, for an hour." />
      <form onSubmit={submit} className="auth-form">
        <Field id="new-password" label="New password">
          <PasswordInput
            id="new-password" className="auth-input" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password" placeholder={`At least ${MIN_LENGTH} characters`}
            aria-invalid={tooShort ? 'true' : undefined}
            required autoFocus
          />
          {tooShort && <div className="text-[12px] mt-1.5" style={{ color: 'var(--warn)' }}>At least {MIN_LENGTH} characters.</div>}
        </Field>
        <Field id="confirm-password" label="Confirm new password">
          <PasswordInput
            id="confirm-password" className="auth-input" value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password" placeholder="Type it again"
            aria-invalid={mismatch ? 'true' : undefined}
            required
          />
          {mismatch && <div className="text-[12px] mt-1.5" style={{ color: 'var(--warn)' }}>These do not match yet.</div>}
        </Field>
        <ErrorNote>{err}</ErrorNote>
        <Cta busy={busy} disabled={!password || !confirm || mismatch || tooShort}>Set new password</Cta>
      </form>
      {/* Every failure from here needs a fresh link, so the way to get
          one is always on screen rather than only after an error. */}
      <p className="auth-foot"><Link to="/forgot-password">Need a new link?</Link></p>
    </>
  );
}
