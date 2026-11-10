import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { announceArrival } from '../components/ArrivalHost.jsx';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, Divider, ErrorNote, Field, GoogleButton, googleAvailable, googleBlockedHere } from '../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'No gym.' }, { text: 'No problem.', accent: true }];
const PERKS = ['Workouts', 'Nutrition', 'Progress'];

// "Independent client" on the welcome screen -- no gym, no gym code. Two
// ways in, both landing in the shared "Independent Clients" org (gym-only
// features such as the live crowd turned off -- see backend/src/routes/auth.js):
//   - Google (POST /auth/google), where Google allows it.
//   - Email and password (POST /auth/register-independent). This used to
//     be Google-only, and Google refuses to sign in inside an embedded
//     WebView -- which the Barbell Android app is -- so nobody could become
//     an Independent client in the app at all.
// Coming back later is the ordinary Sign in screen, for both.
//
// No navigate() on success: App.jsx's GuestOnly sees the new session and
// sends them on -- to the terms first if they have not accepted them, then
// the client home. Going straight to /app/client (as this used to) skipped
// the terms screen for every new Independent client.
export default function IndependentLogin() {
  useAuthStage('compact', HEADLINE, 'member');
  const { loginWithGoogle, registerIndependent } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true); setErr('');
    try {
      const u = await fn();
      announceArrival(u?.name);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  const google = (credential) => run(() => loginWithGoogle(credential));
  const submit = (e) => {
    e.preventDefault();
    run(() => registerIndependent({ name: name.trim(), email: email.trim(), password }));
  };

  return (
    <>
      <AuthTitle eyebrow="Independent" title="Train on your own" sub="No gym needed. Your account takes a minute." onBack={() => nav('/login')} />
      <div className="auth-perks">{PERKS.map((p) => <span key={p}>{p}</span>)}</div>

      {googleAvailable && (
        <>
          <GoogleButton onCredential={google} onError={setErr} />
          <Divider>or use email</Divider>
        </>
      )}

      <form onSubmit={submit} className="auth-form">
        <Field id="ind-name" label="Full name">
          <input id="ind-name" className="input auth-input" type="text" value={name} onChange={(e) => setName(e.target.value)}
            autoComplete="name" placeholder="Rahul Sharma" maxLength={80} required />
        </Field>
        <Field id="ind-email" label="Email">
          <input id="ind-email" className="input auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" inputMode="email" placeholder="you@example.com" required />
        </Field>
        <Field id="ind-password" label="Password">
          <PasswordInput id="ind-password" className="auth-input" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
        </Field>
        <ErrorNote>{err}</ErrorNote>
        <Cta busy={busy}>Create account</Cta>
      </form>

      <p className="auth-foot">Already have an account? <Link to="/login" state={{ view: 'signin' }}>Sign in</Link></p>
      {googleBlockedHere && (
        <p className="auth-hint">
          Made your account with Google on the website? Google sign-in doesn&rsquo;t work inside the app.
          Use <Link to="/forgot-password">Forgot password</Link> to set a password, then sign in with your email.
        </p>
      )}
    </>
  );
}
