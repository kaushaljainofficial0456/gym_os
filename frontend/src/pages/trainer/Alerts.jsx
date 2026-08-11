import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, daysAgoLabel } from '../../utils.js';
import { Card, Kicker, Spinner, ErrorState, Empty } from '../../components/UI.jsx';

const SEV = {
  high: ['HIGH', 'text-bad border-bad/40 bg-bad/10'],
  medium: ['MED', 'text-warn border-warn/40 bg-warn/10'],
  low: ['LOW', 'text-mute border-line bg-white/5']
};

const FILTERS = [
  ['all', 'All'], ['open', 'Open'], ['read', 'Read'], ['followed_up', 'Followed up'], ['dismissed', 'Dismissed']
];

export default function Alerts() {
  const [filter, setFilter] = useState('all');
  const alerts = useFetch(() => api(`/alerts${filter === 'all' ? '' : `?status=${filter}`}`), [filter]);

  if (alerts.loading) return <Spinner label="Loading alerts…" />;
  if (alerts.error) return <ErrorState error={alerts.error} onRetry={alerts.reload} />;

  const action = async (id, act) => {
    try {
      await api(`/alerts/${id}/action`, { method: 'POST', body: JSON.stringify({ action: act }) });
      alerts.reload();
    } catch (e) { /* surface via reload */ }
  };

  const rows = alerts.data?.alerts || [];
  const openCount = rows.filter((a) => a.status === 'open').length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl">Trainer alerts</h1>
          <p className="text-mute text-sm">Risk signals detected from real client data — read, follow up, or dismiss.</p>
        </div>
        <div className="chip border-bad/40 bg-bad/10 text-bad">{openCount} open</div>
      </div>

      <div className="flex gap-1.5 bg-white/5 border border-line rounded-full p-1 overflow-x-auto">
        {FILTERS.map(([v, l]) => (
          <button key={v} className={`tab ${filter === v ? 'active' : ''}`} onClick={() => setFilter(v)}>{l}</button>
        ))}
      </div>

      <Card>
        <Kicker>Attention queue</Kicker>
        <div className="space-y-2">
          {rows.map((a) => {
            const sev = SEV[a.severity] || SEV.medium;
            return (
              <div key={a.id} className={`rounded-2xl border p-3.5 flex flex-wrap items-center gap-3 transition-colors ${a.status === 'open' ? 'border-line bg-white/[.03]' : 'border-line bg-white/[.01] opacity-70'}`}>
                <div className={`w-9 h-9 rounded-full grid place-items-center shrink-0 ${a.status === 'open' ? 'bg-gradient-to-br from-ember/30 to-gold/20 border border-line' : 'bg-white/5 border border-line'}`}>
                  {a.status === 'open' ? '🚨' : '✓'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={`/app/trainer/clients/${a.client_id}`} className="font-grotesk text-sm font-semibold hover:text-gold transition-colors">{a.client_name}</Link>
                    <span className={`chip border ${sev[1]}`}>{sev[0]}</span>
                    <span className="text-[10px] text-faint font-grotesk uppercase tracking-wider">{a.type?.replace(/_/g, ' ')}</span>
                    <span className="text-[10px] text-faint font-grotesk">{daysAgoLabel(a.created_at)}</span>
                  </div>
                  <div className="text-sm mt-1">{a.title}</div>
                  {a.detail && <div className="text-xs text-mute mt-0.5">{a.detail}</div>}
                </div>
                {a.status === 'open' ? (
                  <div className="flex gap-1.5">
                    <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => action(a.id, 'read')}>Mark read</button>
                    <button className="btn !py-1.5 !px-3 !text-[11px]" onClick={() => action(a.id, 'follow_up')}>Follow up</button>
                    <button className="btn !py-1.5 !px-3 !text-[11px] !text-mute" onClick={() => action(a.id, 'dismiss')}>Dismiss</button>
                  </div>
                ) : (
                  <span className="text-[10px] text-faint uppercase tracking-wider font-grotesk">{a.status === 'followed_up' ? 'Followed up' : a.status === 'dismissed' ? 'Dismissed' : 'Read'}</span>
                )}
              </div>
            );
          })}
          {!rows.length && <Empty title={filter === 'all' ? 'All clear' : 'Nothing here'} hint={filter === 'all' ? 'No risk signals right now — every client is accounted for.' : 'No alerts in this state.'} />}
        </div>
      </Card>
    </div>
  );
}
