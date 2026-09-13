/**
 * GYM PULSE — the owner's control centre.
 *
 * The dashboard could tell an owner how their CLIENTS were doing and
 * almost nothing about how their GYM was doing. Adherence scores and an
 * at-risk list, and then nothing about who walked in today, what money
 * is actually outstanding, whether the trainers turned up, or what any
 * of it looked like last week. "Revenue ₹0" sat on the page all
 * September while August had taken ₹1.4 lakh, and the screen offered no
 * way to know that.
 *
 * THREE THINGS, IN THE ORDER AN OWNER ASKS THEM:
 *
 *   What is happening right now      — the hero strip
 *   What needs me                    — the action centre
 *   Where is this heading            — the trends
 *
 * EVERY TILE GOES SOMEWHERE. A number you cannot act on is decoration,
 * and a dashboard of decoration is why owners stop opening dashboards.
 * Each one is a link to the screen where you'd do something about it.
 *
 * AND NOTHING IS INVENTED. A gym with no payments recorded gets a
 * no-data state, not a flat line at zero — those are different claims,
 * and quietly drawing the second one is how a dashboard starts lying.
 */
import { Link } from 'react-router-dom';
import { Card, Kicker } from '../UI.jsx';

const money = (n, currency = 'INR') => {
  const v = Number(n) || 0;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency, maximumFractionDigits: 0,
    }).format(v);
  } catch { return `₹${Math.round(v).toLocaleString('en-IN')}`; }
};

const shortDate = (key) => {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const shortMonth = (key) => {
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short' });
};

/* ── one headline number, and the screen it leads to ── */
function PulseTile({ to, label, value, sub, tone, ariaSuffix }) {
  return (
    <Link
      to={to}
      className="card p-4 block transition-transform active:scale-[.99] hover:shadow-md focus-visible:outline-2"
      style={{ minHeight: 96 }}
      aria-label={`${label}: ${value}${ariaSuffix ? `. ${ariaSuffix}` : ''}`}
    >
      <div className="text-[9.5px] font-bold uppercase tracking-[.11em]" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="mt-1.5 font-grotesk text-[26px] font-black leading-none tabular-nums tracking-[-.02em]"
           style={{ color: tone || 'var(--ink)' }}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[10.5px] leading-snug" style={{ color: 'var(--mute)' }}>{sub}</div>}
    </Link>
  );
}

/* ── a bar series with no library, so it costs nothing to load ── */
function MiniBars({ points, label, format, color = 'var(--m-training)', empty }) {
  const vals = points.map((p) => p.value);
  const peak = Math.max(...vals, 1);
  const total = vals.reduce((s, v) => s + v, 0);

  if (!points.length || total === 0) {
    return (
      <div className="py-6 text-center text-[11px]" style={{ color: 'var(--faint)' }}>{empty}</div>
    );
  }

  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: 92 }}
           role="img" aria-label={`${label}. ${points.length} points, highest ${format ? format(peak) : peak}.`}>
        {points.map((p) => (
          <div key={p.date || p.month} className="flex-1 min-w-[3px] flex items-end" style={{ height: '100%' }}
               title={`${p.date ? shortDate(p.date) : shortMonth(p.month)}: ${format ? format(p.value) : p.value}`}>
            <div className="w-full rounded-t-[2px]"
                 style={{
                   height: `${Math.max(p.value > 0 ? 4 : 0, (p.value / peak) * 100)}%`,
                   background: color,
                   opacity: p.value > 0 ? 1 : 0,
                 }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9.5px] mt-1.5 tabular-nums" style={{ color: 'var(--faint)' }}>
        <span>{points[0].date ? shortDate(points[0].date) : shortMonth(points[0].month)}</span>
        <span>{points[points.length - 1].date ? shortDate(points[points.length - 1].date) : shortMonth(points[points.length - 1].month)}</span>
      </div>
    </div>
  );
}

/* ── something that needs doing, and where to do it ── */
function ActionRow({ to, text, detail, level }) {
  const tone = level === 'urgent' ? 'var(--bad)' : level === 'important' ? 'var(--warn)' : 'var(--mute)';
  return (
    <Link to={to} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg2)]"
          style={{ minHeight: 56 }}>
      {/* A dot alone would be colour-as-only-signal; the text carries it. */}
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tone }} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{text}</span>
        {detail && <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>{detail}</span>}
      </span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.5"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Link>
  );
}

