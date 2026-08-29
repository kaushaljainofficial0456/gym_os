import { api } from '../api.js';
import { useFetch } from '../utils.js';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonCards, SkeletonBlock, SkeletonRows } from '../components/Skeleton.jsx';

const num = (n) => (n == null ? 'N/A' : n.toLocaleString());
const pct = (n) => (n == null ? 'N/A' : `${n}%`);
const PROVIDER_COLOR = { baseline: 'var(--faint)', ml: 'var(--good)', mock: 'var(--warn)' };

export default function MlMonitoring() {
  const overview = useFetch(() => api('/console/intelligence/ml/overview?days=30'));
  const activity = useFetch(() => api('/console/intelligence/ml/activity?days=14'));

  const maxActivity = activity.data ? Math.max(1, ...activity.data.days.map((d) => d.baseline + d.ml + d.mock)) : 1;

  return (
    <div>
      <div className="page-header">
        <h1>ML Monitoring</h1>
        <p>The calorie-estimation model (skos-cal-v1), monitored from two real sources: persisted per-workout estimates, and fallback/quality telemetry this pass newly instruments — honestly empty until real traffic accumulates.</p>
      </div>

      {overview.loading && <SkeletonCards count={4} />}
      {overview.error && <div className="error-text">{overview.error.message}</div>}

      {overview.data && (
        <>
          <div className="kpi-grid">
            <Kpi label="Active provider" value={overview.data.modelCard.provider} sub={overview.data.modelCard.mlEnabled ? 'ml is live' : 'ml not enabled — baseline runs'} />
            <Kpi label="Estimates, last 30d" value={num(overview.data.estimateStats.totalEstimates)} sub="persisted completions only" />
            <Kpi label="ML fallback rate" value={pct(overview.data.mlHealth.fallbackRatePct)} sub={overview.data.mlHealth.instrumented ? `${overview.data.mlHealth.fallbackCount} of ${overview.data.mlHealth.totalAttempts}` : 'no ml attempts recorded yet'} />
            <Kpi label="ML quality-flagged" value={pct(overview.data.mlHealth.flaggedSuccessRatePct)} sub="model self-reported a caveat" />
          </div>

          <div className="card">
            <h2>Model card — skos-cal-v1</h2>
            <p className="faint" style={{ marginBottom: 12 }}>Read verbatim from the shipped model artifact, never re-typed — see this file's own scope caveats before trusting it outside the population below.</p>
            <dl className="kv">
              <dt>Trained on</dt>
              <dd>{overview.data.modelCard.trainedOn?.participants ?? 'N/A'} participants, {overview.data.modelCard.trainedOn?.rows ?? 'N/A'} rows ({(overview.data.modelCard.trainedOn?.datasets || []).join(', ')})</dd>
              <dt>Population</dt>
              <dd>{overview.data.modelCard.trainedOn?.population || 'N/A'}</dd>
              <dt>Exercises covered</dt>
              <dd>{(overview.data.modelCard.knownExercises || []).join(', ') || 'None'} — anything else falls through to a flagged, zero-correction estimate</dd>
              <dt>Plausibility cap</dt>
              <dd>{overview.data.modelCard.plausibilityCapKcalPerMin} kcal/min sustained rate — a safety net against extrapolation, not a validated ceiling</dd>
              <dt>Valid body-weight range</dt>
              <dd>{overview.data.modelCard.bodyWeightValidRangeKg ? `${overview.data.modelCard.bodyWeightValidRangeKg[0]}–${overview.data.modelCard.bodyWeightValidRangeKg[1]} kg` : 'N/A'} — outside this, corrections don't scale with the user's real weight (source data used one constant cohort weight)</dd>
              <dt>Timeout budget</dt>
              <dd>{overview.data.modelCard.timeoutMs}ms — a slow/hanging model always falls back to baseline, never stalls a workout</dd>
            </dl>
          </div>
        </>
      )}

      <div className="card">
        <h2>Activity — last 14 days</h2>
        <p className="faint">Real persisted completions per day, by provider.</p>
        {activity.loading && <SkeletonBlock height={140} />}
        {activity.data && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140, marginTop: 12 }}>
            {activity.data.days.map((d) => {
              const total = d.baseline + d.ml + d.mock;
              const h = Math.max(2, (total / maxActivity) * 120);
              const mlH = total > 0 ? (d.ml / total) * h : 0;
              const mockH = total > 0 ? (d.mock / total) * h : 0;
              const baseH = h - mlH - mockH;
              return (
                <div key={d.date} title={`${d.date}: ${d.baseline} baseline, ${d.ml} ml, ${d.mock} mock`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 120 }}>
                  <div style={{ height: mockH, background: PROVIDER_COLOR.mock, opacity: 0.6, borderRadius: mockH > 0 && mlH === 0 && baseH === 0 ? '2px 2px 0 0' : 0 }} />
                  <div style={{ height: mlH, background: PROVIDER_COLOR.ml, borderRadius: mlH > 0 && mockH === 0 ? '2px 2px 0 0' : 0 }} />
                  <div style={{ height: baseH, background: PROVIDER_COLOR.baseline, opacity: 0.6, borderRadius: baseH > 0 && mlH === 0 && mockH === 0 ? '2px 2px 0 0' : 0 }} />
                </div>
              );
            })}
          </div>
        )}
        <div className="faint" style={{ marginTop: 8, display: 'flex', gap: 16 }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: PROVIDER_COLOR.ml, borderRadius: 2, marginRight: 4 }} />ml (skos-cal-v1)</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: PROVIDER_COLOR.baseline, opacity: 0.6, borderRadius: 2, marginRight: 4 }} />baseline</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: PROVIDER_COLOR.mock, opacity: 0.6, borderRadius: 2, marginRight: 4 }} />mock</span>
        </div>
      </div>

      {overview.data && (
        <div className="two-col">
          <div className="card">
            <h2>Estimates by provider — last 30d</h2>
            {!overview.data.estimateStats.byProvider.length && <EmptyState icon="ml" title="No estimates yet" description="Completed workouts with a calorie estimate will show up here." />}
            {overview.data.estimateStats.byProvider.length > 0 && (
              <table>
                <thead><tr><th>Provider</th><th>Count</th><th>Avg kcal</th><th>Median kcal</th><th>Avg range width</th></tr></thead>
                <tbody>
                  {overview.data.estimateStats.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td>{p.provider}<div className="faint">{p.modelVersions.join(', ')}</div></td>
                      <td className="num">{p.count}</td>
                      <td className="num">{num(p.avgKcal)}</td>
                      <td className="num">{num(p.medianKcal)}</td>
                      <td className="num">{p.avgIntervalWidthPct != null ? `±${p.avgIntervalWidthPct}%` : 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h2>ML fallbacks by cause — last 30d</h2>
            {!overview.data.mlHealth.instrumented && (
              <EmptyState icon="ml" title="No ml attempts recorded yet" description="Data appears here once real traffic runs with CALORIE_MODEL_PROVIDER=ml." />
            )}
            {overview.data.mlHealth.instrumented && !overview.data.mlHealth.fallbacksByCategory.length && (
              <EmptyState icon="check" title="Zero fallbacks" description="Every ml attempt in this window succeeded." />
            )}
            {overview.data.mlHealth.instrumented && overview.data.mlHealth.fallbacksByCategory.length > 0 && (
              <table>
                <thead><tr><th>Category</th><th>Count</th></tr></thead>
                <tbody>
                  {overview.data.mlHealth.fallbacksByCategory.map((c) => (
                    <tr key={c.category}>
                      <td>{CATEGORY_LABEL[c.category] || c.category}</td>
                      <td className="num">{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_LABEL = {
  ml_timeout: 'Timed out (> budget)',
  ml_unavailable: 'Unavailable / threw',
  invalid_output: 'Invalid output rejected',
};

function Kpi({ label, value, sub }) {
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 20 }}>{value}</div>
      {sub && <div className="faint" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
