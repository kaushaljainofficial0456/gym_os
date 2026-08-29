import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

// User-supplied full-bleed background video for the login screen only
// (2026-08-29) -- hosted on the user's own Cloudflare R2 bucket.
// Autoplay requires muted + playsInline for browsers to allow it
// without a user gesture; loop keeps it running for however long the
// login screen is up.
const LOGIN_VIDEO_URL = 'https://pub-86dc5b5484314368ac5436a674b0d919.r2.dev/cloudinarry%20to%20cloudflare/202606021731-e_hqa6sn.mp4';

export default function Login() {
  const { authed, ready, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (ready && authed) return <Navigate to="/" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <video className="login-video" src={LOGIN_VIDEO_URL} autoPlay muted loop playsInline aria-hidden="true" />
      <div className="login-scrim" aria-hidden="true" />
      <div className="login-box anim-scaleIn">
        <h1>SK OS Admin Console</h1>
        <p className="login-sub">Platform operator access only.</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input className="input-ghost" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input-ghost" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <div className={`error-text ${error ? 'anim-shake' : ''}`}>{error}</div>}
        </form>
      </div>
    </div>
  );
}
