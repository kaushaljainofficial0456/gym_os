import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

const DEMO = [
  { label: 'Trainer', email: 'trainer1@ironforge.in', icon: '◧', desc: 'Arjun Mehta · coaching workspace' },
  { label: 'Gym Owner', email: 'owner@ironforge.in', icon: '₹', desc: 'Maya Kapoor · business view' },
  { label: 'Client', email: 'client1@ironforge.in', icon: '⌁', desc: 'Rahul Sharma · client portal' }
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = (u) => nav(u.role === 'CLIENT' ? '/app/client' : '/app/trainer');

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
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* brand side */}
      <div className="hidden lg:flex flex-col justify-between p-12 border-r border-line relative overflow-hidden">
        <div className="absolute -top-32 -left-24 w-96 h-96 rounded-full bg-ember/10 blur-[110px] anim-fadeIn" />
        <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-violetx/8 blur-[100px] anim-fadeIn" style={{ animationDelay: '200ms' }} />

        <div className="flex items-center gap-4 relative">
          <img src="/logo.png" alt="SK OS" className="w-14 h-14 rounded-2xl shadow-glow" />
          <div>
            <div className="font-brand font-bold tracking-wide">SK OS</div>
            <div className="text-[10px] tracking-[.25em] text-mute uppercase">Your fitness business, engineered.</div>
          </div>
        </div>

        <div className="relative">
          <h1 className="font-grotesk font-bold text-5xl leading-[1.08] tracking-tight">
            Train smarter.<br />Coach better.<br />
            <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Prove progress.</span>
          </h1>
          <p className="text-mute text-sm mt-5 max-w-sm leading-relaxed">
            Client data → tracking → analysis → AI insight → trainer action → client progress.
            The operating system for fitness professionals.
          </p>
          <div className="mt-8 flex items-center gap-2 text-[11px] text-faint font-grotesk uppercase tracking-[.2em]">
            <span className="w-1.5 h-1.5 rounded-full bg-good" style={{ boxShadow: '0 0 8px rgba(74,222,128,.8)' }} />
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
              <div className="font-brand font-bold text-sm">SK OS</div>
              <div className="text-[9px] text-mute uppercase tracking-[.2em]">Your fitness business, engineered.</div>
            </div>
          </div>

          <h2 className="font-grotesk font-bold text-2xl tracking-tight mb-1">Welcome back</h2>
          <p className="text-mute text-sm mb-6">Sign in to your coaching workspace.</p>

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="email" className="text-[11px] uppercase tracking-wider text-mute font-grotesk">Email</label>
              <input id="email" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@ironforge.in" required autoFocus />
            </div>
            <div>
              <label htmlFor="password" className="text-[11px] uppercase tracking-wider text-mute font-grotesk">Password</label>
              <input id="password" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" required />
            </div>
            {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5 anim-fadeIn">{err}</div>}
            <button className="btn-primary w-full !py-3" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3 text-[10px] text-faint uppercase tracking-widest">
            <span className="h-px flex-1 bg-line" /> or explore the demo <span className="h-px flex-1 bg-line" />
          </div>

          <div className="space-y-2">
            {DEMO.map((d, i) => (
              <button key={d.email} onClick={() => quick(d.email)} disabled={busy}
                className="w-full flex items-center gap-3 p-3 rounded-2xl border border-line bg-white/[.03] hover:bg-white/[.06] hover:border-white/15 transition-all duration-200 text-left anim-fadeUp"
                style={{ animationDelay: `${120 + i * 70}ms` }}>
                <span className="w-9 h-9 rounded-xl grid place-items-center bg-white/5 border border-line text-base text-ember">{d.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-grotesk text-sm font-semibold">{d.label}</span>
                  <span className="block text-[11px] text-mute truncate">{d.desc}</span>
                </span>
                <span className="chip !text-[9px]">demo1234</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
