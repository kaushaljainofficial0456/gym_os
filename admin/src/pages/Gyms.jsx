import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useFetch } from '../utils.js';

export default function Gyms() {
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const { data, loading, error } = useFetch(() => api(`/console/gyms${search ? `?search=${encodeURIComponent(search)}` : ''}`), [search]);

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/export/gyms', 'gyms.csv'); }
    finally { setExporting(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Gyms</h1>
        <p>Every gym organization on the platform.</p>
      </div>

      <div className="search-row" style={{ justifyContent: 'space-between' }}>
        <input className="input" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.gyms.length && <div className="empty-state">No gyms yet.</div>}

      {data && data.gyms.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr><th>Gym</th><th>Status</th><th>Clients</th><th>Trainers</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.gyms.map((g) => (
                <tr key={g.id}>
                  <td><Link to={`/gyms/${g.id}`}>{g.name}</Link></td>
                  <td><StatusBadge status={g.billing_status} /></td>
                  <td>{g.client_count}</td>
                  <td>{g.trainer_count}</td>
                  <td className="faint">{String(g.created_at).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StatusBadge({ status }) {
  const tone = { ACTIVE: 'good', SETUP: 'mute', PAYMENT_PENDING: 'warn', SUSPENDED: 'bad', EXPIRED: 'bad', CANCELLED: 'mute' }[status] || 'mute';
  return <span className={`badge ${tone}`}>{status || 'UNKNOWN'}</span>;
}
