import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import MotivationalWelcome from '../components/MotivationalWelcome.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import BorderGlow from '../components/BorderGlow.jsx';
import './../components/BorderGlow.css';

// Client self-signup -- the "New to SK OS?" path off Login. Deliberately
// asks for only name/email/password/gym code: goal, weight, height etc.
// are collected right after by OnboardingWizard, which ClientLayout already
// shows automatically for any account with onboarding_completed = false.
// The gym code is the org's slug (POST /auth/register resolves it) --
// trainers/owners find theirs on the Business page under Gym settings.
export default function SignUp() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gymCode, setGymCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  const handleWelcomeComplete = useCallback(() => {
    setShowWelcome(false);
    nav('/app/client');
  }, [nav]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await register({ name, email, password, gymCode: gymCode.trim() });
      setShowWelcome(true);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      {showWelcome && <MotivationalWelcome onComplete={handleWelcomeComplete} />}
      <SplashCursorLazy />

      <div className="min-h-screen grid lg:grid-cols-2" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        {/* brand side */}
        <div className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden" style={{ borderRight: '1px solid var(--line)' }}>
          <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full blur-[110px] anim-fadeIn" style={{ background: 'var(--accent-soft)' }} />
          <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full blur-[100px] anim-fadeIn" style={{ background: 'rgba(160,128,255,.08)', animationDelay: '200ms' }} />

          <div className="flex items-center gap-4 relative">
            <img src="/logo.png" alt="SK OS" className="w-14 h-14 rounded-2xl shadow-glow" />
            <div>
              <div className="font-brand font-bold tracking-wide" style={{ color: 'var(--ink)' }}>SK OS</div>
              <div className="text-[10px] tracking-[.25em] uppercase font-grotesk" style={{ color: 'var(--mute)' }}>Your fitness business, engineered.</div>
            </div>
          </div>

          <div className="relative">
            <h1 className="font-display font-bold text-5xl leading-[1.08] tracking-tight" style={{ color: 'var(--ink)' }}>
              Your trainer's<br />already here.<br />
              <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Join the workspace.</span>
            </h1>
            <p className="text-sm mt-5 max-w-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              Ask your trainer or gym owner for your gym's sign-up code — it's on their Business
              page under Gym settings. Takes 30 seconds; the rest we'll ask you next.
            </p>
          </div>
        </div>

        {/* form side */}
        <div className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm anim-fadeUp">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <img src="/logo.png" alt="SK OS" className="w-11 h-11 rounded-xl" />
              <div>
                <div className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>SK OS</div>
                <div className="text-[9px] uppercase tracking-[.2em] font-grotesk" style={{ color: 'var(--mute)' }}>Your fitness business, engineered.</div>
              </div>
            </div>

            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Create your account</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>Join your gym's coaching workspace as a client.</p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="name" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Full name</label>
                <input id="name" className="input mt-1" type="text" value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="Rahul Sharma" required autoFocus />
              </div>
              <div>
                <label htmlFor="signup-email" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Email</label>
                <input id="signup-email" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com" required />
              </div>
              <div>
                <label htmlFor="signup-password" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Password</label>
                <input id="signup-password" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters" required minLength={6} />
              </div>
              <div>
                <label htmlFor="gymCode" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Gym code</label>
                <input id="gymCode" className="input mt-1" type="text" value={gymCode} onChange={(e) => setGymCode(e.target.value)}
                  placeholder="e.g. ironforge-fitness" required />
              </div>
              {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5 anim-fadeIn">{err}</div>}
              <BorderGlow borderRadius={9999} glowRadius={22} className="w-full block">
                <button className="btn-primary w-full !py-3" disabled={busy}>
                  {busy ? 'Creating account…' : 'Create account'}
                </button>
              </BorderGlow>
            </form>

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
