import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import MotivationalWelcome from '../components/MotivationalWelcome.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import BorderGlow from '../components/BorderGlow.jsx';
import './../components/BorderGlow.css';

// Self-serve TRAINER signup -- the QR-based counterpart to a gym owner
// creating a trainer account for someone directly. No gym code: a
// trainer always joins by scanning the gym's own trainer QR right after
// this (see /join), never by typing a code. Mirrors SignUp.jsx's shape
// closely on purpose -- same account-creation story, different role and
// backend route (POST /auth/register-trainer).
export default function TrainerSignUp() {
  const { registerTrainer } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  const handleWelcomeComplete = useCallback(() => {
    setShowWelcome(false);
    nav('/join');
  }, [nav]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await registerTrainer({ name, email, password });
      setShowWelcome(true);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      {showWelcome && <MotivationalWelcome onComplete={handleWelcomeComplete} />}
      <SplashCursorLazy />
      <div className="min-h-screen grid lg:grid-cols-2" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
        <div className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden" style={{ borderRight: '1px solid var(--line)' }}>
          <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full blur-[110px] anim-fadeIn" style={{ background: 'var(--accent-soft)' }} />
          <div className="flex items-center gap-4 relative">
            <img src="/logo.png" alt="SK OS" className="w-14 h-14 rounded-2xl shadow-glow" />
            <div>
              <div className="font-brand font-bold tracking-wide" style={{ color: 'var(--ink)' }}>SK OS</div>
              <div className="text-[10px] tracking-[.25em] uppercase font-grotesk" style={{ color: 'var(--mute)' }}>Your fitness business, engineered.</div>
            </div>
          </div>
          <div className="relative">
            <h1 className="font-display font-bold text-5xl leading-[1.08] tracking-tight" style={{ color: 'var(--ink)' }}>
              Coach where<br />you already work.<br />
              <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Scan in, start coaching.</span>
            </h1>
            <p className="text-sm mt-5 max-w-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              Create your trainer account, then scan the QR code your gym gives you to join their workspace.
              No payment, no waiting.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm anim-fadeUp">
            <div className="lg:hidden flex items-center gap-3 mb-8">
              <img src="/logo.png" alt="SK OS" className="w-11 h-11 rounded-xl" />
              <div className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>SK OS</div>
            </div>
            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Create your trainer account</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>You'll join a gym next by scanning their QR code.</p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="tname" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Full name</label>
                <input id="tname" className="input mt-1" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Arjun Mehta" required autoFocus />
              </div>
              <div>
                <label htmlFor="temail" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Email</label>
                <input id="temail" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <div>
                <label htmlFor="tpassword" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Password</label>
                <input id="tpassword" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
              </div>
              {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5 anim-fadeIn">{err}</div>}
              <BorderGlow borderRadius={9999} glowRadius={22} className="w-full block">
                <button className="btn-primary w-full !py-3" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
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
