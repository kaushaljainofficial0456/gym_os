/**
 * THE OWNER'S HOME -- two questions, answered plainly.
 *
 *   How is my gym doing?        three numbers: money this month, active
 *                               members, who came in today
 *   What do I need to do today? a short to-do list, one button each
 *
 * It used to open with eight shortcut tiles, a revenue hero with four more
 * numbers, an attention list, a membership ring, a check-in chart and a
 * client list -- everything at once, which owners read as "confusing".
 * Nothing was dropped, only moved one step away:
 *   - the shortcuts are behind "+ New" (NewMenu.jsx);
 *   - the membership mix and the 30-day check-ins are on Reports
 *     (GymPulse.jsx, rendered by Analytics.jsx), beside revenue by month;
 *   - "Clients to follow up" opens in place under its to-do row.
 *
 * NOTHING IS INVENTED. Every to-do row exists only because a real count
 * came back above zero, and a number that failed to load says so with a
 * way to try again, never a reassuring empty state.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../Icon.jsx';
import { ErrorState } from '../UI.jsx';
import NewMenu from './NewMenu.jsx';
import FollowUps from './FollowUps.jsx';
import { money, monthAxis } from './GymPulse.jsx';
import { TINT, tileStyle } from './workspaceNav.js';
import { CountUp } from './wsMotion.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthName = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long' });

/* The header greets the owner by name, with the day and the gym beneath
   it in one quiet line -- not a chatty "here's how your gym is doing"
   sentence. A gym name stored in capitals ("IRONFORGE FITNESS") is shown
   in title case; one in mixed case is left exactly as the owner typed it. */
const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};
const gymTitle = (name) => {
  const n = String(name || '').trim();
  return n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s\-/&(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase()) : n;
};
const todayLabel = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });

function Header({ user, children }) {
  return (
    <div className="oh-head">
      <div className="min-w-0">
        <h1 className="t-title oh-title">{greeting()}, {user?.name?.split(' ')[0] || 'there'}</h1>
        <p className="oh-sub">{[todayLabel(), gymTitle(user?.orgName)].filter(Boolean).join(' · ')}</p>
      </div>
      {children}
    </div>
  );
}

const Arrow = ({ up }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={up ? 'var(--good)' : 'var(--bad)'} strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {up ? <path d="M3 17l6-6 4 4 7-7M15 8h6v6" /> : <path d="M3 7l6 6 4-4 7 7M15 16h6v-6" />}
  </svg>
);
const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
);

/* ── one number, in a sentence, and where to go about it ── */
function Glance({ to, icon, tint, label, value, say, up, more }) {
  return (
    <Link to={to} className="card oh-card">
      <div className="oh-card-body">
        <div className="oh-card-top">
          <span className="ws-tile" style={{ ...tileStyle(tint), '--s': '34px' }}><Icon name={icon} size={17} strokeWidth={1.8} /></span>
          <span className="oh-card-label">{label}</span>
          <span className="oh-go"><Chevron /></span>
        </div>
        <div className="oh-value">{value}</div>
        {say && <div className="oh-say">{up != null && <Arrow up={up} />}<span>{say}</span></div>}
      </div>
      <div className="oh-more">{more}<Chevron /></div>
    </Link>
  );
}

/* ── the gym's numbers did not load: say so, and offer a way back ── */
function GlanceError({ onRetry }) {
  return (
    <div className="card p-5" role="alert" style={{ gridColumn: '1 / -1' }}>
      <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Couldn&apos;t load your gym&apos;s numbers</div>
      <div className="text-[13px] mt-1" style={{ color: 'var(--mute)' }}>Money, members and check-ins are unavailable right now.</div>
      {onRetry && <button type="button" onClick={onRetry} className="btn btn-sm mt-3">Try again</button>}
    </div>
  );
}

