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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthName = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long' });

/* The header is the gym and the day, the way a dashboard is titled, not a
   chat-style greeting. A name stored in capitals ("IRONFORGE FITNESS") is
   shown in title case; one in mixed case is left exactly as the owner typed it. */
const gymTitle = (name) => {
  const n = String(name || '').trim();
  if (!n) return 'Overview';
  return n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s\-/&(])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase()) : n;
};
const todayLabel = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function Header({ user, children }) {
  return (
    <div className="oh-head">
      <div className="min-w-0">
        <p className="oh-date">{todayLabel()}</p>
        <h1 className="t-title oh-title">{gymTitle(user?.orgName)}</h1>
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

  return (
    <div className="oh">
      <Header user={user}><div className="oh-new"><NewMenu /></div></Header>

      <section aria-labelledby="oh-glance" data-tour="trainer-dashboard-hero">
        <h2 id="oh-glance" className="sr-only">Key numbers</h2>
        <div className="oh-glance">
          {pulseError && !pulse ? <GlanceError onRetry={onPulseRetry} /> : (
            <>
              <Glance to="/app/trainer/business" icon="rupee" tint={TINT.green} label="Money this month"
                value={pulse ? money(m.collectedThisMonth, m.currency) : '—'} say={moneySay} up={moneyUp} more="See payments" />
              <Glance to="/app/trainer/clients" icon="users" tint={TINT.blue} label="Active members"
                value={kpis?.activeClients ?? '—'}
                say={kpis?.newClients != null ? `${kpis.newClients} joined in the last 30 days` : kpis ? `${kpis.totalClients} in total` : null}
                up={kpis?.newClients > 0 ? true : null} more="See members" />
              <Glance to="/app/trainer/attendance" icon="door" tint={TINT.purple} label="Came in today"
                value={today ? today.checkIns : '—'}
                say={pulse ? (perDay > 0 ? `Usually about ${perDay} a day` : 'No check-ins in the last 30 days') : null}
                more="See attendance" />
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="oh-todo" className="card oh-todo" data-tour="trainer-dashboard-kpis">
        <div className="oh-todo-head">
          <h2 id="oh-todo" className="oh-todo-title">To do today</h2>
          {count > 0 && <span className="ws-count">{count}</span>}
        </div>
        {rows.map(({ key, after, ...row }) => (
          <div key={key}>
            <TodoRow {...row} />
            {after}
          </div>
        ))}
        {attentionError && (
          <div style={{ borderTop: '1px solid var(--line)' }}>
            <ErrorState error={attentionError} onRetry={onAttentionRetry} />
          </div>
        )}
        {count === 0 && (
          <div className="oh-done">
            <span className="ws-tile" style={{ ...TINT.green, '--s': '42px' }}><Icon name="check" size={19} strokeWidth={2} /></span>
            All done. Nothing needs you right now.
          </div>
        )}
      </section>
    </div>
  );
}

/* Shaped like the page it stands in for, so nothing jumps when the
   numbers land (e2e/performance.spec.js holds Home to a CLS under 0.1). */
export function OwnerHomeSkeleton({ user }) {
  return (
    <div className="oh" aria-busy="true">
      <Header user={user} />
      <section>
        <div className="oh-glance">
          {[0, 1, 2].map((i) => <div key={i} className="card oh-card" style={{ minHeight: 190 }}><div className="skeleton h-3 w-32" /><div className="skeleton h-9 w-40 mt-5" /><div className="skeleton h-3 w-44 mt-4" /></div>)}
        </div>
      </section>
      <section className="card oh-todo" style={{ minHeight: 280 }}>
        <div className="oh-todo-head"><div className="skeleton h-5 w-36" /></div>
        {[0, 1, 2].map((i) => <div key={i} className="oh-row"><div className="skeleton rounded-full" style={{ width: 42, height: 42 }} /><div className="flex-1"><div className="skeleton h-3.5 w-48" /><div className="skeleton h-3 w-32 mt-2" /></div></div>)}
      </section>
    </div>
  );
}
