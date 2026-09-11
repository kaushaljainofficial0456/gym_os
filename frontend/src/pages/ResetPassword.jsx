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
import { api } from '../api.js';
import { PasswordInput } from '../components/UI.jsx';
import Logo from '../components/Logo.jsx';

const MIN_LENGTH = 6;   // matches the server's own z.string().min(6)

export default function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  /* A link with no token at all is its own case: the person most likely
     opened /reset-password directly, and telling them the link is
     "invalid" would be misleading -- there is no link. */
  if (!token) {
    return (
      <Shell>
        <h1 className="font-display font-bold text-xl mb-2" style={{ color: 'var(--ink)' }}>
          This page needs a reset link
        </h1>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
          Open the link from your reset email, or request a new one.
        </p>
        <Link to="/forgot-password" className="btn-primary btn-block mt-5">Request a reset link</Link>
      </Shell>
    );
  }

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_LENGTH;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    // Checked here so the token is not spent on a request that cannot
    // succeed -- these links are single-use, and burning one on a typo
    // would mean requesting another email.
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
      // The server's reasons differ in what to do next, so they are shown
      // as written rather than flattened to "something went wrong".
      setErr(e2.message || 'This reset link is invalid or has expired.');
    }
    setBusy(false);
  };

  if (done) {
    return (
      <Shell>
        <h1 className="font-display font-bold text-xl mb-2" style={{ color: 'var(--ink)' }}>
          Password changed
        </h1>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
          Sign in with your new password.
        </p>
        <button className="btn-primary btn-lg btn-block mt-5" onClick={() => nav('/login')}>
          Go to sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="font-display font-bold text-xl mb-1" style={{ color: 'var(--ink)' }}>
        Choose a new password
      </h1>
      <p className="text-sm mb-5" style={{ color: 'var(--mute)' }}>
        This link works once and expires an hour after it was sent.
      </p>

      <form onSubmit={submit} className="space-y-3.5">
        <div className="field">
          <label htmlFor="new-password" className="field-label">New password</label>
          <PasswordInput
            id="new-password" className="mt-1.5" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password" placeholder={`At least ${MIN_LENGTH} characters`}
            aria-invalid={tooShort ? 'true' : undefined}
            required autoFocus
          />
          {tooShort && (
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--warn)' }}>
              At least {MIN_LENGTH} characters.
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="confirm-password" className="field-label">Confirm new password</label>
          <PasswordInput
            id="confirm-password" className="mt-1.5" value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password" placeholder="Type it again"
            aria-invalid={mismatch ? 'true' : undefined}
            required
          />
          {mismatch && (
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--warn)' }}>
              These do not match yet.
            </div>
          )}
        </div>

        {err && <div className="field-error anim-fadeIn" role="alert">{err}</div>}

        <button
          className="btn-primary btn-lg btn-block"
          disabled={busy || !password || !confirm || mismatch || tooShort}
        >
          {busy ? 'Saving…' : 'Set new password'}
        </button>
      </form>

      {/* Every failure from here needs a fresh link, so the way to get
          one is always on screen rather than only after an error. */}
      <Link to="/forgot-password" className="block text-center text-[12.5px] mt-4" style={{ color: 'var(--mute)' }}>
        Need a new link?
      </Link>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen grid place-items-center px-5 py-10" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-7 flex justify-center"><Logo /></div>
        <div className="card p-6">{children}</div>
      </div>
    </div>
  );
}
