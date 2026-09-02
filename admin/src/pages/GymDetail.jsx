import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, money, formatDate } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { SkeletonBlock } from '../components/Skeleton.jsx';
import { StatusBadge } from './Gyms.jsx';

const REFUND_STATUS_TONE = { SUCCESS: 'good', PROCESSING: 'warn', REQUESTED: 'mute', FAILED: 'bad', CANCELLED: 'mute' };

function RefundHistory({ orgId, orderId }) {
  const { data, loading } = useFetch(() => api(`/console/gyms/${orgId}/payments/${orderId}/refunds`), [orgId, orderId]);
  if (loading) return <SkeletonBlock height={60} />;
  const refunds = data?.refunds || [];
  if (!refunds.length) return <p className="faint" style={{ margin: '10px 0 0' }}>No refunds issued against this payment yet.</p>;

  const totalRefunded = refunds.filter((r) => r.status === 'SUCCESS').reduce((sum, r) => sum + Number(r.amount), 0);

  return (
    <div style={{ marginTop: 14 }}>
      <div className="kv" style={{ marginBottom: 10 }}>
        <dt>Refunds</dt><dd>{refunds.length}</dd>
        <dt>Total refunded</dt><dd className="mono-num">{money(totalRefunded)}</dd>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th className="num">Amount</th><th>Status</th><th>Reason</th></tr></thead>
          <tbody>
            {refunds.map((r) => (
              <tr key={r.id}>
                <td className="faint">{formatDate(r.created_at)}</td>
                <td className="faint">{r.type}</td>
                <td className="num">{money(r.amount)}</td>
                <td>
                  <span className={`badge ${REFUND_STATUS_TONE[r.status] || 'mute'}`}>{r.status}</span>
                  {r.status === 'FAILED' && r.failure_reason && <div className="faint" style={{ marginTop: 2 }}>{r.failure_reason}</div>}
                </td>
                <td className="faint">{r.reason || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function GymDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(() => api(`/console/gyms/${id}`), [id]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundError, setRefundError] = useState('');

  const doSuspend = async () => {
    setBusy(true);
    try {
      await api(`/console/gyms/${id}/suspend`, { method: 'POST', body: JSON.stringify({}) });
      setSuspendOpen(false); reload({ silent: true }); toast.success('Gym suspended');
    } catch (e) { toast.error(e.message || 'Suspend failed'); }
    finally { setBusy(false); }
  };
  const doReactivate = async () => {
    setBusy(true);
    try { await api(`/console/gyms/${id}/reactivate`, { method: 'POST' }); reload({ silent: true }); toast.success('Gym reactivated'); }
    catch (e) { toast.error(e.message || 'Reactivate failed'); }
    finally { setBusy(false); }
  };
  // Full refund only, by design -- a partial refund (a goodwill/price
  // adjustment) never cancels the subscription server-side either way
  // (see refunds.js), so offering an amount field here would suggest a
  // control this screen doesn't actually need: the platform operator's
  // one real decision at this screen is "give this gym's whole package
  // payment back and end their subscription", not fine-grained pricing.
  const doRefund = async () => {
    if (!subscription?.payment_order_id) return;
    setBusy(true); setRefundError('');
    try {
      const result = await api(`/console/gyms/${id}/payments/${subscription.payment_order_id}/refund`, { method: 'POST', body: JSON.stringify({ reason: refundReason || undefined }) });
      setRefundOpen(false); setRefundReason('');
      reload({ silent: true });
      toast.success(`Refunded ${money(result.refund.amount)}`);
    } catch (e) { setRefundError(e.message || 'Refund failed'); }
    finally { setBusy(false); }
  };

  if (loading) return <div><SkeletonBlock height={110} /><div style={{ height: 14 }} /><SkeletonBlock height={180} /></div>;
  if (error) return <div className="error-text">{error.message}</div>;
  if (!data) return null;

  const { org, billing, subscription, owner, branches, clientCount, trainerCount } = data;

  return (
    <div>
      <div className="page-header">
        <Link to="/gyms" className="faint">← Gyms</Link>
        <h1 style={{ marginTop: 6 }}>{org.name}</h1>
        <p>{org.slug}</p>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card"><div className="label">Status</div><div className="value" style={{ fontSize: 18 }}><StatusBadge status={billing?.status} /></div></div>
        <div className="kpi-card"><div className="label">Clients</div><div className="value">{clientCount}</div></div>
        <div className="kpi-card"><div className="label">Trainers</div><div className="value">{trainerCount}</div></div>
        <div className="kpi-card"><div className="label">Branches</div><div className="value">{branches?.length ?? 0}</div></div>
      </div>

      <div className="card">
        <h2>Profile</h2>
        <dl className="kv">
          <dt>Owner</dt><dd>{owner ? `${owner.name} (${owner.email})` : <span className="muted">No owner found</span>}</dd>
          <dt>Created</dt><dd>{formatDate(org.created_at)}</dd>
          <dt>Type</dt><dd>{org.type}</dd>
        </dl>
      </div>

      {subscription && (
        <div className="card">
          <h2>Subscription &amp; payments</h2>
          <dl className="kv">
            <dt>Capacity</dt><dd>{subscription.client_capacity} clients</dd>
            <dt>Price</dt><dd>{money(subscription.price)} {subscription.currency}</dd>
            <dt>Valid until</dt><dd>{formatDate(subscription.end_date) === '—' ? '—' : formatDate(subscription.end_date)}</dd>
          </dl>

          {subscription.payment_order_id && <RefundHistory orgId={id} orderId={subscription.payment_order_id} />}

          {subscription.status === 'ACTIVE' && subscription.payment_order_id && (
            <button className="btn danger" style={{ marginTop: 14 }} onClick={() => { setRefundOpen(true); setRefundError(''); }}>Refund this package</button>
          )}
        </div>
      )}

      <div className="card">
        <h2>Actions</h2>
        {billing?.status === 'SUSPENDED' ? (
          <button className="btn" onClick={doReactivate} disabled={busy}>Reactivate gym</button>
        ) : (
          <>
            <p className="faint">Suspends this gym platform-wide -- a destructive action, confirmed before it runs.</p>
            <button className="btn danger" onClick={() => setSuspendOpen(true)}>Suspend gym</button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={suspendOpen}
        title="Suspend this gym?"
        description={`${org.name} will lose access platform-wide until reactivated. Existing client/trainer data is untouched.`}
        confirmLabel="Suspend"
        confirmText="SUSPEND"
        busy={busy}
        onConfirm={doSuspend}
        onCancel={() => setSuspendOpen(false)}
      />

      <ConfirmDialog
        open={refundOpen}
        title="Refund this package?"
        description="Refunds the gym's own package payment in full and ends this subscription (billing state → CANCELLED). Existing clients, trainers, and workout data are untouched."
        confirmLabel="Refund"
        confirmText="REFUND"
        busy={busy}
        onConfirm={doRefund}
        onCancel={() => { setRefundOpen(false); setRefundError(''); }}
      >
        <div className="field">
          <label>Reason (optional)</label>
          <input className="input" placeholder="e.g. duplicate charge" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
        </div>
        {refundError && <p className="error-text" style={{ marginTop: -8 }}>{refundError}</p>}
      </ConfirmDialog>
    </div>
  );
}
