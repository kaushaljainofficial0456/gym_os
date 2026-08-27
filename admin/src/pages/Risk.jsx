import { useState } from 'react';
import { api } from '../api.js';
import { useFetch } from '../utils.js';

const STATUS_TONE = { OPEN: 'warn', REVIEWING: 'warn', RESOLVED: 'good', DISMISSED: 'mute' };
const REASON_LABEL = {
  RAPID_QR_GENERATION: 'Rapid QR generation',
  MULTIPLE_FAILED_PAYMENTS: 'Multiple failed payments',
  UNUSUAL_REFUND_VOLUME: 'Unusual refund volume',
};

export default function Risk() {
  const [status, setStatus] = useState('OPEN');
  const { data, loading, error, reload } = useFetch(() => api(`/console/risk${status ? `?status=${status}` : ''}`), [status]);
  const [scanning, setScanning] = useState(false);
  const [lastSummary, setLastSummary] = useState(null);

  const runScan = async () => {
    setScanning(true);
    try {
      const summary = await api('/console/risk/scan', { method: 'POST' });
      setLastSummary(summary);
      reload();
    } finally {
      setScanning(false);
    }
  };

  const act = async (id, action, extra) => {
    await api(`/console/risk/${id}/${action}`, { method: 'POST', body: JSON.stringify(extra || {}) });
    reload();
  };

  return (
    <div>
      <div className="page-header">
        <h1>Risk</h1>
        <p>Real threshold-based flags from actual data — rapid QR generation, repeated payment failures, unusual refund volume. Flags for review only; nothing here ever auto-suspends or bans an account.</p>
      </div>

      <div className="card">
        <button className="btn" onClick={runScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Run risk scan now'}</button>
        {lastSummary && (
          <p className="faint" style={{ marginTop: 10 }}>
            Rapid QR: {lastSummary.rapidQrGeneration} · Failed payments: {lastSummary.multipleFailedPayments} · Refund volume: {lastSummary.unusualRefundVolume} · New flags: {lastSummary.totalRaised}
          </p>
        )}
      </div>

      <div className="search-row">
        <select className="input" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="OPEN">Open</option>
          <option value="REVIEWING">Reviewing</option>
          <option value="RESOLVED">Resolved</option>
          <option value="DISMISSED">Dismissed</option>
          <option value="">All</option>
        </select>
      </div>

      {loading && <div className="spinner-row">Loading…</div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.events.length && <div className="empty-state">No risk events for this filter.</div>}

      {data && data.events.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Reason</th><th>Entity</th><th>Score</th><th>Status</th><th>Detail</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>{REASON_LABEL[e.reason] || e.reason}</td>
                  <td className="faint">{e.entity_type}:{e.entity_id}</td>
                  <td className="num">{e.risk_score}</td>
                  <td><span className={`badge ${STATUS_TONE[e.status] || 'mute'}`}>{e.status}</span></td>
                  <td className="faint">{e.detail_json ? `${e.detail_json.count} in window` : ''}</td>
                  <td className="faint">{String(e.created_at).slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    {(e.status === 'OPEN' || e.status === 'REVIEWING') && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        {e.status === 'OPEN' && <button className="btn ghost" onClick={() => act(e.id, 'review')}>Review</button>}
                        <button className="btn ghost" onClick={() => act(e.id, 'resolve')}>Resolve</button>
                        <button className="btn ghost" onClick={() => act(e.id, 'resolve', { dismiss: true })}>Dismiss</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
