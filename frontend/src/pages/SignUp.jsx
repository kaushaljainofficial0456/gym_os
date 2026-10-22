import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { consumeReturnTo } from '../api.js';
import { announceArrival } from '../components/ArrivalHost.jsx';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, ErrorNote, Field } from '../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'Your gym.' }, { text: 'Your progress.', accent: true }];

// Client self-signup -- "New here?" off the sign-in form. Name, email and
// password, plus an OPTIONAL gym code (the org's slug, which POST
// /auth/register resolves). Goal, weight, height etc. are asked right
// after by OnboardingWizard, which ClientLayout shows to any account with
// onboarding_completed = false. With no code the account is created
// without a gym and App.jsx's needsGymJoin sends them to /join to scan
// their gym's QR -- so the code sits behind a tap rather than on the form.
export default function SignUp() {
  useAuthStage('compact', HEADLINE, 'member');
  const { register } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gymCode, setGymCode] = useState('');
  const [hasCode, setHasCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const code = gymCode.trim();
      const { user } = await register({ name, email, password, ...(code ? { gymCode: code } : {}) });
      announceArrival(user.name);
      nav(user.pendingGymEnrollment ? '/join' : (consumeReturnTo() || '/app/client'));
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <AuthTitle title="Create your account" onBack={() => nav('/login', { state: { view: 'signin' } })} />
      <form onSubmit={submit} className="auth-form">
        <Field id="name" label="Full name">
          <input id="name" className="input auth-input" type="text" value={name} onChange={(e) => setName(e.target.value)}
            autoComplete="name" placeholder="Rahul Sharma" required autoFocus />
        </Field>
        <Field id="signup-email" label="Email">
          <input id="signup-email" className="input auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" inputMode="email" placeholder="you@example.com" required />
        </Field>
        <Field id="signup-password" label="Password">
          <PasswordInput id="signup-password" className="auth-input" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
        </Field>
        {hasCode ? (
          <Field id="gymCode" label="Gym code">
            <input id="gymCode" className="input auth-input" type="text" value={gymCode} onChange={(e) => setGymCode(e.target.value)}
              autoCapitalize="none" placeholder="From your gym" autoFocus />
          </Field>
        ) : (
          <button type="button" className="auth-aside text-left" onClick={() => setHasCode(true)}>
            Have a gym code?
          </button>
        )}
        <ErrorNote>{err}</ErrorNote>
        <Cta busy={busy}>Create account</Cta>
      </form>
      <p className="auth-foot">Already a member? <Link to="/login" state={{ view: 'signin' }}>Sign in</Link></p>
    </>
  );
}
