import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { PasswordInput } from '../components/UI.jsx';
import { useAuthStage } from '../components/auth/AuthLayout.jsx';
import { AuthTitle, Cta, Divider, ErrorNote, Field, GoogleButton, Steps, googleConfigured } from '../components/auth/authKit.jsx';
import { afterTerms } from '../afterTerms.js';

const HEADLINE = [{ text: 'Run your gym.' }, { text: 'Not spreadsheets.', accent: true }];

// "Enterprise" on the welcome screen -- a gym's very first visit, before
// any account exists. Two short steps: the gym's name, then the owner's
// account (password or Google). POST /auth/setup-org creates the
// organization and its GYM_OWNER together, then the owner continues to the
// Enterprise setup (gym profile -> plan -> payment -> activation), see
// EnterpriseOnboarding.jsx. Asking for the gym's name FIRST is also what
// lets "Continue with Google" work: Google never supplies one.
export default function SetupOrg() {
  useAuthStage('compact', HEADLINE, 'owner');
  const { setupOrg, loginWithGoogleEnterprise } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [moved, setMoved] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const gym = orgName.trim();
  // A new account is sent to the terms first; this is where it continues
  // afterwards (see LegalConsent), not the bare dashboard.
  const done = () => {
    afterTerms('/app/trainer/enterprise/onboarding');
    nav('/app/trainer/enterprise/onboarding');
  };

  const next = (e) => {
    e.preventDefault();
    if (!gym) return;
    setErr('');
    setMoved(true);
    setStep(1);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await setupOrg({ orgName: gym, ownerName, email, password });
      done();
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const google = async (credential) => {
    setBusy(true); setErr('');
    try {
      await loginWithGoogleEnterprise(credential, gym);
      done();
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <>
      <Steps count={2} at={step} />
      {step === 0 ? (
        <div key="gym" className={moved ? 'auth-view' : undefined} data-dir="back">
          <AuthTitle eyebrow="Enterprise" title="What's your gym called?" onBack={() => nav('/login')} />
          <form onSubmit={next} className="auth-form">
            <Field id="orgName" label="Gym or studio name">
              <input id="orgName" className="input auth-input auth-input-xl" type="text" value={orgName}
                onChange={(e) => setOrgName(e.target.value)} autoComplete="organization"
                placeholder="Ironforge Fitness" required autoFocus />
            </Field>
            <Cta disabled={!gym}>Continue</Cta>
          </form>
          <p className="auth-foot">Already on Barbell? <Link to="/login">Sign in</Link></p>
        </div>
      ) : (
        <div key="owner" className="auth-view">
          <AuthTitle eyebrow={gym} title="Create your owner account" onBack={() => { setErr(''); setStep(0); }} />
          <form onSubmit={submit} className="auth-form">
            <Field id="ownerName" label="Your name">
              <input id="ownerName" className="input auth-input" type="text" value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)} autoComplete="name"
                placeholder="Maya Kapoor" required autoFocus />
            </Field>
            <Field id="setup-email" label="Email">
              <input id="setup-email" className="input auth-input" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email"
                placeholder="you@yourgym.com" required />
            </Field>
            <Field id="setup-password" label="Password">
              <PasswordInput id="setup-password" className="auth-input" autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
            </Field>
            <ErrorNote>{err}</ErrorNote>
            <Cta busy={busy}>Create gym</Cta>
          </form>
          {googleConfigured && (
            <>
              <Divider />
              <GoogleButton onCredential={google} onError={setErr} text="signup_with" />
            </>
          )}
        </div>
      )}
    </>
  );
}
