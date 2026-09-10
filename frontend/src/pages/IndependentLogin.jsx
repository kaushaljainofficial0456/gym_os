import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../themeContext.jsx';
import SplashCursorLazy from '../components/SplashCursorLazy.jsx';
import { loadGoogleIdentity } from '../googleIdentity.js';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// "Independent client" on the login screen -- no gym, no gym code, so the
// gym-code SignUp.jsx flow doesn't apply. One-tap identity via Google
// instead: the backend (POST /auth/google) verifies the token and finds-or-
// creates a CLIENT account under the shared "Independent Clients" org,
// which has gym-only features (live crowd, a human trainer to message)
// turned off at the data level -- see backend/src/routes/auth.js.
export default function IndependentLogin() {
  const { loginWithGoogle } = useAuth();
  const nav = useNavigate();
  const { theme } = useTheme();
  const btnRef = useRef(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return; // nothing to initialize -- see the config notice below
    let cancelled = false;

    const handleCredential = async (response) => {
      setBusy(true); setErr('');
      try {
        await loginWithGoogle(response.credential);
        nav('/app/client');
      } catch (ex) { setErr(ex.message); setBusy(false); }
    };

    loadGoogleIdentity().then(() => {
      if (cancelled) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredential,
        auto_select: false,
      });
      if (btnRef.current) {
        // filled_black reads correctly on our dark canvas; outline is the
        // one GIS theme that doesn't fight our light mode's own pale ground.
        window.google.accounts.id.renderButton(btnRef.current, {
          type: 'standard',
          theme: theme === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          logo_alignment: 'left',
          width: 320,
        });
      }
      setReady(true);
    }).catch((ex) => setErr(ex.message));

    return () => { cancelled = true; };
    // theme is intentionally included: GIS bakes the theme into the
    // rendered button at renderButton() time, so a toggle mid-visit needs
    // a fresh render, not just a restyle.
  }, [theme]);

  return (
    <>
      <SplashCursorLazy />

      <div className="min-h-screen grid lg:grid-cols-2" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
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
              No gym.<br />No problem.<br />
              <span className="bg-gradient-to-r from-ember to-gold bg-clip-text text-transparent">Train on your own.</span>
            </h1>
            <p className="text-sm mt-5 max-w-sm leading-relaxed" style={{ color: 'var(--mute)' }}>
              Full workout and nutrition tracking, built for training solo — no gym code needed,
              no live crowd or trainer inbox cluttering it up.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center p-6">
          <div className="w-full max-w-sm anim-fadeUp text-center">
            <div className="lg:hidden flex items-center justify-center gap-3 mb-8">
              <img src="/logo.png" alt="SK OS" className="w-11 h-11 rounded-xl" />
              <div className="text-left">
                <div className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>SK OS</div>
                <div className="text-[9px] uppercase tracking-[.2em] font-grotesk" style={{ color: 'var(--mute)' }}>Your fitness business, engineered.</div>
              </div>
            </div>

            <h2 className="font-display font-bold text-2xl tracking-tight mb-1" style={{ color: 'var(--ink)' }}>Train independently</h2>
            <p className="text-sm mb-8" style={{ color: 'var(--mute)' }}>One tap with Google — no gym code, no password to remember.</p>

            {!GOOGLE_CLIENT_ID ? (
              <div role="alert" className="field-error text-left">
                Google sign-in isn't configured yet on this deployment — <code className="font-mono">VITE_GOOGLE_CLIENT_ID</code> is missing.
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <div ref={btnRef} className="min-h-[44px]" />
                {!ready && !err && <div className="text-xs" style={{ color: 'var(--faint)' }}>Loading…</div>}
                {busy && <div className="text-xs" style={{ color: 'var(--mute)' }}>Signing you in…</div>}
              </div>
            )}
            {err && <div role="alert" className="field-error mt-4 anim-fadeIn text-left">{err}</div>}

            <div className="mt-8 text-sm" style={{ color: 'var(--mute)' }}>
              Part of a gym?{' '}
              <Link to="/login" className="font-semibold" style={{ color: 'var(--accent)' }}>Go back</Link>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
