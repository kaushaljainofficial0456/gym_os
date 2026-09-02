import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Card } from '../../components/UI.jsx';
import { WeightChart, TrendChart, AdherenceBreakdown } from '../../components/charts.jsx';
import Icon from '../../components/Icon.jsx';

export default function Progress() {
  const p = useFetch(() => api('/tracking/me/progress'));
  // Already fetched once by the persistent ClientLayout — reuse it instead
  // of re-fetching /tracking/me/home on every mount (see ClientLayout.jsx).
  const home = useOutletContext();
  const [weightInput, setWeightInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  if (p.loading || home.loading) return <Spinner label="Loading your progress…" />;
  if (p.error) return <ErrorState error={p.error} onRetry={p.reload} />;

  const clientId = home.data?.client?.id;
  const weights = p.data?.weights || [];
  const adh = p.data?.adherence || [];
  const meas = p.data?.measurements || [];
  const photos = p.data?.photos || [];

  const logWeight = async () => {
    const w = parseFloat(weightInput);
    if (!w || w <= 0) return;
    setSaving(true);
    try {
      await api(`/clients/${clientId}/weights`, { method: 'POST', body: JSON.stringify({ weight: w, source: 'manual' }) });
      setToast('Weight logged ✓');
      setWeightInput('');
      // silent: true -- this page gates its whole render on
      // `p.loading || home.loading` (below); a bare reload() would
      // unmount everything for the duration of the refetch, same class
      // of bug already fixed for Nutrition.jsx.
      p.reload({ silent: true }); home.reload({ silent: true });
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const firstW = weights[0]?.weight;
  const lastW = weights[weights.length - 1]?.weight;
  const delta = firstW && lastW ? Math.round((lastW - firstW) * 10) / 10 : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-grotesk font-bold text-xl">Progress</h1>
        <div className="text-xs text-mute mt-0.5">
          {delta != null ? `${firstW} → ${lastW} kg (${delta > 0 ? '+' : ''}${delta} kg since start)` : 'Track your first weight to begin'}
        </div>
      </div>

      {/* quick weight entry */}
      <div data-tour="progress-weight" className="card p-4 flex gap-2">
        <input className="input flex-1" type="number" step="0.1" placeholder="Today's weight (kg)" value={weightInput} onChange={(e) => setWeightInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && logWeight()} />
        <button className="btn-primary shrink-0" onClick={logWeight} disabled={saving}>{saving ? '…' : 'Log'}</button>
      </div>

      {weights.length >= 2 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Weight trend</div>
          <WeightChart data={weights} />
        </div>
      )}

      {adh.length >= 2 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Adherence · last 14 days</div>
          <TrendChart data={adh.map((a) => ({ label: a.date.slice(5), value: a.score }))} color="var(--accent)" />
        </div>
      )}

      {p.data?.supplements?.length > 0 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Supplements</div>
          <div className="flex flex-wrap gap-1.5">
            {p.data.supplements.map((s) => <span key={s.id} className="chip border-line">{s.name}{s.dose ? ` · ${s.dose}` : ''}</span>)}
          </div>
        </div>
      )}

      {/* measurements */}
      {meas.length > 0 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Measurements</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-mute font-grotesk border-b border-line">
                  <th className="py-2 pr-3 font-semibold">Date</th>
                  {['Weight', 'Waist', 'Chest', 'Arms', 'Thighs', 'Hips', 'Neck'].map((h) => <th key={h} className="py-2 pr-3 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {meas.slice(0, 6).map((m, i) => (
                  <tr key={i} className="border-b border-line/40 last:border-0">
                    <td className="py-2 pr-3 font-grotesk text-mute">{m.taken_at?.slice(0, 10)}</td>
                    {['weight', 'waist', 'chest', 'arms', 'thighs', 'hips', 'neck'].map((k) => <td key={k} className="py-2 pr-3">{m[k] ?? '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* photos */}
      <div data-tour="progress-photos" className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2.5">Transformation photos</div>
        <div className="grid grid-cols-3 gap-2">
          {['front', 'side', 'back'].map((v) => {
            const has = photos.filter((ph) => ph.view === v);
            return (
              <div key={v} className="aspect-[3/4] rounded-xl border border-line bg-white/[.03] grid place-items-center text-center p-2">
                {has.length ? (
                  <div className="text-[10px] text-good font-grotesk">{has.length} photo{v.length > 1 ? 's' : ''} ✓</div>
                ) : (
                  <div>
                    <div className="mb-1 grid place-items-center" style={{ color: 'var(--faint)' }}><Icon name="camera" size={20} /></div>
                    <div className="text-[9px] text-faint uppercase tracking-wider font-grotesk">{v}</div>
                    <div className="text-[8px] text-faint mt-1">Before/after — privacy-protected</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-faint mt-2">Photo uploads are private between you and your coach. (Planned: drag-to-compare slider.)</div>
      </div>

      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </div>
  );
}