function TodoRow({ icon, tint, title, sub, action }) {
  return (
    <div className="oh-row">
      <span className="ws-tile" style={{ ...tileStyle(tint), '--s': '42px' }}><Icon name={icon} size={19} strokeWidth={1.8} /></span>
      <div className="oh-row-main">
        <div className="oh-row-title">{title}</div>
        {sub && <div className="oh-row-sub">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

const names = (clients) => {
  const first = clients.slice(0, 2).map((c) => c.name);
  const rest = clients.length - first.length;
  return rest > 0 ? `${first.join(', ')} and ${rest} more` : first.join(' and ');
};

export default function OwnerHome({ user, kpis, pulse, pulseError, onPulseRetry, attention, attentionError, onAttentionRetry }) {
  const [openFollowUps, setOpenFollowUps] = useState(false);
  const listId = useId();

  const m = pulse?.money;
  const today = pulse?.today;
  const series = pulse?.series;

  /* ── at a glance ── */
  let moneySay = null;
  let moneyUp = null;
  if (pulse) {
    const months = monthAxis(series.revenue || [], today.date);
    const last = months[months.length - 2];
    const diff = (Number(m.collectedThisMonth) || 0) - (last?.value || 0);
    if (last && last.value > 0) {
      const name = monthName(last.month);
      if (diff > 0) { moneySay = `${money(diff, m.currency)} more than ${name}`; moneyUp = true; }
      else if (diff < 0) { moneySay = `${money(-diff, m.currency)} behind ${name} so far`; moneyUp = false; }
      else moneySay = `Level with ${name}`;
    } else {
      moneySay = m.paymentsThisMonth > 0 ? `${plural(m.paymentsThisMonth, 'payment')} so far` : 'No payments yet this month';
    }
  }
  const visits = (series?.attendance || []).reduce((s, p) => s + (Number(p.value) || 0), 0);
  const perDay = series?.days ? Math.round(visits / series.days) : 0;

  /* ── to do today: derived, never authored ── */
  const followUps = attention || [];
  const rows = [];
  if (m?.outstandingCount > 0) {
    const pending = m.outstandingCount - (m.overdueCount || 0);
    rows.push({
      key: 'collect', icon: 'rupee', tint: m.overdueCount > 0 ? TINT.red : TINT.orange,
      title: `Collect ${money(m.outstandingAmount, m.currency)}`,
      sub: m.overdueCount > 0
        ? `${plural(m.overdueCount, 'membership')} overdue${pending > 0 ? `, ${pending} more due` : ''}`
        : `${plural(m.outstandingCount, 'payment')} pending`,
      action: <Link to="/app/trainer/business" className="btn-primary btn-sm oh-row-act">Collect</Link>,
    });
  }
  if (pulse?.members?.expiringSoon > 0) {
    rows.push({
      key: 'renew', icon: 'calendar', tint: TINT.orange,
      title: `Renew ${plural(pulse.members.expiringSoon, 'membership')}`,
      sub: 'Ending in the next 30 days',
      action: <Link to="/app/trainer/clients?money=EXPIRING" className="btn btn-sm oh-row-act">Renew</Link>,
    });
  }
  if (!attentionError && followUps.length > 0) {
    rows.push({
      key: 'follow', icon: 'userx', tint: TINT.pink,
      title: `${plural(followUps.length, 'client')} to follow up`,
      sub: names(followUps),
      action: (
        <button type="button" className="btn btn-sm oh-row-act" aria-expanded={openFollowUps} aria-controls={listId}
          onClick={() => setOpenFollowUps((v) => !v)}>
          {openFollowUps ? 'Hide' : 'See who'}
        </button>
      ),
      after: openFollowUps && (
        <div id={listId} className="oh-followups">
          <FollowUps clients={followUps} bare limit={6} />
          {followUps.length > 6 && (
            <Link to="/app/trainer/clients" className="flex items-center justify-between px-5 py-3.5 text-[14px] font-semibold"
              style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
              All clients<Chevron />
            </Link>
          )}
        </div>
      ),
    });
  }
  if (kpis?.inactive > 0) {
    rows.push({
      key: 'inactive', icon: 'users', tint: TINT.gray,
      title: `${plural(kpis.inactive, 'client')} inactive`,
      sub: 'No activity logged recently',
      action: <Link to="/app/trainer/clients?status=INACTIVE" className="btn btn-sm oh-row-act">See them</Link>,
    });
  }
  if (today?.trainersTotal > 0 && today.trainersIn < today.trainersTotal) {
    const missing = today.trainersTotal - today.trainersIn;
    rows.push({
      key: 'trainers', icon: 'whistle', tint: TINT.purple,
      title: `${plural(missing, 'trainer')} not checked in`,
      sub: `${today.trainersIn} of ${today.trainersTotal} in today`,
      action: <Link to="/app/trainer/attendance?tab=trainers" className="btn btn-sm oh-row-act">View</Link>,
    });
  }
  const count = rows.length + (attentionError ? 1 : 0);

  /* ── market-standard health numbers (Gymdesk, Glofox, MyStudio all
     lead with these): revenue per member, renewals, engagement ── */
  const months = pulse ? monthAxis(series.revenue || [], today.date) : [];
  const peak = Math.max(1, ...months.map((x) => Number(x.value) || 0));
  const perMember = pulse && kpis?.activeClients > 0 ? (Number(m.collectedThisMonth) || 0) / kpis.activeClients : null;
  // Where the month is heading at today's rate -- shown once a week of it
  // has passed, before that a projection is a guess.
  const day = today ? Number(today.date.slice(8, 10)) : 0;
  const monthDays = today ? new Date(Number(today.date.slice(0, 4)), Number(today.date.slice(5, 7)), 0).getDate() : 30;
  const pace = pulse && day >= 7 && m.collectedThisMonth > 0 ? (m.collectedThisMonth / day) * monthDays : null;
  const cur = m?.currency || 'INR';
  const spark = (series?.attendance || []).map((p) => Number(p.value) || 0);
  const sparkPeak = Math.max(1, ...spark);

  return (
    <div className="td">
      <Header user={user}><div className="oh-new"><NewMenu /></div></Header>

      {pulseError && !pulse ? <GlanceError onRetry={onPulseRetry} /> : (
        <div className="td-top">
          {/* THE HERO: this month's money, and the months before it. */}
          <Link to="/app/trainer/business" className="td-hero" data-tour="trainer-dashboard-hero" aria-label={`Collected in ${monthName(today?.date?.slice(0, 7) || '2026-01')}: ${pulse ? money(m.collectedThisMonth, cur) : 'loading'}`}>
            <div className="td-hero-head">
              <span className="ws-tile" style={{ ...tileStyle(TINT.green), '--s': '34px' }}><Icon name="rupee" size={17} strokeWidth={1.8} /></span>
              <span>Collected in {today ? monthName(today.date.slice(0, 7)) : 'this month'}</span>
              <span className="oh-go td-go"><Chevron /></span>
            </div>
            <div className="td-hero-value">{pulse ? <CountUp value={m.collectedThisMonth} format={(n) => money(n, cur)} /> : '—'}</div>
            {moneySay && <div className="td-hero-say">{moneyUp != null && <Arrow up={moneyUp} />}<span>{moneySay}</span></div>}
            <div className="td-hero-foot">
              {(moneyUp != null || pace) && <span>{[moneyUp != null ? plural(m?.paymentsThisMonth || 0, 'payment') : null, pace ? `on pace for ${money(pace, cur)}` : null].filter(Boolean).join(' · ')}</span>}
              {m?.outstandingAmount > 0 && <span className="td-due">{money(m.outstandingAmount, cur)} to collect</span>}
            </div>
            {months.length > 0 && (
              <div className="td-bars" aria-hidden="true">
                {months.map((x, i) => (
                  <div key={x.month} className={`td-bar${i === months.length - 1 ? ' is-now' : ''}`}>
                    <i style={{ '--h': `${Math.max(3, Math.round(((Number(x.value) || 0) / peak) * 100))}%`, animationDelay: `${120 + i * 45}ms` }} />
                    <span>{new Date(`${x.month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</span>
                  </div>
                ))}
              </div>
            )}
          </Link>

          {/* RIGHT NOW: the floor, today. */}
          <Link to="/app/trainer/attendance" className="td-now">
            <div className="td-now-head"><span className="td-live" aria-hidden="true" />Today at the gym<span className="oh-go td-go"><Chevron /></span></div>
            <div className="td-now-grid">
              <div><div className="td-now-value">{today ? <CountUp value={today.checkIns} /> : '—'}</div><div className="td-now-label">checked in</div></div>
              <div><div className="td-now-value">{today ? `${today.trainersIn}/${today.trainersTotal}` : '—'}</div><div className="td-now-label">trainers in</div></div>
            </div>
            {spark.length > 0 && (
              <div className="td-spark" aria-hidden="true">
                {spark.map((v, i) => <i key={i} style={{ '--h': `${Math.max(4, Math.round((v / sparkPeak) * 100))}%` }} className={i === spark.length - 1 ? 'is-now' : undefined} />)}
              </div>
            )}
            <div className="td-now-say">{pulse ? (perDay > 0 ? `Check-ins, last 30 days · about ${perDay} a day` : visits > 0 ? `${plural(visits, 'check-in')} in the last 30 days` : 'No check-ins in the last 30 days') : ''}</div>
          </Link>
        </div>
      )}

      {/* FOUR HEALTH NUMBERS -- each one a link to where it lives. */}
      <section aria-labelledby="td-health">
        <h2 id="td-health" className="sr-only">Gym health</h2>
        <div className="td-kpis">
          <Link to="/app/trainer/clients" className="td-kpi">
            <span className="td-kpi-label">Active members</span>
            <span className="td-kpi-value">{kpis ? <CountUp value={kpis.activeClients} /> : '—'}</span>
            <span className="td-kpi-say">{kpis?.newClients > 0 ? <><Arrow up />{kpis.newClients} joined in 30 days</> : 'No new members in 30 days'}</span>
          </Link>
          <Link to="/app/trainer/analytics" className="td-kpi">
            <span className="td-kpi-label">Revenue per member</span>
            <span className="td-kpi-value">{perMember != null ? <CountUp value={perMember} format={(n) => money(n, cur)} /> : '—'}</span>
            <span className="td-kpi-say">This month so far</span>
          </Link>
          <Link to="/app/trainer/clients?money=EXPIRING" className="td-kpi">
            <span className="td-kpi-label">Renewals due</span>
            <span className="td-kpi-value">{pulse ? <CountUp value={pulse.members?.expiringSoon || 0} /> : '—'}</span>
            <span className="td-kpi-say">In the next 30 days</span>
          </Link>
          <Link to="/app/trainer/alerts" className="td-kpi">
            <span className="td-kpi-label">Workouts done</span>
            <span className="td-kpi-value">{kpis?.workoutCompletion != null ? <><CountUp value={kpis.workoutCompletion} />%</> : '—'}</span>
            <span className="td-kpi-say">{kpis?.atRisk > 0 ? `${plural(kpis.atRisk, 'member')} at risk` : 'Of what was scheduled'}</span>
          </Link>
        </div>
      </section>

      {/* NEEDS YOU: every row is real -- a count came back above zero. */}
      <section aria-labelledby="oh-todo" className="td-todo" data-tour="trainer-dashboard-kpis">
        <div className="td-todo-head">
          <h2 id="oh-todo" className="td-todo-title">Needs you today</h2>
          {count > 0 && <span className="ws-count">{count}</span>}
        </div>
        <div className="ws-group">
          {rows.map(({ key, after, ...row }) => (
            <div key={key} className="td-row-wrap">
              <TodoRow {...row} />
              {after}
            </div>
          ))}
          {attentionError && (
            <div className="td-row-wrap">
              <ErrorState error={attentionError} onRetry={onAttentionRetry} />
            </div>
          )}
          {count === 0 && (
            <div className="oh-done">
              <span className="ws-tile" style={{ ...TINT.green, '--s': '42px' }}><Icon name="check" size={19} strokeWidth={2} /></span>
              All done. Nothing needs you right now.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* Shaped like the page it stands in for, so nothing jumps when the
   numbers land (e2e/performance.spec.js holds Home to a CLS under 0.1). */
export function OwnerHomeSkeleton({ user }) {
  return (
    <div className="td" aria-busy="true">
      <Header user={user} />
      <div className="td-top">
        <div className="td-hero"><div className="skeleton h-4 w-44" /><div className="skeleton h-12 w-56 mt-5" /><div className="skeleton h-3 w-52 mt-4" /><div className="td-bars td-bars--ghost" /></div>
        <div className="td-now"><div className="skeleton h-4 w-36" /><div className="skeleton h-10 w-40 mt-6" /><div className="skeleton h-3 w-48 mt-5" /></div>
      </div>
      <div className="td-kpis">
        {[0, 1, 2, 3].map((i) => <div key={i} className="td-kpi"><div className="skeleton h-3 w-28" /><div className="skeleton h-8 w-20 mt-3" /><div className="skeleton h-3 w-32 mt-3" /></div>)}
      </div>
      <section className="td-todo">
        <div className="td-todo-head"><div className="skeleton h-5 w-36" /></div>
        <div className="ws-group" style={{ minHeight: 220 }}>
          {[0, 1, 2].map((i) => <div key={i} className="oh-row"><div className="skeleton rounded-full" style={{ width: 42, height: 42 }} /><div className="flex-1"><div className="skeleton h-3.5 w-48" /><div className="skeleton h-3 w-32 mt-2" /></div></div>)}
        </div>
      </section>
    </div>
  );
}
