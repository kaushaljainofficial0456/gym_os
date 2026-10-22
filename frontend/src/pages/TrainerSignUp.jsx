import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { announceArrival } from '../components/ArrivalHost.jsx';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, ErrorNote, Field } from '../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'Coach where' }, { text: 'you already work.', accent: true }];

// Self-serve TRAINER signup -- the QR-based counterpart to an owner creating
// a trainer account directly. No gym code: a trainer always joins by
// scanning the gym's own trainer QR right after this (see /join). Same
// account-creation story as SignUp.jsx, different role and backend route
// (POST /auth/register-trainer).
export default function TrainerSignUp() {
  useAuthStage('compact', HEADLINE, 'coach');
  const { registerTrainer } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await registerTrainer({ name, email, password });
      announceArrival(name);
      nav('/join');
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <AuthTitle eyebrow="Trainer" title="Join as a trainer" sub="You'll scan your gym's QR code next."
        onBack={() => nav('/login', { state: { view: 'signin' } })} />
      <form onSubmit={submit} className="auth-form">
        <Field id="tname" label="Full name">
          <input id="tname" className="input auth-input" type="text" value={name} onChange={(e) => setName(e.target.value)}
            autoComplete="name" placeholder="Arjun Mehta" required autoFocus />
        </Field>
        <Field id="temail" label="Email">
          <input id="temail" className="input auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" inputMode="email" placeholder="you@example.com" required />
        </Field>
        <Field id="tpassword" label="Password">
          <PasswordInput id="tpassword" className="auth-input" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
        </Field>
        <ErrorNote>{err}</ErrorNote>
        <Cta busy={busy}>Create account</Cta>
      </form>
      <p className="auth-foot">Already have an account? <Link to="/login" state={{ view: 'signin' }}>Sign in</Link></p>
    </>
  );
}
