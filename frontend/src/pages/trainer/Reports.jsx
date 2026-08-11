import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useFetch, fmt1 } from '../../utils.js';
import { Card, Kicker, Spinner, ErrorState } from '../../components/UI.jsx';
import { AdherenceBreakdown } from '../../components/charts.jsx';

export default function Reports() {
  const clients = useFetch(() => api('/clients?sort=name'));
  const [clientId, setClientId] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(h);
  }, [toast]);

  const load = async (id) => {
    setClientId(id);
    if (!id) return setReport(null);
    setLoading(true); setError(null);
    try {
      const { report } = await api(`/reports/clients/${id}/weekly-report`);
      setReport(report);
    } catch (e) { setError(e); }
    setLoading(false);
  };

  const send = async () => {
    setSending(true);
    try {
      await api(`/reports/clients/${clientId}/weekly-report/send`, { method: 'POST' });
      setToast('Report sent — client notified in-app');
    } catch (e) { setToast(e.message); }
    setSending(false);
  };

  if (clients.loading) return <Spinner label="Loading clients…" />;
  if (clients.error) return <ErrorState error={clients.error} onRetry={clients.reload} />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl">Weekly reports</h1>
          <p className="text-mute text-sm">A data-backed week in review, generated from real tracked data — send it to the client in one tap.</p>
        </div>
        <select className="input max-w-xs" value={clientId} onChange={(e) => load(e.target.value)}>
          <option value="">Choose client…</option>
          {(clients.data?.clients || []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.goal}</option>)}
        </select>
      </div>

      {loading && <Spinner label="Crunching the week…" />}
      {error && <ErrorState error={error} onRetry={() => load(clientId)} />}

      {report && (
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h2 className="font-grotesk font-bold text-xl uppercase tracking-wide">{report.clientName}</h2>
              <span className="text-[11px] text-mute font-grotesk">{report.period.start} → {report.period.end}</span>
            </div>
            <div className="text-xs text-mute mb-4">Weekly progress · generated {new Date(report.generatedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                ['Weight', report.weight ? `${report.weight.start} → ${report.weight.end} kg` : '—', report.weight?.delta != null && report.weight.delta < 0 ? 'text-cyanx' : 'text-ink', report.weight?.delta != null ? `${report.weight.delta > 0 ? '+' : ''}${fmt1(report.weight.delta)} kg` : ''],
                ['Workouts', `${report.workouts.done} / ${report.workouts.scheduled}`, 'text-gold', 'completed'],
                ['Water', report.avgWater != null ? `${report.avgWater} L` : '—', 'text-cyanx', 'daily avg'],
                ['Sleep', report.avgSleep != null ? `${report.avgSleep} h` : '—', 'text-violetx', 'daily avg']
              ].map(([l, v, c, s]) => (
                <div key={l} className="rounded-xl border border-line bg-white/[.03] p-3">
                  <div className="text-[9px] uppercase tracking-wider text-mute font-grotesk mb-1">{l}</div>
                  <div className={`font-grotesk font-bold text-lg ${c}`}>{v}</div>
                  <div className="text-[10px] text-faint">{s}</div>
                </div>
              ))}
            </div>

            <Kicker>Adherence · {report.adherence.score}%</Kicker>
            <AdherenceBreakdown components={report.adherence.components} />

            <div className="mt-5 grid sm:grid-cols-2 gap-3">
              <div className="rounded-2xl p-4" style={{ background: 'linear-gradient(150deg, rgba(255,106,61,.12), rgba(255,194,75,.05))', border: '1px solid rgba(255,106,61,.3)' }}>
                <div className="text-[10px] uppercase tracking-wider text-ember font-grotesk mb-1.5">Coach summary</div>
                <p className="text-sm leading-relaxed">{report.coachSummary}</p>
              </div>
              <div className="rounded-2xl p-4 border border-line bg-white/[.03]">
                <div className="text-[10px] uppercase tracking-wider text-gold font-grotesk mb-1.5">Next week</div>
                <ul className="space-y-1.5 text-sm">
                  {(report.nextWeek || []).map((n, i) => <li key={i} className="flex gap-2"><span className="text-gold">→</span><span>{n}</span></li>)}
                </ul>
              </div>
            </div>
          </Card>

          <div className="space-y-6">
            <Card>
              <Kicker>Daily log · 7 days</Kicker>
              <div className="space-y-1">
                {report.daily.map((d) => (
                  <div key={d.date} className="flex items-center gap-3 py-1.5 border-b border-line/50 last:border-0">
                    <span className="w-10 font-grotesk text-[11px] font-semibold">{d.dow}</span>
                    <span className="text-[10px] text-faint w-20">{d.date.slice(5)}</span>
                    <span className="flex-1 text-[11px] text-mute">{d.weight ? `${d.weight} kg` : '—'}</span>
                    <span className="text-[11px] text-cyanx">{d.water ? `${d.water}L` : '—'}</span>
                    <span className="text-[11px] text-violetx">{d.sleep != null ? `${d.sleep}h` : '—'}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="space-y-3">
              <Kicker>Share</Kicker>
              <button className="btn-primary w-full" onClick={send} disabled={sending}>{sending ? 'Sending…' : 'Send to client'}</button>
              <div className="text-[11px] text-faint leading-relaxed">
                Sends an in-app notification + message thread entry. WhatsApp Business delivery is a planned integration (channel column ready in the backend).
              </div>
            </Card>
          </div>
        </div>
      )}

      {!report && !loading && (
        <Card>
          <div className="text-center py-14">
            <div className="text-4xl mb-3">📄</div>
            <div className="font-grotesk font-semibold">Pick a client to generate their weekly report</div>
            <div className="text-xs text-mute mt-1 max-w-sm mx-auto">Weight delta, workout completion, adherence breakdown, coach summary and next-week actions — all from real data.</div>
          </div>
        </Card>
      )}

      {toast && <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </div>
  );
}
