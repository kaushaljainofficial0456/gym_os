// ============================================================
// JOIN GYM — where a CLIENT or TRAINER with no org yet (see App.jsx's
// needsGymJoin) scans/pastes their gym's enrollment QR. Three stages:
// scan -> preview (no commitment yet) -> join (+pay, for a client).
// ============================================================
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from '../components/Icon.jsx';
import QrScanner from '../components/QrScanner.jsx';
import PaymentCheckout from '../components/PaymentCheckout.jsx';
import { Card, Spinner } from '../components/UI.jsx';

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
      if (user.role === 'CLIENT') {
        const res = await api('/enrollment/client/join', { method: 'POST', body: JSON.stringify({ payload }) });
        setOrder(res.order);
      } else {
        const res = await api('/enrollment/trainer/join', { method: 'POST', body: JSON.stringify({ payload }) });
        await refreshSession(res.token);
        setDone(true);
        // Signal TrainerLayout to start the guided app tour on next render.
        // Consumed once by TrainerLayout and cleared immediately.
        localStorage.setItem('sk-os-start-tour-next', '1');
        setTimeout(() => nav('/app/trainer', { replace: true }), 1200);
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
      setTimeout(() => nav('/app/client', { replace: true }), 1200);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <img src="/logo.png" alt="SK OS" className="w-12 h-12 rounded-xl mx-auto mb-3" />
          <h1 className="font-display font-bold text-xl">Join your gym</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--mute)' }}>
            Hi {user?.name?.split(' ')[0]} — scan the QR code your gym gave you to finish setting up your account.
          </p>
        </div>

        {done ? (
          <Card className="p-8 text-center">
            <div className="text-3xl mb-2">✓</div>
            <div className="font-grotesk font-bold">You're in!</div>
            <div className="text-xs mt-1" style={{ color: 'var(--mute)' }}>Taking you to your dashboard…</div>
          </Card>
        ) : order ? (
          <Card className="p-5 space-y-3">
            <div className="text-sm">{preview?.membershipPlan?.name} at {preview?.gym?.name}</div>
            <PaymentCheckout order={order} orgName={preview?.gym?.name} onComplete={onPaid} />
          </Card>
        ) : preview ? (
          <Card className="p-5 space-y-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Gym</div>
              <div className="font-grotesk font-bold text-lg">{preview.gym.name}</div>
            </div>
            {preview.membershipPlan && (
              <div>
                <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Membership plan</div>
                <div className="font-grotesk font-semibold">{preview.membershipPlan.name} — ₹{preview.membershipPlan.amount}/{preview.membershipPlan.period_days}d</div>
              </div>
            )}
            {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
            <button className="btn-primary w-full !py-3" disabled={busy} onClick={join}>
              {busy ? 'Joining…' : user.role === 'CLIENT' ? 'Continue to payment' : 'Join this gym'}
            </button>
            <button className="btn-ghost w-full" onClick={() => { setPreview(null); setPayload(''); }}>Scan a different code</button>
          </Card>
        ) : (
          <Card className="p-6 text-center space-y-4">
            {busy ? <Spinner /> : (
              <>
                <div className="w-16 h-16 mx-auto rounded-2xl border grid place-items-center" style={{ borderColor: 'var(--line)', background: 'var(--bg2)' }}>
                  <Icon name="camera" size={28} />
                </div>
                {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
                <button className="btn-primary w-full !py-3" onClick={() => setScanning(true)}>Scan QR code</button>
              </>
            )}
          </Card>
        )}

        <div className="text-center">
          <button className="btn-ghost text-xs" onClick={logout}>Not now — sign out</button>
        </div>

        <QrScanner open={scanning} onClose={() => setScanning(false)} onScanned={onScanned} />
      </div>
    </div>
  );
}