export default function GymPulse({ pulse, kpis, loading, error, onRetry }) {
  /* A skeleton, not an empty gap. The rest of the dashboard renders
     immediately off a different fetch, so without this the owner's most
     important strip was simply absent for a beat and then appeared --
     which reads as the page having finished loading wrong. */
  if (loading && !pulse) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card p-4" style={{ minHeight: 96 }}>
            <div className="skeleton h-2.5 w-1/2" />
            <div className="skeleton h-6 w-2/3 mt-3" />
            <div className="skeleton h-2 w-3/4 mt-3" />
          </div>
        ))}
      </div>
    );
  }

  /* A failure says so and offers a way back. Returning null here would
     silently drop the gym's money and roster off the screen, leaving a
     dashboard that looks complete and is missing half its answer. */
  if (error && !pulse) {
    return (
      <Card className="p-5">
        <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
          Couldn&apos;t load your gym&apos;s numbers
        </div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>
          Check-ins, revenue and memberships are unavailable right now.
        </div>
        {onRetry && (
          <button onClick={onRetry} className="mt-3 rounded-full px-4 text-[11.5px] font-semibold"
                  style={{ minHeight: 40, border: '1px solid var(--line)', color: 'var(--ink)' }}>
            Try again
          </button>
        )}
      </Card>
    );
  }

  if (!pulse) return null;
  const { today, money: m, members, series } = pulse;

  const trainersSub = today.trainersTotal > 0
    ? `${today.trainersIn} of ${today.trainersTotal} checked in`
    : 'No trainers added yet';

  /* THE ACTION CENTRE IS DERIVED, NEVER AUTHORED. Each row below exists
     only because a real count came back above zero, so an owner with a
     quiet gym sees "nothing needs you", not a list of manufactured
     worries. */
  const actions = [];
  if (m.overdueCount > 0) {
    actions.push({
      to: '/app/trainer/business', level: 'urgent',
      text: `${m.overdueCount} membership${m.overdueCount > 1 ? 's' : ''} overdue on payment`,
      detail: `${money(m.outstandingAmount, m.currency)} outstanding in total`,
    });
  } else if (m.outstandingCount > 0) {
    actions.push({
      to: '/app/trainer/business', level: 'important',
      text: `${m.outstandingCount} payment${m.outstandingCount > 1 ? 's' : ''} still pending`,
      detail: money(m.outstandingAmount, m.currency),
    });
  }
  if (members.expiringSoon > 0) {
    actions.push({
      to: '/app/trainer/clients', level: 'important',
      text: `${members.expiringSoon} membership${members.expiringSoon > 1 ? 's' : ''} expiring within 30 days`,
      detail: 'Renew before they lapse',
    });
  }
  if (kpis?.atRisk > 0) {
    actions.push({
      to: '/app/trainer/clients', level: 'urgent',
      text: `${kpis.atRisk} client${kpis.atRisk > 1 ? 's' : ''} at risk`,
      detail: 'Adherence has dropped below the gym’s thresholds',
    });
  }
  if (kpis?.inactive > 0) {
    actions.push({
      to: '/app/trainer/clients', level: 'important',
      text: `${kpis.inactive} client${kpis.inactive > 1 ? 's' : ''} inactive`,
      detail: 'No logged activity recently',
    });
  }
  if (today.trainersTotal > 0 && today.trainersIn < today.trainersTotal) {
    const missing = today.trainersTotal - today.trainersIn;
    actions.push({
      to: '/app/trainer/attendance', level: 'normal',
      text: `${missing} trainer${missing > 1 ? 's have' : ' has'} not checked in today`,
      detail: 'Check the attendance roster',
    });
  }

  return (
    <div className="space-y-5">
      {/* ── right now ── */}
      <div>
        <Kicker>Your gym today</Kicker>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
          <PulseTile
            to="/app/trainer/clients"
            label="Active members"
            value={kpis?.activeClients ?? '—'}
            sub={kpis?.newClients != null ? `${kpis.newClients} joined in 30 days` : null}
          />
          <PulseTile
            to="/app/trainer/attendance"
            label="Check-ins today"
            value={today.checkIns}
            sub={trainersSub}
          />
          <PulseTile
            to="/app/trainer/reports"
            label="Collected this month"
            value={money(m.collectedThisMonth, m.currency)}
            sub={m.paymentsThisMonth > 0
              ? `${m.paymentsThisMonth} payment${m.paymentsThisMonth > 1 ? 's' : ''} recorded`
              : 'Nothing recorded yet this month'}
          />
          <PulseTile
            to="/app/trainer/business"
            label="Outstanding"
            value={money(m.outstandingAmount, m.currency)}
            tone={m.overdueCount > 0 ? 'var(--bad)' : undefined}
            sub={m.outstandingCount > 0
              ? `${m.outstandingCount} membership${m.outstandingCount > 1 ? 's' : ''}${m.overdueCount ? ` · ${m.overdueCount} overdue` : ''}`
              : 'Everyone is paid up'}
          />
        </div>
      </div>

      {/* ── what needs you ── */}
      <Card className="!p-0 overflow-hidden">
        <div className="px-4 pt-4 pb-2">
          <Kicker>Needs your attention</Kicker>
        </div>
        {actions.length ? (
          <div style={{ borderTop: '1px solid var(--line)' }}>
            {actions.map((a) => (
              <div key={a.text} style={{ borderBottom: '1px solid var(--line)' }}>
                <ActionRow {...a} />
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 pb-5 pt-1 text-[11.5px]" style={{ color: 'var(--faint)' }}>
            Nothing needs you right now — no overdue payments, no expiring memberships, no at-risk clients.
          </div>
        )}
      </Card>

      {/* ── start something ──
          Only routes that genuinely exist and genuinely do the thing.
          A quick action that opens a screen where the action lives is a
          real shortcut; one that opens a screen where it does not is the
          dead button this whole pass is meant to remove. */}
      <div>
        <Kicker>Start something</Kicker>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {[
            { to: '/app/trainer/clients', label: 'Add a client', hint: 'New member' },
            { to: '/app/trainer/trainers', label: 'Add a trainer', hint: 'Staff' },
            { to: '/app/trainer/workouts', label: 'Build a workout', hint: 'Template' },
            { to: '/app/trainer/attendance', label: 'Attendance', hint: 'Roster & codes' },
            { to: '/app/trainer/business', label: 'Memberships', hint: 'Plans & payments' },
          ].map((a) => (
            <Link key={a.to} to={a.to}
                  className="card p-3 block transition-transform active:scale-[.98] hover:shadow-md"
                  style={{ minHeight: 60 }}>
              <div className="text-[12px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{a.label}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>{a.hint}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* ── where it's heading ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card className="p-4">
          <Kicker>Check-ins · {series.days} days</Kicker>
          <div className="mt-2">
            <MiniBars
              points={series.attendance} label={`Daily check-ins over ${series.days} days`}
              color="var(--m-training)"
              empty="No check-ins recorded yet. They'll appear here as members are marked in."
            />
          </div>
        </Card>

        <Card className="p-4">
          <Kicker>Revenue · by month</Kicker>
          <div className="mt-2">
            <MiniBars
              points={series.revenue} label="Revenue by month"
              color="var(--m-body)" format={(v) => money(v, m.currency)}
              empty="No payments recorded yet. Revenue appears once payments are logged."
            />
          </div>
        </Card>

        <Card className="p-4">
          <Kicker>Memberships</Kicker>
          {members.byStatus.length ? (
            <div className="mt-3 space-y-2">
              {members.byStatus.map((s) => {
                const total = members.byStatus.reduce((acc, x) => acc + x.value, 0) || 1;
                const pct = (s.value / total) * 100;
                const tone = s.status === 'active' ? 'var(--good)'
                  : s.status === 'overdue' ? 'var(--bad)'
                    : s.status === 'expired' ? 'var(--warn)' : 'var(--mute)';
                return (
                  <div key={s.status}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11.5px] capitalize" style={{ color: 'var(--mute)' }}>{s.status}</span>
                      <span className="font-grotesk text-[12px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                        {s.value}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
                    </div>
                  </div>
                );
              })}
              {members.expiringSoon > 0 && (
                <div className="text-[10.5px] pt-1" style={{ color: 'var(--faint)' }}>
                  {members.expiringSoon} expiring within 30 days
                </div>
              )}
            </div>
          ) : (
            <div className="py-6 text-center text-[11px]" style={{ color: 'var(--faint)' }}>
              No memberships recorded yet.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
