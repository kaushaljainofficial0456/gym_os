import { api } from '../api.js';
import { useFetch } from '../utils.js';

export default function AuditLog() {
  const { data, loading, error } = useFetch(() => api('/console/audit'));

  return (
    <div>
      <div className="page-header">
        <h1>Audit Log</h1>
        <p>Every sensitive Admin Console action, immutable and append-only.</p>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.logs.length && <div className="empty-state">No admin actions recorded yet.</div>}

      {data && data.logs.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr><th>Admin</th><th>Action</th><th>Entity</th><th>When</th></tr>
            </thead>
            <tbody>
              {data.logs.map((l) => (
                <tr key={l.id}>
                  <td>{l.admin_name}<div className="faint">{l.admin_email}</div></td>
                  <td>{l.action}</td>
                  <td className="faint">{l.entity_type ? `${l.entity_type}:${l.entity_id}` : '—'}</td>
                  <td className="faint">{String(l.created_at).slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
