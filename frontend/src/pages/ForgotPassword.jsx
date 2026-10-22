/**
 * FORGOT PASSWORD.
 *
 * The server issues a one-hour single-use token, answers every request
 * with the same generic message so the response cannot be used to discover
 * which addresses have accounts, and emails a link to /reset-password.
 *
 * THE GENERIC ANSWER IS PRESERVED HERE. The screen says the same thing
 * whether or not the address has an account, because saying "no account
 * found" turns this form into a way to enumerate a gym's membership. The
 * wording therefore promises only what is true: if an account exists, a
 * link is on its way.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api } from '../api.js';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, ErrorNote, Field } from '../components/auth/authKit.jsx';

const RECOVERY_HEADLINE = [{ text: 'Back in' }, { text: 'a minute.', accent: true }];

export default function ForgotPassword() {
  useAuthStage('compact', RECOVERY_HEADLINE);
  const nav = useNavigate();
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

  const back = () => nav('/login', { state: { view: 'signin' } });

  if (sent) {
    return (
      <div className="auth-view">
        <div className="auth-icon"><MailCheck size={22} strokeWidth={1.4} aria-hidden="true" /></div>
        {/* Deliberately does NOT confirm the address exists. */}
        <AuthTitle title="Check your email"
          sub={<>If an account exists for <strong style={{ color: 'var(--ink)' }}>{email.trim()}</strong>, a reset link is on its way. It expires in an hour.</>} />
        <button type="button" className="auth-ghost" onClick={back}>Back to sign in</button>
        <p className="auth-foot" style={{ fontSize: 12.5 }}>Nothing arrived? Check spam, then try again.</p>
      </div>
    );
  }

  return (
    <>
      <AuthTitle title="Reset your password" sub="We'll email you a link." onBack={back} />
      <form onSubmit={submit} className="auth-form">
        <Field id="reset-email" label="Email">
          <input id="reset-email" className="input auth-input" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="username" inputMode="email"
            placeholder="you@yourgym.com" required autoFocus />
        </Field>
        <ErrorNote>{err}</ErrorNote>
        <Cta busy={busy} disabled={!email.trim()}>Send reset link</Cta>
      </form>
      <p className="auth-foot">Remembered it? <Link to="/login" state={{ view: 'signin' }}>Sign in</Link></p>
    </>
  );
}
