/**
 * FORGOT PASSWORD — the half of the flow that was missing.
 *
 * The server side of password reset was already complete and careful:
 * it issues a one-hour single-use token, answers every request with the
 * same generic message so the response cannot be used to discover which
 * addresses have accounts, and emails a link to
 * `${frontendUrl}/reset-password?token=...`.
 *
 * That route did not exist in this app, and no page linked here. So the
 * emails pointed at a 404 and there was no way to reach the flow at all:
 * a person who forgot their password simply could not get back in.
 *
 * THE GENERIC ANSWER IS PRESERVED HERE. The screen says the same thing
 * whether or not the address has an account, because saying "no account
 * found" turns this form into a way to enumerate a gym's membership. The
 * wording therefore promises only what is true: if an account exists, a
 * link is on its way.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
      setSent(true);
    } catch (e2) {
      /* Only genuine transport/rate-limit failures reach here -- the
         endpoint answers 200 for unknown addresses by design. Showing
         this error is safe precisely because it is never "no such
         account". */
      setErr(e2.message || 'Could not send the reset link. Try again in a moment.');
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen grid place-items-center px-5 py-10" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="mb-7 flex justify-center"><Logo /></div>

        {sent ? (
          <div className="card p-6 text-center">
            <h1 className="font-display font-bold text-xl mb-2" style={{ color: 'var(--ink)' }}>
              Check your email
            </h1>
            {/* Deliberately does NOT confirm the address exists. */}
            <p className="text-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              If an account exists for <strong style={{ color: 'var(--ink)' }}>{email.trim()}</strong>,
              a reset link is on its way. It expires in an hour.
            </p>
            <p className="text-[12px] mt-3" style={{ color: 'var(--faint)' }}>
              Nothing arrived? Check spam, then try again — the link is only sent to registered addresses.
            </p>
            <Link to="/login" className="btn btn-block mt-5">Back to sign in</Link>
          </div>
        ) : (
          <div className="card p-6">
            <h1 className="font-display font-bold text-xl mb-1" style={{ color: 'var(--ink)' }}>
              Reset your password
            </h1>
            <p className="text-sm mb-5" style={{ color: 'var(--mute)' }}>
              Enter the email you sign in with and we'll send you a link.
            </p>

            <form onSubmit={submit} className="space-y-3.5">
              <div className="field">
                <label htmlFor="reset-email" className="field-label">Email</label>
                <input
                  id="reset-email" className="input mt-1.5" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username" placeholder="you@yourgym.com"
                  required autoFocus
                />
              </div>
              {err && <div className="field-error anim-fadeIn" role="alert">{err}</div>}
              <button className="btn-primary btn-lg btn-block" disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
            </form>

            <Link to="/login" className="block text-center text-[12.5px] mt-4" style={{ color: 'var(--mute)' }}>
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
