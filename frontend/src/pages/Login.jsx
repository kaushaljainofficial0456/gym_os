import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../themeContext.jsx';
import MotivationalWelcome from '../components/MotivationalWelcome.jsx';

const DEMO = [
  { label: 'Trainer', email: 'trainer1@ironforge.in', icon: '◧', desc: 'Arjun Mehta · coaching workspace' },
  { label: 'Gym Owner', email: 'owner@ironforge.in', icon: '₹', desc: 'Maya Kapoor · business view' },
  { label: 'Client', email: 'client1@ironforge.in', icon: '⌁', desc: 'Rahul Sharma · client portal' }
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
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
      nav('/app/client');
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

  return (
    <>
      {showWelcome && <MotivationalWelcome onComplete={handleWelcomeComplete} />}

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
              The operating system for fitness professionals.
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

            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Welcome back</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>Sign in to your coaching workspace.</p>

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
              <button className="btn-primary w-full !py-3" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-widest" style={{ color: 'var(--faint)' }}>
              <span className="h-px flex-1" style={{ background: 'var(--line)' }} /> or explore the demo <span className="h-px flex-1" style={{ background: 'var(--line)' }} />
            </div>

            <div className="space-y-2">
              {DEMO.map((d, i) => (
                <button key={d.email} onClick={() => quick(d.email)} disabled={busy}
                  className="w-full flex items-center gap-3 p-3 rounded-2xl border transition-all duration-200 text-left anim-fadeUp"
                  style={{ borderColor: 'var(--line)', background: 'rgba(128,128,128,.025)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(128,128,128,.025)'}
                  animation-delay={`${120 + i * 70}ms`}>
                  <span className="w-9 h-9 rounded-xl grid place-items-center border text-base" style={{ background: 'var(--accent-soft)', borderColor: 'var(--line)', color: 'var(--accent)' }}>{d.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-grotesk text-sm font-semibold" style={{ color: 'var(--ink)' }}>{d.label}</span>
                    <span className="block text-[11px] truncate" style={{ color: 'var(--mute)' }}>{d.desc}</span>
                  </span>
                  <span className="chip !text-[9px]">demo1234</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
