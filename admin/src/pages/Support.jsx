import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import PriorityBadge from '../components/PriorityBadge.jsx';

const STATUS_TONE = { OPEN: 'warn', IN_PROGRESS: 'warn', WAITING_FOR_GYM: 'mute', RESOLVED: 'good', CLOSED: 'mute' };
const PRIORITY_TONE = { LOW: 'mute', MEDIUM: 'mute', HIGH: 'warn', URGENT: 'bad' };

export default function Support() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const { data, loading, error } = useFetch(() => api(`/console/support${status ? `?status=${status}` : ''}`), [status]);
  const nav = useNavigate();

  const tickets = useMemo(() => {
    const list = data?.tickets || [];
    if (!q.trim()) return list;
    const needle = q.trim().toLowerCase();
    return list.filter((t) => t.subject.toLowerCase().includes(needle) || t.org_name.toLowerCase().includes(needle));
  }, [data, q]);

  return (
    <div>
      <div className="page-header">
        <h1>Support</h1>
        <p>Every ticket across every gym.</p>
      </div>

      <div className="search-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search subject or gym…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="WAITING_FOR_GYM">Waiting for gym</option>
          <option value="RESOLVED">Resolved</option>
          <option value="CLOSED">Closed</option>
        </select>
      </div>

      {loading && <div className="card"><SkeletonRows rows={6} cols={7} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !tickets.length && (
        <div className="card">
          <EmptyState icon="check" title="All clear" description="No support tickets currently require attention." />
        </div>
      )}

      {tickets.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead><tr><th>Subject</th><th>Gym</th><th>Category</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Updated</th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} className="row-link" onClick={() => nav(`/support/${t.id}`)}>
                  <td><Link to={`/support/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.subject}</Link></td>
                  <td className="faint">{t.org_name}</td>
                  <td className="faint">{t.category}</td>
                  <td><PriorityBadge priority={t.priority} /></td>
                  <td><span className={`badge ${STATUS_TONE[t.status] || 'mute'}`}>{t.status}</span></td>
                  <td className="faint">{t.assigned_admin_name || 'Unassigned'}</td>
                  <td className="faint">{formatDateTime(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export { STATUS_TONE, PRIORITY_TONE };
