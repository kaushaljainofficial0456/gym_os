/**
 * PROGRESS — rebuilt on the design system.
 *
 * The page's job is one question: "am I moving?" So the delta gets the
 * headline treatment (it was previously a 12px grey subtitle under a
 * generic "Progress" title, which buried the only number the user came
 * for), and everything under it is evidence for that number.
 *
 * Sections render only when they have data, which is right — but the old
 * version had no fallback for a brand-new client, so their whole Progress
 * page was a title, an input and three empty photo boxes with no
 * explanation. There is now a real first-run state.
 */
import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState } from '../../components/UI.jsx';
import { WeightChart, TrendChart } from '../../components/charts.jsx';
import Icon from '../../components/Icon.jsx';

const PHOTO_VIEWS = [
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
  { key: 'back', label: 'Back' },
];

function ProgressSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your progress">
      <div>
        <div className="skeleton-text" style={{ width: '30%' }} />
        <div className="skeleton mt-2.5" style={{ height: 30, width: '58%', borderRadius: 'var(--r-sm)' }} />
      </div>
      <div className="skeleton" style={{ height: 68, borderRadius: 'var(--r-lg)' }} />
      <div className="skeleton" style={{ height: 180, borderRadius: 'var(--r-lg)' }} />
      <div className="skeleton" style={{ height: 150, borderRadius: 'var(--r-lg)' }} />
    </div>
  );
}

