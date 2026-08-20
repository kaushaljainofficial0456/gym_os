import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch, fmt1 } from '../../utils.js';
import { Card, Kicker, Kpi, Spinner, ErrorState, StatusChip, Avatar, Skeleton } from '../../components/UI.jsx';
import { Reveal, AnimatedNumber } from '../../design/index.js';
import { TrendChart } from '../../components/charts.jsx';
import { Stagger } from '../../components/motion.jsx';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function Dashboard() {
  const { user } = useAuth();
  const ov = useFetch(() => api('/dashboard/overview'));
  const att = useFetch(() => api('/dashboard/attention'));
  const trend = useFetch(() => api('/dashboard/adherence-trend'));
  const trendRows = useMemo(() => (trend.data?.trend || []).map(t => ({ label: t.date.slice(5), value: t.avg ?? 0 })), [trend.data]);

  if (ov.loading || att.loading || trend.loading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-20 w-2/3" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map(i => <div key={i} className="card p-4"><Skeleton lines={2} /></div>)}</div>
        <div className="grid lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 card p-5"><Skeleton lines={5} /></div>
          <div className="lg:col-span-2 card p-5"><Skeleton lines={4} /></div>
        </div>
      </div>
    );
  }
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;

  const k = ov.data.kpis;
  const firstName = user?.name?.split(' ')[0] || 'Coach';

  return (
    <div className="space-y-6">
      {/* hero */}
      {/* Hero, matched to the client Home treatment: a quiet serif greeting,
          then the number that actually decides what this person does next.

          That number is HOW MANY CLIENTS NEED ATTENTION, not average
          adherence. Average adherence is a vanity metric on a trainer's
          dashboard -- it moves slowly, it is not actionable, and a healthy
          82% average can hide three clients about to churn. The count of
          people needing action is the thing the screen exists to answer, so
          it gets the largest type and adherence moves to a supporting line.

          The gradient-clipped name is gone: gradient text on a peach ground
          reads as washed-out rather than premium, and it put the visual
          emphasis on the trainer's own name, which is not information. */}
      <Reveal>
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div className="min-w-0">
            <div className="font-serif text-[15px]" style={{ color: 'var(--mute)' }}>
              {greeting()}, {firstName}
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="font-black leading-none tracking-[-.04em]"
                    style={{ fontSize: 42, color: 'var(--ink)' }}>
                <AnimatedNumber value={k.needsAttention + k.atRisk} />
              </span>
              <span className="text-[14px] font-medium" style={{ color: 'var(--mute)' }}>
                {(k.needsAttention + k.atRisk) === 1 ? 'client needs you' : 'clients need you'}
              </span>
            </div>
            <div className="text-[11px] mt-1.5 tabular-nums" style={{ color: 'var(--faint)' }}>
              {todayLabel} · {fmt1(k.avgAdherence)}% average adherence
            </div>
          </div>
        </div>
      </Reveal>

      {/* hero summary — big numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Active clients" value={k.activeClients} sub={`${k.newClients} new · ${k.inactive} inactive`} icon="◉" />
        <Kpi label="On track" value={k.onTrack} tone="text-good" icon="✓" />
        <Kpi label="Needs attention" value={k.needsAttention} tone="text-warn" icon="◐" />
        <Kpi label="At risk" value={k.atRisk} tone="text-bad" sub={`${k.attentionCount || ''} open alerts`} icon="◈" />
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* attention queue — staggered cards */}
        <Card className="lg:col-span-3 !p-0 overflow-hidden self-start">
          <div className="px-5 pt-5 pb-1">
            <Kicker>Attention required</Kicker>
          </div>
          <div className="px-3 pb-3 space-y-1.5">
            <Stagger step={70}>
              {(att.data?.clients || []).slice(0, 6).map((c) => (
                <Link key={c.clientId} to={`/app/trainer/clients/${c.clientId}`}
                  className="group flex items-center gap-3 p-3 rounded-2xl border border-line bg-white/[.02] hover:bg-white/[.05] hover:border-white/15 transition-all duration-200">
                  <Avatar name={c.name} size="w-10 h-10" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-grotesk text-sm font-semibold group-hover:text-gold transition-colors">{c.name}</span>
                      <StatusChip status={c.status} />
                    </div>
                    <div className="text-xs text-bad mt-0.5 truncate">
                      {c.rules.slice(0, 2).map((r) => r.title).join(' · ')}
                    </div>
                    <div className="text-[10px] text-faint mt-0.5 font-grotesk">
                      {c.goal.replace(/_/g, ' ')} · {c.currentWeight} → {c.targetWeight} kg · {c.adherence}% adherence
                    </div>
                  </div>
                  <span className="chip !text-[10px] group-hover:border-gold/40 group-hover:text-gold transition-colors">VIEW ›</span>
                </Link>
              ))}
            </Stagger>
            {!(att.data?.clients?.length) && (
              <div className="text-center py-10 text-mute text-sm">No clients need attention right now.</div>
            )}
          </div>
        </Card>

        {/* adherence trend */}
        <Card className="lg:col-span-2 self-start">
          <Kicker>Adherence trend · 14 days</Kicker>
          {trendRows.some((t) => t.value > 0) ? <TrendChart data={trendRows} /> : <Skeleton lines={4} />}
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            {[['ON TRACK', k.onTrack, 'text-good'], ['NEEDS ATTN', k.needsAttention, 'text-warn'], ['AT RISK', k.atRisk, 'text-bad']].map(([l, v, c]) => (
              <div key={l} className="rounded-xl border border-line bg-white/[.02] py-2.5">
                <div className={`font-grotesk font-bold text-lg ${c}`}>{v}</div>
                <div className="text-[9px] text-mute uppercase tracking-wider font-grotesk">{l}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
