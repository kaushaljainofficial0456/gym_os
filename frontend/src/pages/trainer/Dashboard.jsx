import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import AttendanceCard from '../../components/trainer/AttendanceCard.jsx';
import { TrainerPulse } from '../../components/trainer/RosterPulse.jsx';
import GymPulse from '../../components/trainer/GymPulse.jsx';
import TrainerCrowdCard from '../../components/trainer/TrainerCrowdCard.jsx';
import Icon from '../../components/Icon.jsx';
import { quickActions, tileStyle } from '../../components/trainer/workspaceNav.js';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch, fmt1, kg1 } from '../../utils.js';
import { Card, Kpi, ErrorState, StatusChip, Avatar, Skeleton } from '../../components/UI.jsx';
import { TrendChart } from '../../components/charts.jsx';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const todayLabel = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
const goalLabel = (g) => String(g || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/* The most-used things, one tap from Home, and each lands IN the action
   (the form already open) rather than on a page you then have to search. */
function QuickActions({ isOwner, unread }) {
  return (
    <section aria-label="Shortcuts" data-tour="trainer-dashboard-hero">
      <div className="ws-actions">
        {quickActions(isOwner).map((a) => (
          <Link key={a.to} to={a.to} className={`ws-action${a.tone === 'accent' ? ' is-accent' : ''}`}>
            <span className="ws-action-icon ws-tile" style={tileStyle(a.tint)}><Icon name={a.icon} size={21} strokeWidth={1.8} /></span>
            <span className="ws-action-label">{a.label}</span>
            {a.badgeKey === 'messages' && unread > 0 && <span className="ws-badge">{unread}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}

/* Clients who need a word from their coach, with why. Rendered plainly:
   it used to fade in only once scrolled into view, so it sat as an empty
   card in any capture and for anyone who never scrolled that far. */
function FollowUps({ clients, error, onRetry, limit = 6 }) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!clients.length) {
    return (
      <Card className="px-5 py-5">
        <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Everyone is on track.</div>
      </Card>
    );
  }
  return (
    <Card className="!p-0 overflow-hidden">
      {clients.slice(0, limit).map((c, i) => (
        <Link key={c.clientId} to={`/app/trainer/clients/${c.clientId}`}
          className="flex items-center gap-3.5 px-4 sm:px-5 py-3.5 transition-colors hover:bg-[var(--bg2)]"
          style={i ? { borderTop: '1px solid var(--line)' } : undefined}>
          <Avatar name={c.name} size={42} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-bold" style={{ color: 'var(--ink)' }}>{c.name}</span>
              <StatusChip status={c.status} />
            </div>
            <div className="text-[13px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>
              {c.rules.slice(0, 2).map((r) => r.title).join(' · ') || goalLabel(c.goal)}
            </div>
            <div className="text-[12.5px] mt-0.5 tabular-nums truncate" style={{ color: 'var(--faint)' }}>
              {goalLabel(c.goal)}
              {c.currentWeight != null && c.targetWeight != null ? ` · ${kg1(c.currentWeight)} → ${kg1(c.targetWeight)} kg`
                : c.currentWeight != null ? ` · ${kg1(c.currentWeight)} kg` : ''}
              {c.adherence == null ? '' : ` · ${fmt1(c.adherence)}% adherence`}
            </div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m9 18 6-6-6-6" /></svg>
        </Link>
      ))}
    </Card>
  );
}

export default function Dashboard() {
  const { user, isOwner } = useAuth();
  const isTrainerOnly = user?.role === 'TRAINER';

  // Trainers use the scoped endpoint; owners/admins use the org-wide overview.
  const ov = useFetch(() => api(isTrainerOnly ? '/dashboard/trainer' : '/dashboard/overview'));
  const att = useFetch(() => (isTrainerOnly ? Promise.resolve(null) : api('/dashboard/attention')));
  // The adherence trend is a coaching view; an owner's Home is the gym.
  const trend = useFetch(() => (isTrainerOnly ? api('/dashboard/adherence-trend') : Promise.resolve(null)));
  /* Gym-wide numbers: money, check-ins, roster. Owner-only here and on the
     server -- a trainer has no business reading the gym's takings. */
  const pulse = useFetch(() => (isTrainerOnly ? Promise.resolve(null) : api('/dashboard/pulse')));
  /* The floor right now, and which of this trainer's clients are on it.
     Failures are swallowed to null: a crowd hiccup must not take the
     dashboard down; the card simply does not render. */
  const crowd = useFetch(() => (isTrainerOnly ? api('/trainer/crowd').catch(() => null) : Promise.resolve(null)));
  const crowdClients = useFetch(() => (isTrainerOnly ? api('/trainer/crowd/clients').catch(() => null) : Promise.resolve(null)));
  const unread = useFetch(() => api('/messages/unread').catch(() => null));
  const trendRows = useMemo(() => (trend.data?.trend || []).map((t) => ({ label: t.date.slice(5), value: t.avg ?? 0 })), [trend.data]);

  const attentionClients = isTrainerOnly ? (ov.data?.attention || []) : (att.data?.clients || []);
  const firstName = user?.name?.split(' ')[0] || 'Coach';

  const header = (
    <div className="flex items-end justify-between flex-wrap gap-3">
      <div className="min-w-0">
        <h1 className="t-title">{greeting()}, {firstName}</h1>
        <p className="t-sub mt-1.5">{todayLabel()}{user?.orgName ? ` · ${user.orgName}` : ''}</p>
      </div>
    </div>
  );

  // One gate for the whole page: GymPulse arrives far taller than a
  // skeleton row, and painting without it shoved everything below ~480px
  // down when it landed (layout shift, e2e/performance.spec.js).
  if (ov.loading || (!isTrainerOnly && (att.loading || pulse.loading)) || (isTrainerOnly && (crowd.loading || crowdClients.loading || trend.loading))) {
    return (
      <div className="space-y-8">
        {header}
        <div className="ws-actions">{quickActions(!isTrainerOnly).map((a) => <div key={a.to} className="skeleton" style={{ height: 104, borderRadius: 18 }} />)}</div>
        <div className="card p-5"><Skeleton lines={4} /></div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="card p-4"><Skeleton lines={2} /></div>)}</div>
      </div>
    );
  }
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const k = ov.data.kpis;

  if (!isTrainerOnly) {
    return (
      <div className="space-y-8">
        {header}
        <QuickActions isOwner={isOwner} unread={unread.data?.total || 0} />
        <GymPulse pulse={pulse.data} kpis={k} loading={pulse.loading} error={pulse.error} onRetry={pulse.reload} />
        <section>
          <div className="ws-section-head">
            <h2 className="ws-section-title">Clients to follow up</h2>
            <Link to="/app/trainer/clients" className="ws-section-link">All clients</Link>
          </div>
          <FollowUps clients={attentionClients} error={att.error} onRetry={att.reload} />
        </section>
      </div>
    );
  }

  /* ── TRAINER ── their own clients, and their own check-in first: it is
     the first thing a trainer does on arriving. */
  const needYou = k.needsAttention + k.atRisk;
  return (
    <div className="space-y-8">
      <AttendanceCard />
      <div>
        {header}
        <p className="mt-3 text-[17px] font-bold" style={{ color: needYou ? 'var(--ink)' : 'var(--mute)' }} data-tour="trainer-dashboard-kpis">
          {needYou === 0 ? 'Every client is on track today.' : `${needYou} ${needYou === 1 ? 'client needs' : 'clients need'} you today.`}
        </p>
      </div>
      <QuickActions isOwner={false} unread={unread.data?.total || 0} />

      {(crowd.data || crowdClients.data) && <TrainerCrowdCard crowd={crowd.data} clients={crowdClients.data} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Active clients" value={k.activeClients} sub={k.newClients != null ? `${k.newClients} new · ${k.inactive} inactive` : `${k.totalClients} total · ${k.inactive} inactive`} />
        <Kpi label="On track" value={k.onTrack} sub="adherence above 70%" />
        <Kpi label="Needs attention" value={k.needsAttention} sub="starting to slip" dot="bg-bad" />
        <Kpi label="At risk" value={k.atRisk} sub="likely to drop off" dot="bg-bad" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <section className="lg:col-span-3">
          <div className="ws-section-head">
            <h2 className="ws-section-title">Clients to follow up</h2>
            <Link to="/app/trainer/clients" className="ws-section-link">All clients</Link>
          </div>
          <FollowUps clients={attentionClients} />
        </section>
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <div className="t-card mb-3">Adherence · 14 days</div>
            {trend.error ? <ErrorState error={trend.error} onRetry={trend.reload} /> : trendRows.some((t) => t.value > 0)
              ? <TrendChart data={trendRows} color="var(--m-training)" />
              : <div className="text-[14px] py-6 text-center" style={{ color: 'var(--mute)' }}>No adherence logged yet.</div>}
          </Card>
          <TrainerPulse k={k} />
        </div>
      </div>
    </div>
  );
}
