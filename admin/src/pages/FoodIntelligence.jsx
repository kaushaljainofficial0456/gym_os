import { api } from '../api.js';
import { useFetch } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonCards, SkeletonRows, SkeletonBlock } from '../components/Skeleton.jsx';

const pct = (n) => (n == null ? 'N/A' : `${Math.round(n * 1000) / 10}%`);
const num = (n) => (n == null ? 'N/A' : n.toLocaleString());

export default function FoodIntelligence() {
  const overview = useFetch(() => api('/console/intelligence/food/overview'));
  const activity = useFetch(() => api('/console/intelligence/food/activity?days=14'));
  const providers = useFetch(() => api('/console/intelligence/food/providers'));
  const topFoods = useFetch(() => api('/console/intelligence/food/top-foods'));
  const corrected = useFetch(() => api('/console/intelligence/food/most-corrected'));
  const reviewQueue = useFetch(() => api('/console/intelligence/food/review-queue'));
  const dataQuality = useFetch(() => api('/console/intelligence/food/data-quality'));
  const toast = useToast();

  const act = async (canonicalKey, action) => {
    try {
      await api(`/console/intelligence/food/review-queue/${encodeURIComponent(canonicalKey)}/${action}`, { method: 'POST' });
      reviewQueue.reload();
      toast.success(action === 'verify' ? 'Marked as human-reviewed' : 'Reverted to AI estimate');
    } catch (e) { toast.error(e.message || 'Could not update'); }
  };

  const maxActivity = activity.data ? Math.max(1, ...activity.data.days.map((d) => d.cacheHits + d.cacheMisses + d.aiCalls)) : 1;

  return (
    <div>
      <div className="page-header">
        <h1>Food Intelligence</h1>
        <p>Every number below is a real query against actual events and food-estimate rows — never fabricated. A metric this platform genuinely can't compute yet (like $ savings, with no per-call pricing configured) shows N/A.</p>
      </div>

      {overview.loading && <SkeletonCards count={8} />}
      {overview.data && (
        <>
          <div className="kpi-grid">
            <Kpi label="Cache hits (avoided AI calls)" value={num(overview.data.allTime.cacheHits)} sub={`${num(overview.data.today.cacheHits)} today`} />
            <Kpi label="Cache hit rate" value={pct(overview.data.allTime.cacheHitRate)} />
            <Kpi label="AI calls made" value={num(overview.data.allTime.aiCalls)} sub={`${num(overview.data.today.aiCalls)} today`} />
            <Kpi label="AI success rate" value={pct(overview.data.allTime.aiSuccessRate)} />
            <Kpi label="Distinct AI-estimated foods" value={num(overview.data.allTime.totalAiEstimatedFoods)} />
            <Kpi label="Total corrections submitted" value={num(overview.data.allTime.totalCorrections)} />
            <Kpi label="Needs review" value={num(overview.data.allTime.needsReviewCount)} />
            <Kpi label="Estimated API savings" value="N/A" sub="no per-call pricing configured" />
          </div>
        </>
      )}

      <div className="card">
        <h2>Activity — last 14 days</h2>
        {activity.loading && <SkeletonBlock height={140} />}
        {activity.data && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140, marginTop: 12 }}>
            {activity.data.days.map((d) => {
              const total = d.cacheHits + d.cacheMisses + d.aiCalls;
              const h = Math.max(2, (total / maxActivity) * 120);
              const hitH = total > 0 ? (d.cacheHits / total) * h : 0;
              return (
                <div key={d.date} title={`${d.date}: ${d.cacheHits} cache hits, ${d.cacheMisses} misses, ${d.aiCalls} AI calls`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 120 }}>
                  <div style={{ height: h - hitH, background: 'var(--warn)', opacity: 0.6, borderRadius: '2px 2px 0 0' }} />
                  <div style={{ height: hitH, background: 'var(--good)', borderRadius: hitH === h ? '2px 2px 0 0' : 0 }} />
                </div>
              );
            })}
          </div>
        )}
        <div className="faint" style={{ marginTop: 8, display: 'flex', gap: 16 }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--good)', borderRadius: 2, marginRight: 4 }} />Cache hits</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--warn)', opacity: 0.6, borderRadius: 2, marginRight: 4 }} />Misses / AI calls</span>
        </div>
      </div>

      <div className="card">
        <h2>Provider performance</h2>
        {providers.loading && <SkeletonRows rows={4} cols={7} />}
        {providers.data && (
          <table>
            <thead><tr><th>Provider</th><th>Configured</th><th>Requests</th><th>Success rate</th><th>Avg latency</th><th>Today's usage</th><th>Status</th></tr></thead>
            <tbody>
              {providers.data.providers.map((p) => (
                <tr key={p.provider}>
                  <td style={{ textTransform: 'capitalize' }}>{p.provider}</td>
                  <td>{p.configured ? <span className="badge good">Yes</span> : <span className="badge mute">No</span>}</td>
                  <td className="num">{p.requests}</td>
                  <td className="num">{pct(p.successRate)}</td>
                  <td className="num">{p.avgLatencyMs != null ? `${p.avgLatencyMs}ms` : 'N/A'}</td>
                  <td className="num">{p.dailyUsage}{p.dailyLimit != null ? ` / ${p.dailyLimit}` : ' (unlimited)'}</td>
                  <td>{p.onCooldown ? <span className="badge warn">Cooldown</span> : <span className="badge good">Healthy</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Needs review — community-corrected candidates</h2>
        <p className="faint">Flagged by the system itself once enough independent corrections agreed the AI's original number was off. Verifying marks it human-reviewed; rejecting reverts it to a plain AI estimate.</p>
        {reviewQueue.loading && <SkeletonRows rows={3} cols={5} />}
        {reviewQueue.data && !reviewQueue.data.items.length && <EmptyState icon="check" title="Food intelligence looks healthy" description="No items currently require review." />}
        {reviewQueue.data && reviewQueue.data.items.length > 0 && (
          <table>
            <thead><tr><th>Food</th><th>Feedback count</th><th>Provider</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {reviewQueue.data.items.map((item) => (
                <tr key={item.canonical_key}>
                  <td>{item.canonical_name}</td>
                  <td className="num">{item.feedback_count}</td>
                  <td className="faint">{item.ai_provider}</td>
                  <td className="faint">{String(item.updated_at).slice(0, 10)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn ghost" onClick={() => act(item.canonical_key, 'verify')}>Verify</button>
                      <button className="btn ghost" onClick={() => act(item.canonical_key, 'reject')}>Reject</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Top cached / requested foods</h2>
          {topFoods.loading && <SkeletonRows rows={4} cols={3} />}
          {topFoods.data && !topFoods.data.foods.length && <EmptyState icon="food" title="No AI estimates yet" description="Foods estimated by AI will show up here." />}
          {topFoods.data && topFoods.data.foods.length > 0 && (
            <table>
              <thead><tr><th>Food</th><th>Used</th><th>Confidence</th></tr></thead>
              <tbody>
                {topFoods.data.foods.slice(0, 10).map((f) => (
                  <tr key={f.canonical_key}>
                    <td>{f.canonical_name}<div className="faint">{f.ai_provider}</div></td>
                    <td className="num">{f.times_used}</td>
                    <td className="faint">{f.confidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Most corrected foods</h2>
          {corrected.loading && <SkeletonRows rows={4} cols={3} />}
          {corrected.data && !corrected.data.foods.length && <EmptyState icon="check" title="No corrections yet" description="Community corrections to AI estimates will appear here." />}
          {corrected.data && corrected.data.foods.length > 0 && (
            <table>
              <thead><tr><th>Food</th><th>Corrections</th><th>Median Δ</th></tr></thead>
              <tbody>
                {corrected.data.foods.slice(0, 10).map((f) => (
                  <tr key={f.canonicalKey}>
                    <td>{f.name}</td>
                    <td className="num">{f.correctionCount}</td>
                    <td className="num" style={{ color: f.medianCorrectionPct < 0 ? 'var(--bad)' : 'var(--good)' }}>{f.medianCorrectionPct > 0 ? '+' : ''}{f.medianCorrectionPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Data quality — global food library</h2>
        {dataQuality.loading && <SkeletonCards count={4} />}
        {dataQuality.data && (
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <Kpi label="Missing calories" value={num(dataQuality.data.missingCalories)} />
            <Kpi label="Missing macros" value={num(dataQuality.data.missingMacros)} />
            <Kpi label="Missing serving info" value={num(dataQuality.data.missingServingInfo)} />
            <Kpi label="Duplicate names" value={num(dataQuality.data.duplicateGlobalNames)} />
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="faint" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
