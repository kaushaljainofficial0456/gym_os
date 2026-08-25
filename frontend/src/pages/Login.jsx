import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { consumeReturnTo } from '../api.js';
import MotivationalWelcome from '../components/MotivationalWelcome.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import BorderGlow from '../components/BorderGlow.jsx';
import Icon from '../components/Icon.jsx';
import './../components/BorderGlow.css';

// The three top-level paths onto SK OS. Each is a genuinely different
// account-creation story, not a cosmetic split of one login form:
//   - Enterprise: a gym's very first visit, before any account exists ->
//     /setup-org (POST /auth/setup-org).
//   - Gym ecosystem: someone whose account already exists under a gym
//     (trainer, owner, or a gym-code client) -> the role picker below,
//     then the real email/password form.
//   - Independent client: no gym at all -> /independent (Google sign-in,
//     POST /auth/google).
const PATHS = [
  { id: 'enterprise', icon: 'clipboard', title: 'Enterprise', desc: "First time here? Set up your gym — code, roster and workspace in one go." },
  { id: 'ecosystem', icon: 'strength', title: 'Gym ecosystem', desc: 'Trainer, owner or client at a gym already on SK OS.' },
  { id: 'independent', icon: 'user', title: 'Independent client', desc: 'Training solo, no gym — sign in with Google.' },
];

const ROLES = [
  { id: 'TRAINER', icon: 'chart', title: 'Trainer', desc: 'Your coaching workspace.' },
  { id: 'GYM_OWNER', icon: 'clipboard', title: 'Gym Owner', desc: 'Members, plans and payments.' },
  { id: 'CLIENT', icon: 'user', title: 'Client', desc: 'Your training portal.' },
];

const DEMO_BY_ROLE = {
  TRAINER: { label: 'Trainer', email: 'trainer1@ironforge.in', icon: '◧', desc: 'Arjun Mehta · coaching workspace' },
  GYM_OWNER: { label: 'Gym Owner', email: 'owner@ironforge.in', icon: '₹', desc: 'Maya Kapoor · business view' },
  CLIENT: { label: 'Client', email: 'client1@ironforge.in', icon: '⌁', desc: 'Rahul Sharma · client portal' },
};

const ROLE_COPY = {
  TRAINER: { heading: 'Welcome back, coach', sub: 'Sign in to your coaching workspace.' },
  GYM_OWNER: { heading: 'Welcome back', sub: 'Sign in to your business dashboard.' },
  CLIENT: { heading: 'Welcome back', sub: 'Sign in to your client portal.' },
};

function OptionCard({ icon, title, desc, onClick, delay = 0 }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-4 p-4 rounded-2xl border transition-all duration-200 text-left anim-fadeUp"
      style={{ borderColor: 'var(--line)', background: 'rgba(128,128,128,.025)' }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.05)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.025)'}
      animation-delay={`${delay}ms`}>
      <span className="w-11 h-11 rounded-xl grid place-items-center border shrink-0" style={{ background: 'var(--accent-soft)', borderColor: 'var(--line)', color: 'var(--accent)' }}>
        <Icon name={icon} size={20} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-grotesk text-sm font-bold" style={{ color: 'var(--ink)' }}>{title}</span>
        <span className="block text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--mute)' }}>{desc}</span>
      </span>
      <span style={{ color: 'var(--faint)' }}>›</span>
    </button>
  );
}

