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
