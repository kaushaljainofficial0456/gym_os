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
  const isTrainerOnly = user?.role === 'TRAINER';

  // Trainers use the scoped endpoint; owners/admins use the org-wide overview
  const ov = useFetch(() => api(isTrainerOnly ? '/dashboard/trainer' : '/dashboard/overview'));
  const att = useFetch(() => isTrainerOnly ? Promise.resolve(null) : api('/dashboard/attention'));
  const trend = useFetch(() => api('/dashboard/adherence-trend'));
  const trendRows = useMemo(() => (trend.data?.trend || []).map(t => ({ label: t.date.slice(5), value: t.avg ?? 0 })), [trend.data]);

  // For trainers, attention data comes from the trainer endpoint response
  const attentionClients = isTrainerOnly
    ? (ov.data?.attention || [])
    : (att.data?.clients || []);

  if (ov.loading || (!isTrainerOnly && att.loading) || trend.loading) {
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
        <div className="flex items-end justify-between flex-wrap gap-4" data-tour="trainer-dashboard-hero">
          <div className="min-w-0">
            <div className="font-serif text-[15px]" style={{ color: 'var(--mute)' }}>
              {greeting()}, {firstName}
            </div>
            {/* One uniform headline, not a big-number + small-caption split.
                42 -> 50px and the whole phrase (not just the digit) now
                shares the same font-black weight and ink colour, matching
                the reference exactly rather than the split-hierarchy
                treatment this had before. */}
            <div className="mt-2 flex items-baseline gap-2.5 flex-wrap">
              {/* Size (50px) and weight (font-black) unchanged -- only the
                  typeface moves, to Bricolage Grotesque specifically for
                  this headline. Every other trainer heading stays Satoshi;
                  this is a one-element swap, not a section-wide font
                  change. */}
              <span className="font-black leading-[1.05] tracking-[-.03em]"
                    style={{ fontSize: 50, color: 'var(--ink)', fontFamily: "'Bricolage Grotesque', system-ui, sans-serif" }}>
                <AnimatedNumber value={k.needsAttention + k.atRisk} />
                {' '}
                {(k.needsAttention + k.atRisk) === 1 ? 'client needs you today' : 'clients need you today'}
              </span>
            </div>
            <div className="text-[11px] mt-1.5 tabular-nums" style={{ color: 'var(--faint)' }}>
              {todayLabel} · {fmt1(k.avgAdherence)}% average adherence
            </div>
          </div>
        </div>
      </Reveal>

      {/* hero summary — big numbers.
          Numbers were coloured per-tile (sage/amber/terracotta) via
          `tone`; the reference shows all four numbers in plain ink and
          reserves colour for a single small dot on the two tiles that
          actually need one. Dropped `tone` here. Also collapsed the two
          dot hues to one: amber-vs-terracotta was a second colour
          distinction the reference doesn't make -- both actionable tiles
          use the same accent-family dot now. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-tour="trainer-dashboard-kpis">
        <Kpi label="Active clients" value={k.activeClients} sub={k.newClients != null ? `${k.newClients} new · ${k.inactive} inactive` : `${k.totalClients} total · ${k.inactive} inactive`} />
        <Kpi label="On track" value={k.onTrack} sub="adherence above 70%" />
        <Kpi label="Needs attention" value={k.needsAttention} dot="bg-bad" />
        <Kpi label="At risk" value={k.atRisk} sub={`${k.attentionCount || ''} open alerts`} dot="bg-bad" />
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* attention queue — staggered cards */}
        <Card className="lg:col-span-3 !p-0 overflow-hidden self-start">
          <div className="px-5 pt-5 pb-1">
            <Kicker>Attention required</Kicker>
          </div>
          <div className="px-3 pb-3 space-y-1.5">
            <Stagger step={70}>
              {attentionClients.slice(0, 6).map((c) => (
                <Link key={c.clientId} to={`/app/trainer/clients/${c.clientId}`}
                  className="group flex items-center gap-3 p-3 rounded-2xl border border-line bg-white/[.02] hover:bg-white/[.05] hover:border-white/15 transition-all duration-200">
                  <Avatar name={c.name} size="w-10 h-10" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-grotesk text-sm font-semibold group-hover:text-gold transition-colors">{c.name}</span>
                      <StatusChip status={c.status} />
                    </div>
                    {/* Was text-bad on every row regardless of severity --
                        a NEEDS_ATTENTION client's reason line shouted as
                        loud as an AT_RISK one, and doubled the coloured
                        surface the StatusChip badge already carries right
                        above it. The badge alone is the status signal now;
                        the reason line stays calm so it's readable, not
                        alarming. */}
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--mute)' }}>
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
            {!(attentionClients.length) && (
              <div className="text-center py-10 text-mute text-sm">🎉 No clients need attention right now.</div>
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
