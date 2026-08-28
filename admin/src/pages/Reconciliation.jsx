import { useState } from 'react';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const TONE = { OPEN: 'warn', RESOLVED: 'good', DISMISSED: 'mute' };

export default function Reconciliation() {
  const { data, loading, error, reload } = useFetch(() => api('/console/reconciliation'));
  const [running, setRunning] = useState(false);
  const [lastSummary, setLastSummary] = useState(null);
  const toast = useToast();

  const runSweep = async () => {
    setRunning(true);
    try {
      const summary = await api('/console/reconciliation/run', { method: 'POST' });
      setLastSummary(summary);
      reload();
      toast.success(`Sweep complete: ${summary.flagged} flagged, ${summary.recovered} recovered`);
    } catch (e) { toast.error(e.message || 'Sweep failed'); }
    finally { setRunning(false); }
  };

  const resolveIssue = async (id, dismiss) => {
    try { await api(`/console/reconciliation/${id}/resolve`, { method: 'POST', body: JSON.stringify({ dismiss }) }); reload(); toast.success(dismiss ? 'Issue dismissed' : 'Issue resolved'); }
    catch (e) { toast.error(e.message || 'Could not update issue'); }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Reconciliation</h1>
        <p>Detected mismatches between SK OS's records and the payment provider's -- never auto-corrected, only flagged for review.</p>
      </div>

      <div className="card">
        <button className="btn" onClick={runSweep} disabled={running}>{running ? 'Running sweep…' : 'Run reconciliation sweep now'}</button>
        {lastSummary && (
          <p className="faint" style={{ marginTop: 10 }}>
            Checked {lastSummary.checked} · Recovered {lastSummary.recovered} · Flagged {lastSummary.flagged} · Unchanged {lastSummary.unchanged}
          </p>
        )}
      </div>

      {loading && <div className="card"><SkeletonRows rows={4} cols={5} /></div>}
      {error && <div className="error-text">{error.message}</div>}
      {data && !data.issues.length && (
        <div className="card"><EmptyState icon="reconciliation" title="Books balance" description="No reconciliation issues right now -- everything matches the payment provider's own records." /></div>
      )}

      {data && data.issues.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Type</th><th>Status</th><th>Note</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {data.issues.map((i) => (
                <tr key={i.id}>
                  <td className="faint">{i.issue_type}</td>
                  <td><span className={`badge ${TONE[i.status] || 'mute'}`}>{i.status}</span></td>
                  <td>{i.note}</td>
                  <td className="faint">{formatDateTime(i.created_at)}</td>
                  <td>
                    {i.status === 'OPEN' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn ghost" onClick={() => resolveIssue(i.id, false)}>Resolve</button>
                        <button className="btn ghost" onClick={() => resolveIssue(i.id, true)}>Dismiss</button>
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
