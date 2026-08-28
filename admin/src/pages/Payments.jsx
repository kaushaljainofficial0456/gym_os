import { useState } from 'react';
import { api, downloadCsv } from '../api.js';
import { useFetch, money } from '../utils.js';

const STATUS_TONE = { SUCCESS: 'good', CREATED: 'mute', PENDING: 'warn', PROCESSING: 'warn', FAILED: 'bad', CANCELLED: 'mute', EXPIRED: 'mute', DISPUTED: 'bad', REFUNDED: 'warn', PARTIALLY_REFUNDED: 'warn' };

export default function Payments() {
  const { data, loading, error } = useFetch(() => api('/console/payments'));
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/console/export/payments', 'payments.csv'); }
    finally { setExporting(false); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Payments</h1>
        <p>Every payment order across every gym, newest first.</p>
      </div>

      <div className="search-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.payments.length && <div className="empty-state">No payments yet.</div>}

      {data && data.payments.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr><th>Gym</th><th>Type</th><th>Amount</th><th>Provider</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.org_name}</td>
                  <td className="faint">{p.subject_type}</td>
                  <td>{money(p.amount)} {p.currency}</td>
                  <td className="faint">{p.provider}</td>
                  <td><span className={`badge ${STATUS_TONE[p.status] || 'mute'}`}>{p.status}</span></td>
                  <td className="faint">{String(p.created_at).slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
