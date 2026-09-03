// ============================================================
// CLIENT MEMBERSHIP — plan, status, dates, payment history, renew.
// ============================================================
import { useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, PageHeader, Spinner, ErrorState, Empty, Modal } from '../../components/UI.jsx';
import PaymentCheckout from '../../components/PaymentCheckout.jsx';

const STATUS_TONE = {
  ACTIVE: 'text-good border-good/40 bg-good/10', PAUSED: 'text-warn border-warn/40 bg-warn/10',
  SUSPENDED: 'text-warn border-warn/40 bg-warn/10', EXPIRED: 'text-bad border-bad/40 bg-bad/10',
  CANCELLED: 'text-mute border-line bg-white/5', REFUNDED: 'text-mute border-line bg-white/5',
};

export default function Membership() {
  const membership = useFetch(() => api('/enrollment/client/membership'));
  const [order, setOrder] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);

  const startRenew = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api('/enrollment/client/renew', { method: 'POST' });
      setOrder(res.order);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const onPaid = async (paymentId, signature) => {
    setBusy(true); setErr('');
    try {
      await api('/enrollment/client/payment/verify', { method: 'POST', body: JSON.stringify({ orderId: order.id, providerPaymentId: paymentId, signature }) });
      setOrder(null); setDone(true);
      // silent: true -- a bare reload() here would flip membership.loading
      // back to true and this page's own gate (below) would swap the
      // whole page to a spinner right as `done` is trying to show a
      // success screen. Same class of bug already fixed for Nutrition.jsx.
      membership.reload({ silent: true });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (membership.loading) return <Spinner label="Loading your membership…" />;
  if (membership.error) return <ErrorState error={membership.error} onRetry={membership.reload} />;
  const m = membership.data?.membership;

  if (!m) return <Empty title="No membership yet" hint="Once you join a gym, your plan and renewal will show up here." />;

  const daysLeft = Math.ceil((Date.parse(m.end_date) - Date.now()) / 86_400_000);
  const canRenew = ['ACTIVE', 'EXPIRED'].includes(m.lifecycle_status || 'ACTIVE');

  return (
    <div className="space-y-6 max-w-lg">
      <PageHeader title="Membership" sub={membership.data.gym?.name} />

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-grotesk font-bold text-lg">{m.plan_name}</div>
          <span className={`chip border ${STATUS_TONE[m.lifecycle_status] || 'text-good border-good/40 bg-good/10'}`}>{m.lifecycle_status || 'ACTIVE'}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Started</div>{new Date(m.start_date).toLocaleDateString()}</div>
          <div><div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>{daysLeft >= 0 ? 'Expires' : 'Expired'}</div>{new Date(m.end_date).toLocaleDateString()}</div>
        </div>
        {daysLeft >= 0 && daysLeft <= 7 && <div className="text-xs text-warn">Expires in {daysLeft} day{daysLeft === 1 ? '' : 's'} — renew below to keep your access.</div>}
        {daysLeft < 0 && <div className="text-xs text-bad">This membership has expired.</div>}
      </Card>

      {err && <div className="text-xs text-bad bg-bad/10 border border-bad/30 rounded-xl px-3 py-2.5">{err}</div>}
      {done && <div className="text-xs text-good bg-good/10 border border-good/30 rounded-xl px-3 py-2.5">Renewed! Your new expiry is reflected above.</div>}

      {canRenew && (
        <button className="btn-primary" disabled={busy} onClick={startRenew}>{busy ? 'Preparing…' : 'Renew membership'}</button>
      )}

      <Modal open={!!order} onClose={() => setOrder(null)} title="Renew membership">
        {order && <PaymentCheckout order={order} onComplete={onPaid} onCancel={() => setOrder(null)} />}
      </Modal>
    </div>
  );
}
