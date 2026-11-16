import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import AttendanceCard from '../../components/trainer/AttendanceCard.jsx';
import { TrainerPulse } from '../../components/trainer/RosterPulse.jsx';
import OwnerHome, { OwnerHomeSkeleton } from '../../components/trainer/OwnerHome.jsx';
import FollowUps from '../../components/trainer/FollowUps.jsx';
import TrainerCrowdCard from '../../components/trainer/TrainerCrowdCard.jsx';
import Icon from '../../components/Icon.jsx';
import { quickActions, tileStyle } from '../../components/trainer/workspaceNav.js';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch } from '../../utils.js';
import { Card, Kpi, ErrorState, Skeleton } from '../../components/UI.jsx';
import { TrendChart } from '../../components/charts.jsx';
import CallbackCard from '../../components/trainer/CallbackCard.jsx';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const todayLabel = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

/* The most-used things, one tap from Home, and each lands IN the action
   (the form already open) rather than on a page you then have to search. */
function QuickActions({ unread }) {
  return (
    <section aria-label="Shortcuts" data-tour="trainer-dashboard-hero">
      <div className="ws-actions">
        {quickActions(false).map((a) => (
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

export default function Dashboard() {
  const { user } = useAuth();
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
  // The shortcut badge is on a trainer's Home only; an owner's unread count is in the shell.
  const unread = useFetch(() => (isTrainerOnly ? api('/messages/unread').catch(() => null) : Promise.resolve(null)));
  const trendRows = useMemo(() => (trend.data?.trend || []).map((t) => ({ label: t.date.slice(5), value: t.avg ?? 0 })), [trend.data]);

  const attentionClients = ov.data?.attention || [];
  const firstName = user?.name?.split(' ')[0] || 'Coach';

  const header = (
    <div className="flex items-end justify-between flex-wrap gap-3">
      <div className="min-w-0">
        <h1 className="t-title">{greeting()}, {firstName}</h1>
        <p className="t-sub mt-1.5">{todayLabel()}{user?.orgName ? ` · ${user.orgName}` : ''}</p>
      </div>
    </div>
  );

  // One gate for the whole page, and a skeleton shaped like it: painting
  // the page in pieces as each request landed shoved everything below down
  // (layout shift, e2e/performance.spec.js).
  if (!isTrainerOnly && (ov.loading || att.loading || pulse.loading)) return <OwnerHomeSkeleton user={user} />;
  if (ov.loading || (isTrainerOnly && (crowd.loading || crowdClients.loading || trend.loading))) {
    return (
      <div className="space-y-8">
        {header}
        <div className="ws-actions">{quickActions(false).map((a) => <div key={a.to} className="skeleton" style={{ height: 104, borderRadius: 18 }} />)}</div>
        <div className="card p-5"><Skeleton lines={4} /></div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="card p-4"><Skeleton lines={2} /></div>)}</div>
      </div>
    );
  }
  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const k = ov.data.kpis;

  /* ── OWNER ── three numbers and a to-do list (OwnerHome.jsx). */
  if (!isTrainerOnly) {
    return (
      <OwnerHome
        user={user}
        kpis={k}
        pulse={pulse.data}
        pulseError={pulse.error}
        onPulseRetry={pulse.reload}
        attention={att.data?.clients}
        attentionError={att.error}
        onAttentionRetry={att.reload}
      />
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
      <QuickActions unread={unread.data?.total || 0} />
      <CallbackCard />

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
