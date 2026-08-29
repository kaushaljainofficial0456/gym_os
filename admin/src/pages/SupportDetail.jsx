import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import { SkeletonBlock } from '../components/Skeleton.jsx';
import PriorityBadge from '../components/PriorityBadge.jsx';
import { STATUS_TONE } from './Support.jsx';

export default function SupportDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(() => api(`/console/support/${id}`), [id]);
  const admins = useFetch(() => api('/console/admins'));
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await api(`/console/support/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: reply, internal }) });
      setReply(''); setInternal(false); reload();
      toast.success(internal ? 'Internal note added' : 'Reply sent');
    } catch (e) { toast.error(e.message || 'Could not send'); }
    finally { setBusy(false); }
  };

  const setStatus = async (status) => {
    try { await api(`/console/support/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); reload(); toast.success(`Status set to ${status}`); }
    catch (e) { toast.error(e.message || 'Could not update status'); }
  };

  const setPriority = async (priority) => {
    setPriorityBusy(true);
    try { await api(`/console/support/${id}/priority`, { method: 'POST', body: JSON.stringify({ priority }) }); reload(); toast.success(`Priority set to ${priority}`); }
    catch (e) { toast.error(e.message || 'Could not update priority'); }
    finally { setPriorityBusy(false); }
  };

  const setAssignee = async (adminId) => {
    setAssignBusy(true);
    try {
      await api(`/console/support/${id}/assign`, { method: 'POST', body: JSON.stringify({ adminId: adminId || null }) });
      reload();
      toast.success(adminId ? 'Ticket assigned' : 'Ticket unassigned');
    } catch (e) { toast.error(e.message || 'Could not update assignment'); }
    finally { setAssignBusy(false); }
  };

  if (loading) return <div><SkeletonBlock height={80} /><div style={{ height: 14 }} /><SkeletonBlock height={220} /></div>;
  if (error) return <div className="error-text">{error.message}</div>;
  if (!data) return null;
  const { ticket, messages } = data;
  const assignedAdmin = admins.data?.admins?.find((a) => a.id === ticket.assigned_admin_id);

  return (
    <div>
      <div className="page-header">
        <Link to="/support" className="faint">← Support</Link>
        <h1 style={{ marginTop: 6 }}>{ticket.subject}</h1>
        <p>
          <PriorityBadge priority={ticket.priority} />{' '}
          <span className={`badge ${STATUS_TONE[ticket.status] || 'mute'}`}>{ticket.status}</span>{' '}
          <span className="faint">{ticket.category} · {ticket.org_name}</span>
        </p>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <h2>Status</h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['OPEN', 'IN_PROGRESS', 'WAITING_FOR_GYM', 'RESOLVED', 'CLOSED'].map((s) => (
                <button key={s} className="btn ghost" disabled={s === ticket.status} onClick={() => setStatus(s)}>{s}</button>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Conversation</h2>
            {messages.map((m) => (
              <div key={m.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="faint">
                  {m.author_name} ({m.author_role}) · {formatDateTime(m.created_at)}
                  {!!m.internal && <span className="badge warn" style={{ marginLeft: 8 }}>Internal note</span>}
                </div>
                <div style={{ marginTop: 4, ...(m.internal ? { background: 'var(--warn-soft)', padding: '8px 10px', borderRadius: 8 } : {}) }}>{m.body}</div>
              </div>
            ))}

            <div style={{ marginTop: 14 }}>
              <textarea className="input" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply, or add an internal note…" />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <label className="faint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  Internal note (never visible to the gym)
                </label>
                <button className="btn" onClick={send} disabled={busy || !reply.trim()}>{busy ? 'Sending…' : internal ? 'Add note' : 'Send reply'}</button>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ position: 'sticky', top: 14 }}>
          <h2>Details</h2>
          <div className="field">
            <label>Priority</label>
            <select className="input" value={ticket.priority} disabled={priorityBusy} onChange={(e) => setPriority(e.target.value)}>
              {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Assigned to</label>
            <select className="input" value={ticket.assigned_admin_id || ''} disabled={assignBusy || admins.loading} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {(admins.data?.admins || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {assignedAdmin && <div className="faint" style={{ marginTop: 6 }}>{assignedAdmin.email}</div>}
          </div>
          <dl className="kv" style={{ marginTop: 16, gridTemplateColumns: '90px 1fr' }}>
            <dt>Gym</dt><dd>{ticket.org_name}</dd>
            <dt>Created</dt><dd>{formatDateTime(ticket.created_at)}</dd>
            <dt>Updated</dt><dd>{formatDateTime(ticket.updated_at)}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
