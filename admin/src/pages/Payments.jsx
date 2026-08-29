import { useState } from 'react';
import { api, downloadCsv } from '../api.js';
import { useFetch, money, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const STATUS_TONE = { SUCCESS: 'good', CREATED: 'mute', PENDING: 'warn', PROCESSING: 'warn', FAILED: 'bad', CANCELLED: 'mute', EXPIRED: 'mute', DISPUTED: 'bad', REFUNDED: 'warn', PARTIALLY_REFUNDED: 'warn' };

export default function Payments() {
  const { data, loading, error } = useFetch(() => api('/console/payments'));
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/export/payments', 'payments.csv'); toast.success('Payments CSV downloaded'); }
    catch (e) { toast.error(e.message || 'Export failed'); }
    finally { setExporting(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Payments</h1>
        <p>Every payment order across every gym, newest first.</p>
      </div>

      <div className="search-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Preparing CSV…' : 'Export CSV'}</button>
      </div>

      {loading && <div className="card"><SkeletonRows rows={6} cols={6} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.payments.length && (
        <div className="card"><EmptyState icon="payments" title="No payments yet" description="Payment orders across every gym will appear here." /></div>
      )}

      {data && data.payments.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Gym</th><th>Type</th><th className="num">Amount</th><th>Provider</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.org_name}</td>
                  <td className="faint">{p.subject_type}</td>
                  <td className="num">{money(p.amount)} {p.currency}</td>
                  <td className="faint">{p.provider}</td>
                  <td><span className={`badge ${STATUS_TONE[p.status] || 'mute'}`}>{p.status}</span></td>
                  <td className="faint">{formatDateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
