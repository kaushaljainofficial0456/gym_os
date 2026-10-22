import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, ErrorNote, GoogleButton, googleConfigured } from '../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'No gym.' }, { text: 'No problem.', accent: true }];
const PERKS = ['Workouts', 'Nutrition', 'Progress'];

// "Independent client" on the welcome screen -- no gym, no gym code, so the
// gym-code SignUp flow doesn't apply. One tap with Google instead: the
// backend (POST /auth/google) verifies the token and finds-or-creates a
// CLIENT account under the shared "Independent Clients" org, which has
// gym-only features (live crowd, a human trainer to message) turned off at
// the data level -- see backend/src/routes/auth.js.
export default function IndependentLogin() {
  useAuthStage('compact', HEADLINE, 'member');
  const { loginWithGoogle } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const google = async (credential) => {
    setBusy(true); setErr('');
    try {
      await loginWithGoogle(credential);
      nav('/app/client');
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <>
      <AuthTitle eyebrow="Independent" title="Train on your own" sub="No gym code. No password to remember." onBack={() => nav('/login')} />
      <div className="auth-perks">{PERKS.map((p) => <span key={p}>{p}</span>)}</div>
      {googleConfigured ? (
        <GoogleButton onCredential={google} onError={setErr} />
      ) : (
        <ErrorNote>Google sign-in isn&rsquo;t set up on this deployment yet (VITE_GOOGLE_CLIENT_ID is missing).</ErrorNote>
      )}
      {busy && <p className="auth-foot" role="status">Signing you in…</p>}
      {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}
      <p className="auth-foot">Part of a gym? <Link to="/login" state={{ view: 'signin' }}>Sign in</Link></p>
    </>
  );
}
