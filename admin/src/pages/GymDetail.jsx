import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, money } from '../utils.js';
import { StatusBadge } from './Gyms.jsx';

export default function GymDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(() => api(`/console/gyms/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundConfirm, setRefundConfirm] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundError, setRefundError] = useState('');

  const doSuspend = async () => {
    if (confirmText !== 'SUSPEND GYM') return;
    setBusy(true);
    try { await api(`/console/gyms/${id}/suspend`, { method: 'POST', body: JSON.stringify({}) }); setConfirmText(''); reload(); }
    finally { setBusy(false); }
  };
  const doReactivate = async () => {
    setBusy(true);
    try { await api(`/console/gyms/${id}/reactivate`, { method: 'POST' }); reload(); }
    finally { setBusy(false); }
  };
  // Full refund only, by design -- a partial refund (a goodwill/price
  // adjustment) never cancels the subscription server-side either way
  // (see refunds.js), so offering an amount field here would suggest a
  // control this screen doesn't actually need: the platform operator's
  // one real decision at this screen is "give this gym's whole package
  // payment back and end their subscription", not fine-grained pricing.
  const doRefund = async () => {
    if (refundConfirm !== 'REFUND PACKAGE' || !subscription?.payment_order_id) return;
    setBusy(true); setRefundError('');
    try {
      await api(`/console/gyms/${id}/payments/${subscription.payment_order_id}/refund`, { method: 'POST', body: JSON.stringify({ reason: refundReason || undefined }) });
      setRefundOpen(false); setRefundConfirm(''); setRefundReason('');
      reload();
    } catch (e) { setRefundError(e.data?.message || e.message || 'Refund failed'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="spinner-row">Loading…</div>;
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
          <dt>Created</dt><dd>{String(org.created_at).slice(0, 10)}</dd>
          <dt>Type</dt><dd>{org.type}</dd>
        </dl>
      </div>

      {subscription && (
        <div className="card">
          <h2>Subscription</h2>
          <dl className="kv">
            <dt>Capacity</dt><dd>{subscription.client_capacity} clients</dd>
            <dt>Price</dt><dd>{money(subscription.price)} {subscription.currency}</dd>
            <dt>Valid until</dt><dd>{String(subscription.end_date || '').slice(0, 10) || '—'}</dd>
          </dl>
          {subscription.status === 'ACTIVE' && subscription.payment_order_id && (
            refundOpen ? (
              <div style={{ marginTop: 12 }}>
                <p className="faint">Refunds the gym's own package payment and ends this subscription (billing state → CANCELLED). Existing clients, trainers, and workout data are untouched. Type <strong>REFUND PACKAGE</strong> to confirm.</p>
                <input className="input" placeholder="Reason (optional)" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} style={{ marginBottom: 8 }} />
                <div style={{ display: 'flex', gap: 8, maxWidth: 360 }}>
                  <input className="input" value={refundConfirm} onChange={(e) => setRefundConfirm(e.target.value)} placeholder="REFUND PACKAGE" />
                  <button className="btn danger" onClick={doRefund} disabled={busy || refundConfirm !== 'REFUND PACKAGE'}>Refund</button>
                  <button className="btn" onClick={() => { setRefundOpen(false); setRefundConfirm(''); setRefundError(''); }} disabled={busy}>Cancel</button>
                </div>
                {refundError && <p className="error-text">{refundError}</p>}
              </div>
            ) : (
              <button className="btn danger" style={{ marginTop: 12 }} onClick={() => setRefundOpen(true)}>Refund this package</button>
            )
          )}
        </div>
      )}

      <div className="card">
        <h2>Actions</h2>
        {billing?.status === 'SUSPENDED' ? (
          <button className="btn" onClick={doReactivate} disabled={busy}>Reactivate gym</button>
        ) : (
          <>
            <p className="faint">Type <strong>SUSPEND GYM</strong> to confirm -- this is a destructive, platform-wide action.</p>
            <div style={{ display: 'flex', gap: 8, maxWidth: 360 }}>
              <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="SUSPEND GYM" />
              <button className="btn danger" onClick={doSuspend} disabled={busy || confirmText !== 'SUSPEND GYM'}>Suspend</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
