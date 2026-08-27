import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch } from '../utils.js';
import { STATUS_TONE, PRIORITY_TONE } from './Support.jsx';

export default function SupportDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(() => api(`/console/support/${id}`), [id]);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await api(`/console/support/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: reply, internal }) });
      setReply(''); setInternal(false); reload();
    } finally { setBusy(false); }
  };

  const setStatus = async (status) => { await api(`/console/support/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); reload(); };

  if (loading) return <div className="spinner-row">Loading…</div>;
  if (error) return <div className="error-text">{error.message}</div>;
  if (!data) return null;
  const { ticket, messages } = data;

  return (
    <div>
      <div className="page-header">
        <Link to="/support" className="faint">← Support</Link>
        <h1 style={{ marginTop: 6 }}>{ticket.subject}</h1>
        <p>
          <span className={`badge ${PRIORITY_TONE[ticket.priority] || 'mute'}`}>{ticket.priority}</span>{' '}
          <span className={`badge ${STATUS_TONE[ticket.status] || 'mute'}`}>{ticket.status}</span>{' '}
          <span className="faint">{ticket.category}</span>
        </p>
      </div>

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
              {m.author_name} ({m.author_role}) · {String(m.created_at).slice(0, 16).replace('T', ' ')}
              {!!m.internal && <span className="badge warn" style={{ marginLeft: 8 }}>Internal note</span>}
            </div>
            <div style={{ marginTop: 4 }}>{m.body}</div>
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
  );
}
