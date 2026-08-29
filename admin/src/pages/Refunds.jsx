import { useState } from 'react';
import { api, downloadCsv } from '../api.js';
import { useFetch, money, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const STATUS_TONE = { SUCCESS: 'good', PROCESSING: 'warn', REQUESTED: 'mute', FAILED: 'bad', CANCELLED: 'mute' };

export default function Refunds() {
  const [status, setStatus] = useState('');
  const { data, loading, error } = useFetch(() => api(`/console/refunds${status ? `?status=${status}` : ''}`), [status]);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/export/refunds', 'refunds.csv'); toast.success('Refunds CSV downloaded'); }
    catch (e) { toast.error(e.message || 'Export failed'); }
    finally { setExporting(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Refunds</h1>
        <p>Every SK OS package refund issued to a gym, platform-wide, newest first.</p>
      </div>

      <div className="search-row" style={{ justifyContent: 'space-between' }}>
        <select className="input" style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['SUCCESS', 'PROCESSING', 'REQUESTED', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Preparing CSV…' : 'Export Refunds CSV'}</button>
      </div>

      {loading && <div className="card"><SkeletonRows rows={6} cols={6} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.refunds.length && (
        <div className="card">
          <EmptyState icon="refunds" title="No refunds yet" description="Refund activity across every gym will appear here as it happens." />
        </div>
      )}

      {data && data.refunds.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Gym</th><th>Type</th><th className="num">Amount</th><th>Status</th><th>Reason</th><th>Requested by</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.refunds.map((r) => (
                <tr key={r.id}>
                  <td>{r.org_name}</td>
                  <td className="faint">{r.type}</td>
                  <td className="num">{money(r.amount)} {r.currency}</td>
                  <td><span className={`badge ${STATUS_TONE[r.status] || 'mute'}`}>{r.status}</span></td>
                  <td className="faint">{r.reason || '—'}</td>
                  <td className="faint">{r.initiated_by_name || '—'}</td>
                  <td className="faint">{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
