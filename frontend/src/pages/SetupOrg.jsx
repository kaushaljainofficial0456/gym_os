import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../themeContext.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import Logo from '../components/Logo.jsx';
import AuthStage from '../components/auth/AuthStage.jsx';
import { usePrefersReducedMotion } from '../components/auth/usePrefersReducedMotion.js';
import BorderGlow from '../components/BorderGlow.jsx';
import { loadGoogleIdentity } from '../googleIdentity.js';
import './../components/BorderGlow.css';
import { PasswordInput } from '../components/UI.jsx';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// "Enterprise" on the login screen -- a gym's very first visit, before any
// account exists. Creates the organization + its GYM_OWNER account in one
// call (POST /auth/setup-org), then lands on the Enterprise onboarding
// wizard (gym profile -> package -> payment -> activation) -- see
// EnterpriseOnboarding.jsx. After that FIRST purchase completes, the
// owner never sees this screen or the wizard again; they land on the
// normal Business/Enterprise dashboards from here on.
export default function SetupOrg() {
  const reduced = usePrefersReducedMotion();
  const { setupOrg, loginWithGoogleEnterprise } = useAuth();
  const nav = useNavigate();
  // `resolved` (never the raw choice): 'system' is now a storable
  // value, and every comparison below is against light/dark.
  const { resolved: theme } = useTheme();
  const [orgName, setOrgName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const orgNameRef = useRef(orgName);
  orgNameRef.current = orgName; // read fresh inside the GIS callback below, which closes over render-time values otherwise

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await setupOrg({ orgName, ownerName, email, password });
      nav('/app/trainer/enterprise/onboarding');
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  // "Continue with Google" -- an existing GYM_OWNER logs straight in; a
  // brand-new signup needs a gym name (Google never supplies one), so
  // this reuses the SAME "Gym / studio name" field the password form
  // already has above rather than asking twice. If it's empty when they
  // click, this fails with a friendly inline message instead of ever
  // reaching the backend with a name-less signup.
  const googleBtnRef = useRef(null);
  const [googleReady, setGoogleReady] = useState(false);
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    const handleCredential = async (response) => {
      if (!orgNameRef.current.trim()) {
        setErr('Enter your gym / studio name above first, then continue with Google.');
        return;
      }
      setBusy(true); setErr('');
      try {
        await loginWithGoogleEnterprise(response.credential, orgNameRef.current.trim());
        nav('/app/trainer/enterprise/onboarding');
      } catch (ex) { setErr(ex.message); setBusy(false); }
    };

    loadGoogleIdentity().then(() => {
      if (cancelled) return;
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredential, auto_select: false });
      if (googleBtnRef.current) {
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          type: 'standard',
          theme: theme === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          logo_alignment: 'left',
          width: 320,
        });
      }
      setGoogleReady(true);
    }).catch((ex) => setErr(ex.message));

    return () => { cancelled = true; };
  }, [theme]);

  return (
    <>
      <SplashCursorLazy />

      <div className="min-h-screen grid lg:grid-cols-2" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        {/* brand side */}
        {/* Same stage as /login, different words -- one component so the
            two screens can never drift apart typographically. */}
        <AuthStage
          reduced={reduced}
          eyebrow="Set up your gym"
          lines={[
            { text: 'Run your gym.' },
            { text: 'Not spreadsheets.' },
            { text: 'Set up in a minute.', accent: true },
          ]}
          footer={(
            <span className="normal-case tracking-normal text-[12.5px] leading-relaxed max-w-sm" style={{ color: 'var(--mute)' }}>
              Members, trainers, plans, payments, renewals and a live coaching workspace for your
              whole team — under one roof, from your very first client.
            </span>
          )}
        />

        {/* form side */}
        <div className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm anim-fadeUp">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <Logo className="w-11 h-11 rounded-xl" />
              <div>
                <div className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>Barbell</div>
                <div className="text-[9px] uppercase tracking-[.2em] font-grotesk" style={{ color: 'var(--mute)' }}>Your fitness business, engineered.</div>
              </div>
            </div>

            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Set up your gym</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>You'll be the owner — invite trainers and clients once you're in.</p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="orgName" className="field-label">Gym / studio name</label>
                <input id="orgName" className="input mt-1.5" type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Ironforge Fitness" required autoFocus />
              </div>
              <div>
                <label htmlFor="ownerName" className="field-label">Your name</label>
                <input id="ownerName" className="input mt-1.5" type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Maya Kapoor" required />
              </div>
              <div>
                <label htmlFor="setup-email" className="field-label">Email</label>
                <input id="setup-email" className="input mt-1.5" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com" required />
              </div>
              <div>
                <label htmlFor="setup-password" className="field-label">Password</label>
                <PasswordInput id="setup-password" className="mt-1.5" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters" required minLength={6} />
              </div>
              <BorderGlow borderRadius={9999} glowRadius={22} className="w-full block">
                <button className="btn-primary btn-lg btn-block" disabled={busy}>
                  {busy ? 'Setting up…' : 'Create my gym'}
                </button>
              </BorderGlow>
            </form>

            {GOOGLE_CLIENT_ID && (
              <div className="mt-5">
                <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--faint)' }}>
                  <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
                  or
                  <div className="flex-1 h-px" style={{ background: 'var(--line)' }} />
                </div>
                <div className="mt-4 flex flex-col items-center gap-2">
                  <div ref={googleBtnRef} className="min-h-[44px]" />
                  {!googleReady && <div className="text-xs" style={{ color: 'var(--faint)' }}>Loading Google sign-in…</div>}
                </div>
              </div>
            )}

            {err && <div role="alert" className="field-error mt-4 anim-fadeIn">{err}</div>}

            <div className="mt-6 text-center text-sm" style={{ color: 'var(--mute)' }}>
              Already have an account?{' '}
              <Link to="/login" className="font-semibold" style={{ color: 'var(--accent)' }}>Sign in</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
