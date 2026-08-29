import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useFetch, formatDate } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

export default function Gyms() {
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const { data, loading, error } = useFetch(() => api(`/console/gyms${search ? `?search=${encodeURIComponent(search)}` : ''}`), [search]);
  const toast = useToast();
  const nav = useNavigate();

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/export/gyms', 'gyms.csv'); toast.success('Gyms CSV downloaded'); }
    catch (e) { toast.error(e.message || 'Export failed'); }
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
        <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Preparing CSV…' : 'Export CSV'}</button>
      </div>

      {loading && <div className="card"><SkeletonRows rows={6} cols={5} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.gyms.length && (
        <div className="card"><EmptyState icon="gyms" title="No gyms yet" description={search ? 'No gym matches that search.' : 'Gyms that sign up will appear here.'} /></div>
      )}

      {data && data.gyms.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Gym</th><th>Status</th><th className="num">Clients</th><th className="num">Trainers</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.gyms.map((g) => (
                <tr key={g.id} className="row-link" onClick={() => nav(`/gyms/${g.id}`)}>
                  <td><Link to={`/gyms/${g.id}`} onClick={(e) => e.stopPropagation()}>{g.name}</Link></td>
                  <td><StatusBadge status={g.billing_status} /></td>
                  <td className="num">{g.client_count}</td>
                  <td className="num">{g.trainer_count}</td>
                  <td className="faint">{formatDate(g.created_at)}</td>
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