export default function Progress() {
  const p = useFetch(() => api('/tracking/me/progress'));
  // Already fetched once by the persistent ClientLayout — reuse it instead
  // of re-fetching /tracking/me/home on every mount (see ClientLayout.jsx).
  const home = useOutletContext();
  const [weightInput, setWeightInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);   // { text, tone }

  // The old toast had no dismissal at all — once shown it sat over the
  // bottom of the screen for the rest of the session.
  useEffect(() => {
    if (!toast) return undefined;
    const h = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(h);
  }, [toast]);

  if (p.loading || home.loading) return <ProgressSkeleton />;
  if (p.error) return <ErrorState error={p.error} onRetry={p.reload} />;

  const clientId = home.data?.client?.id;
  const weights = p.data?.weights || [];
  const adh = p.data?.adherence || [];
  const meas = p.data?.measurements || [];
  const photos = p.data?.photos || [];
  const supplements = p.data?.supplements || [];

  const logWeight = async () => {
    const w = parseFloat(weightInput);
    if (!w || w <= 0) { setToast({ text: 'Enter a weight in kilograms', tone: 'bad' }); return; }
    setSaving(true);
    try {
      await api(`/clients/${clientId}/weights`, { method: 'POST', body: JSON.stringify({ weight: w, source: 'manual' }) });
      // Was 'Weight logged ✓' — a check glyph inside a string, rendered in
      // the body font at body weight, which reads as a typo rather than as
      // an icon. The toast is already the confirmation; it doesn't need a
      // second one inside its own text.
      setToast({ text: `Logged ${w} kg`, tone: 'good' });
      setWeightInput('');
      // silent: true -- this page gates its whole render on
      // `p.loading || home.loading` (above); a bare reload() would
      // unmount everything for the duration of the refetch, same class
      // of bug already fixed for Nutrition.jsx.
      p.reload({ silent: true }); home.reload({ silent: true });
    } catch (e) { setToast({ text: e.message, tone: 'bad' }); }
    setSaving(false);
  };

  const firstW = weights[0]?.weight;
  const lastW = weights[weights.length - 1]?.weight;
  const delta = firstW != null && lastW != null ? Math.round((lastW - firstW) * 10) / 10 : null;
  const hasAnything = weights.length > 0 || adh.length > 0 || meas.length > 0 || photos.length > 0;

  return (
    <div className="space-y-4">
      {/* The delta IS the page. It used to sit in 12px grey under a
          generic "Progress" heading — the one number a client opens this
          screen for, styled as a caption. */}
      <div>
        <span className="t-micro">Progress</span>
        {delta != null ? (
          <>
            <div className="t-metric mt-1" style={{ fontSize: '2rem' }}>
              {delta > 0 ? '+' : ''}{delta} <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--mute)' }}>kg</span>
            </div>
            <p className="t-sub mt-0.5 tabular-nums">
              {firstW} kg at the start · {lastW} kg now
            </p>
          </>
        ) : (
          <h1 className="t-title mt-1">Progress</h1>
        )}
      </div>

      {/* Quick weight entry */}
      <div data-tour="progress-weight" className="card p-4">
        <label className="field-label" htmlFor="weight-today">Today&rsquo;s weight</label>
        <div className="flex gap-2 mt-1.5">
          {/* `.field-suffix` is absolutely positioned to sit INSIDE an
              input, so it needs a relatively-positioned wrapper. Dropped
              into the flex row directly it anchors to the nearest
              positioned ancestor instead and drifts off down the page. */}
          <div className="relative flex-1">
            <input
              id="weight-today"
              className="input w-full"
              style={{ paddingRight: 38 }}
              type="number" inputMode="decimal" step="0.1" min="0"
              placeholder="e.g. 74.5"
              value={weightInput}
              onChange={(e) => setWeightInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && logWeight()}
            />
            <span className="field-suffix">kg</span>
          </div>
          <button className="btn-primary shrink-0" data-loading={saving ? 'true' : undefined}
            onClick={logWeight} disabled={saving || !weightInput}>Log</button>
        </div>
      </div>

      {/* First-run: the page below is entirely data-gated, so without this
          a new client saw a heading, an input, and nothing else at all. */}
      {!hasAnything && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="trending" size={22} />
            </div>
            <div className="empty-state-title">Nothing to chart yet</div>
            <p className="empty-state-body">
              Log your weight a few times and the trend, adherence and measurements
              will appear here. Two entries are enough to draw the first line.
            </p>
          </div>
        </div>
      )}

      {weights.length >= 2 && (
        <div className="card p-4">
          <div className="t-micro mb-2">Weight trend</div>
          <WeightChart data={weights} />
        </div>
      )}

      {adh.length >= 2 && (
        <div className="card p-4">
          <div className="t-micro mb-2">Adherence · last 14 days</div>
          <TrendChart data={adh.map((a) => ({ label: a.date.slice(5), value: a.score }))} color="var(--accent)" />
        </div>
      )}

      {supplements.length > 0 && (
        <div className="card p-4">
          <div className="t-micro mb-2.5">Supplements</div>
          <div className="flex flex-wrap gap-1.5">
            {supplements.map((s) => (
              <span key={s.id} className="badge badge-plain">{s.name}{s.dose ? ` · ${s.dose}` : ''}</span>
            ))}
          </div>
        </div>
      )}

      {meas.length > 0 && (
        <div className="card p-4">
          <div className="t-micro mb-2.5">Measurements</div>
          {/* Own scroll container, so a seven-column table never makes the
              page body scroll sideways on a phone. */}
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  {['Date', 'Weight', 'Waist', 'Chest', 'Arms', 'Thighs', 'Hips', 'Neck'].map((h) => (
                    <th key={h} className="t-micro text-left py-2 pr-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {meas.slice(0, 6).map((m, i) => (
                  <tr key={i} style={{ borderBottom: i === Math.min(meas.length, 6) - 1 ? 'none' : '1px solid rgb(var(--tint-rgb) / .07)' }}>
                    <td className="py-2 pr-3 font-grotesk whitespace-nowrap" style={{ color: 'var(--mute)' }}>{m.taken_at?.slice(0, 10)}</td>
                    {['weight', 'waist', 'chest', 'arms', 'thighs', 'hips', 'neck'].map((k) => (
                      <td key={k} className="py-2 pr-3 tabular-nums" style={{ color: m[k] == null ? 'var(--faint)' : 'var(--ink)' }}>{m[k] ?? '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Photos */}
      <div data-tour="progress-photos" className="card p-4">
        {/* Stacked, not a two-column section-head: at 375px the label and
            the privacy note each wrapped to two ragged lines beside each
            other. The note is a full sentence, so it gets its own line. */}
        <div className="mb-2.5">
          <span className="t-micro">Transformation photos</span>
          <p className="t-sub mt-1" style={{ fontSize: '.6875rem' }}>Private to you and your coach.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PHOTO_VIEWS.map((v) => {
            const has = photos.filter((ph) => ph.view === v.key);
            return (
              <div key={v.key}
                className="aspect-[3/4] grid place-items-center text-center p-2"
                style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'var(--panel2)' }}>
                {has.length ? (
                  <div>
                    <div className="grid place-items-center mb-1" style={{ color: 'rgb(var(--good-rgb))' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                    </div>
                    {/* Was `{has.length} photo{v.length > 1 ? 's' : ''}` —
                        it pluralised on the length of the VIEW NAME
                        ('front', 'side', 'back'), all of which are longer
                        than one character, so a single photo always read
                        "1 photos". */}
                    <div className="font-grotesk text-[10px] font-semibold" style={{ color: 'var(--ink)' }}>
                      {has.length} photo{has.length === 1 ? '' : 's'}
                    </div>
                    <div className="t-micro mt-0.5">{v.label}</div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1.5 grid place-items-center" style={{ color: 'var(--faint)' }}><Icon name="camera" size={20} /></div>
                    <div className="t-micro">{v.label}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {toast && (
        <div className={`toast anim-toast ${toast.tone === 'bad' ? 'toast-bad' : 'toast-good'}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
