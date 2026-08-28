import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch } from '../utils.js';

const STATUS_TONE = { OPEN: 'warn', IN_PROGRESS: 'warn', WAITING_FOR_GYM: 'mute', RESOLVED: 'good', CLOSED: 'mute' };
const PRIORITY_TONE = { LOW: 'mute', MEDIUM: 'mute', HIGH: 'warn', URGENT: 'bad' };

export default function Support() {
  const [status, setStatus] = useState('');
  const { data, loading, error } = useFetch(() => api(`/console/support${status ? `?status=${status}` : ''}`), [status]);

  return (
    <div>
      <div className="page-header">
        <h1>Support</h1>
        <p>Every ticket across every gym.</p>
      </div>

      <div className="search-row">
        <select className="input" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="WAITING_FOR_GYM">Waiting for gym</option>
          <option value="RESOLVED">Resolved</option>
          <option value="CLOSED">Closed</option>
        </select>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.tickets.length && <div className="empty-state">No tickets.</div>}

      {data && data.tickets.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Subject</th><th>Gym</th><th>Category</th><th>Priority</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {data.tickets.map((t) => (
                <tr key={t.id}>
                  <td><Link to={`/support/${t.id}`}>{t.subject}</Link></td>
                  <td className="faint">{t.org_name}</td>
                  <td className="faint">{t.category}</td>
                  <td><span className={`badge ${PRIORITY_TONE[t.priority] || 'mute'}`}>{t.priority}</span></td>
                  <td><span className={`badge ${STATUS_TONE[t.status] || 'mute'}`}>{t.status}</span></td>
                  <td className="faint">{String(t.updated_at).slice(0, 16).replace('T', ' ')}</td>
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
