import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import BorderGlow from '../components/BorderGlow.jsx';
import './../components/BorderGlow.css';

// "Enterprise" on the login screen -- a gym's very first visit, before any
// account exists. Creates the organization + its GYM_OWNER account in one
// call (POST /auth/setup-org), then lands straight on the owner dashboard --
// there's nothing to onboard into yet (no clients, no packages), so the
// dashboard's own empty states carry that, not a separate wizard here.
export default function SetupOrg() {
  const { setupOrg } = useAuth();
  const nav = useNavigate();
  const [orgName, setOrgName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await setupOrg({ orgName, ownerName, email, password });
      nav('/app/trainer/business');
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <>
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
              Run your gym.<br />Not spreadsheets.<br />
              <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Set up in a minute.</span>
            </h1>
            <p className="text-sm mt-5 max-w-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              Members, trainers, plans, payments, renewals and a live coaching workspace for your
              whole team — under one roof, from your very first client.
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

            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Set up your gym</h2>
            <p className="text-sm mb-6" style={{ color: 'var(--mute)' }}>You'll be the owner — invite trainers and clients once you're in.</p>

            <form onSubmit={submit} className="space-y-3">
              <div>
                <label htmlFor="orgName" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Gym / studio name</label>
                <input id="orgName" className="input mt-1" type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Ironforge Fitness" required autoFocus />
              </div>
              <div>
                <label htmlFor="ownerName" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Your name</label>
                <input id="ownerName" className="input mt-1" type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Maya Kapoor" required />
              </div>
              <div>
                <label htmlFor="setup-email" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Email</label>
                <input id="setup-email" className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com" required />
              </div>
              <div>
                <label htmlFor="setup-password" className="text-[11px] uppercase tracking-wider font-grotesk" style={{ color: 'var(--mute)' }}>Password</label>
                <input id="setup-password" className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters" required minLength={6} />
              </div>
              {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5 anim-fadeIn">{err}</div>}
              <BorderGlow borderRadius={9999} glowRadius={22} className="w-full block">
                <button className="btn-primary w-full !py-3" disabled={busy}>
                  {busy ? 'Setting up…' : 'Create my gym'}
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