function BackLink({ onClick, label }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 text-[12px] font-grotesk font-semibold mb-5" style={{ color: 'var(--mute)' }}>
      <span aria-hidden>‹</span> {label}
    </button>
  );
}

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [view, setView] = useState('landing'); // landing | roles | form
  const [roleHint, setRoleHint] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingUser, setPendingUser] = useState(null);
  const [showWelcome, setShowWelcome] = useState(false);

  const go = (u) => {
    if (u.role === 'CLIENT') {
      setPendingUser(u);
      setShowWelcome(true);
    } else {
      nav('/app/trainer');
    }
  };

  const handleWelcomeComplete = useCallback(() => {
    setShowWelcome(false);
    if (pendingUser) {
      // A shared-meal preview (or similar) that sent this visitor to log in
      // gets priority over the default client home -- consumed once, never
      // re-applied to a later, unrelated login. Never auto-completes the
      // action they were headed toward (e.g. saving a shared meal); it only
      // returns them to the SAME page they were already looking at.
      nav(consumeReturnTo() || '/app/client');
      setPendingUser(null);
    }
  }, [pendingUser, nav]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { go(await login(email, password)); }
    catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const quick = async (demoEmail) => {
    setBusy(true); setErr('');
    try { go(await login(demoEmail, 'demo1234')); }
    catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const pickPath = (id) => {
    if (id === 'enterprise') return nav('/setup-org');
    if (id === 'independent') return nav('/independent');
    setView('roles');
  };

  const pickRole = (id) => {
    setRoleHint(id);
    setErr(''); setEmail(''); setPassword('');
    setView('form');
  };

  const copy = ROLE_COPY[roleHint] || ROLE_COPY.CLIENT;
  const demo = DEMO_BY_ROLE[roleHint];

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
              Train smarter.<br />Coach better.<br />
              <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Prove progress.</span>
            </h1>
            <p className="text-sm mt-5 max-w-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              Client data → tracking → analysis → AI insight → trainer action → client progress.
              The operating system for fitness professionals — and for anyone training on their own.
            </p>
            <div className="mt-8 flex items-center gap-2 text-[11px] font-grotesk uppercase tracking-[.2em]" style={{ color: 'var(--faint)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-good" style={{ boxShadow: '0 0 8px rgba(52,211,153,.8)' }} />
              IRONFORGE FITNESS · demo workspace
            </div>
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

            {view === 'landing' && (
              <>
                <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Welcome</h2>
                <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>How are you using SK OS?</p>
                <div className="space-y-2.5">
                  {PATHS.map((p, i) => (
                    <OptionCard key={p.id} icon={p.icon} title={p.title} desc={p.desc} delay={80 + i * 60} onClick={() => pickPath(p.id)} />
                  ))}
                </div>
              </>
            )}

            {view === 'roles' && (
              <>
                <BackLink onClick={() => setView('landing')} label="Back" />
                <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Gym ecosystem</h2>
                <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>Which one are you?</p>
                <div className="space-y-2.5">
                  {ROLES.map((r, i) => (
                    <OptionCard key={r.id} icon={r.icon} title={r.title} desc={r.desc} delay={80 + i * 60} onClick={() => pickRole(r.id)} />
                  ))}
                </div>
              </>
            )}

            {view === 'form' && (
              <>
                <BackLink onClick={() => setView('roles')} label="Back" />
                <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>{copy.heading}</h2>
                <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>{copy.sub}</p>

                <form onSubmit={submit} className="space-y-3">
                  <div>
                    <label htmlFor="email" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Email</label>
                    <input id="email" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@ironforge.in" required autoFocus />
                  </div>
                  <div>
                    <label htmlFor="password" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Password</label>
                    <input id="password" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••" required />
                  </div>
                  {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5 anim-fadeIn">{err}</div>}
                  <BorderGlow borderRadius={9999} glowRadius={22} className="w-full block">
                    <button className="btn-primary w-full !py-3" disabled={busy}>
                      {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                  </BorderGlow>
                </form>

                {/* Gym-code signup only applies to clients -- trainers and
                    owners are created by an owner or via Enterprise, never
                    self-serve. */}
                {roleHint === 'CLIENT' && (
                  <div className="mt-5 text-center text-sm" style={{ color: 'var(--mute)' }}>
                    New to SK OS?{' '}
                    <Link to="/signup" className="font-semibold" style={{ color: 'var(--accent)' }}>Get started</Link>
                  </div>
                )}

                {demo && (
                  <>
                    <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-widest" style={{ color: 'var(--faint)' }}>
                      <span className="h-px flex-1" style={{ background: 'var(--line)' }} /> or explore the demo <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
                    </div>
                    <button onClick={() => quick(demo.email)} disabled={busy}
                      className="w-full flex items-center gap-3 p-3 rounded-2xl border transition-all duration-200 text-left anim-fadeUp"
                      style={{ borderColor: 'var(--line)', background: 'rgba(128,128,128,.025)' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.05)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.025)'}>
                      <span className="w-9 h-9 rounded-xl grid place-items-center border text-base" style={{ background: 'var(--accent-soft)', borderColor: 'var(--line)', color: 'var(--accent)' }}>{demo.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block font-grotesk text-sm font-semibold" style={{ color: 'var(--ink)' }}>{demo.label}</span>
                        <span className="block text-[11px] truncate" style={{ color: 'var(--mute)' }}>{demo.desc}</span>
                      </span>
                      <span className="chip !text-[9px]">demo1234</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
