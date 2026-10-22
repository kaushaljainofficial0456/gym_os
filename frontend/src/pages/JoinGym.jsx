// ============================================================
// JOIN GYM — where a CLIENT or TRAINER with no org yet (see App.jsx's
// needsGymJoin) scans their gym's enrollment QR. Three stages:
// scan -> preview (no commitment yet) -> join (+pay, for a client).
// ============================================================
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScanLine } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import QrScanner from '../components/QrScanner.jsx';
import PaymentCheckout from '../components/PaymentCheckout.jsx';
import { Spinner } from '../components/UI.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import '../components/auth/auth-flow.css';
import { AuthTitle, Cta, ErrorNote } from '../components/auth/authKit.jsx';

const HEADLINE = [{ text: 'One scan.' }, { text: "You're in.", accent: true }];

function Done({ title, sub }) {
  return (
    <div className="auth-view text-center">
      <svg className="auth-done" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="29" pathLength="1" />
        <path d="M20 33.5 28.5 42 45 24" pathLength="1" />
      </svg>
      <h1 className="auth-title">{title}</h1>
      <p className="auth-sub">{sub}</p>
    </div>
  );
}

export default function JoinGym() {
  const { user, refreshSession, logout } = useAuth();
  const nav = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [payload, setPayload] = useState('');
  const [preview, setPreview] = useState(null);
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const isClient = user?.role === 'CLIENT';

  const onScanned = async (value) => {
    setScanning(false);
    setPayload(value);
    setErr(''); setBusy(true);
    try {
      const p = await api('/enrollment/preview', { method: 'POST', body: JSON.stringify({ payload: value }) });
      if (p.purpose !== user.role) {
        setErr(`This QR code is for a ${p.purpose.toLowerCase()} — you're signed in as a ${user.role.toLowerCase()}.`);
        return;
      }
      setPreview(p);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const join = async () => {
    setBusy(true); setErr('');
    try {
      if (isClient) {
        const res = await api('/enrollment/client/join', { method: 'POST', body: JSON.stringify({ payload }) });
        // A FREE membership has no payment step at all -- the server has
        // already enrolled them. Without this branch the screen sat on the
        // join prompt showing neither a payment sheet nor a success state,
        // so a member who WAS enrolled looked like a failed scan.
        if (res.free) {
          if (res.token) await refreshSession(res.token);
          setDone(true);
          setTimeout(() => nav('/app/client', { replace: true }), 1400);
          return;
        }
        setOrder(res.order);
      } else {
        const res = await api('/enrollment/trainer/join', { method: 'POST', body: JSON.stringify({ payload }) });
        await refreshSession(res.token);
        setDone(true);
        // Signal TrainerLayout to start the guided app tour on next render.
        // Consumed once by TrainerLayout and cleared immediately.
        localStorage.setItem('sk-os-start-tour-next', '1');
        setTimeout(() => nav('/app/trainer', { replace: true }), 1400);
      }
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onPaid = async (paymentId, signature) => {
    setBusy(true); setErr('');
    try {
      const res = await api('/enrollment/client/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: order.id, providerPaymentId: paymentId, signature }) });
      if (res.token) await refreshSession(res.token);
      setDone(true);
      setTimeout(() => nav('/app/client', { replace: true }), 1400);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const plan = preview?.membershipPlan;

  return (
    <AuthShell variant="compact" headline={HEADLINE} showcase={isClient ? 'member' : 'coach'}>
      {done ? (
        <Done title="You're in." sub={`Welcome to ${preview?.gym?.name || 'your gym'}. Taking you to your dashboard…`} />
      ) : order ? (
        <div className="auth-view">
          <AuthTitle eyebrow={preview?.gym?.name} title="Complete your membership" sub={plan?.name} onBack={() => setOrder(null)} />
          <PaymentCheckout order={order} orgName={preview?.gym?.name} onComplete={onPaid} />
          {err && <div className="mt-4"><ErrorNote>{err}</ErrorNote></div>}
        </div>
      ) : preview ? (
        <div className="auth-view">
          <AuthTitle eyebrow="Your gym" title={preview.gym.name} />
          {plan && (
            <dl className="auth-facts">
              <div><dt>Membership</dt><dd>{plan.name}</dd></div>
              <div><dt>Price</dt><dd>₹{Number(plan.amount).toLocaleString('en-IN')}</dd></div>
              <div><dt>Length</dt><dd>{plan.period_days} days</dd></div>
            </dl>
          )}
          <ErrorNote>{err}</ErrorNote>
          <Cta busy={busy} onClick={join}>{isClient && plan ? 'Continue to payment' : 'Join this gym'}</Cta>
          <button type="button" className="auth-ghost mt-3" onClick={() => { setPreview(null); setPayload(''); setErr(''); }}>
            Scan a different code
          </button>
        </div>
      ) : (
        <>
          <AuthTitle eyebrow={user?.name ? `Hi ${user.name.split(' ')[0]}` : undefined} title="Join your gym"
            sub="Scan the QR code your gym gave you." />
          <button type="button" className="auth-qr" onClick={() => setScanning(true)} disabled={busy} aria-label="Scan QR code">
            {busy ? <Spinner /> : <ScanLine size={30} strokeWidth={1.3} aria-hidden="true" />}
            <span className="auth-qr__sweep" aria-hidden="true" />
          </button>
          <ErrorNote>{err}</ErrorNote>
          <Cta onClick={() => setScanning(true)} disabled={busy}>Scan QR code</Cta>
        </>
      )}

      {!done && (
        <p className="auth-foot"><button type="button" onClick={logout}>Not now — sign out</button></p>
      )}

      <QrScanner open={scanning} onClose={() => setScanning(false)} onScanned={onScanned} />
    </AuthShell>
  );
}
