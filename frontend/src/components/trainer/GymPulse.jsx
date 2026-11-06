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
import { Card } from '../UI.jsx';
import Icon from '../Icon.jsx';
import { TINT, tileStyle } from './workspaceNav.js';

export const money = (n, currency = 'INR') => {
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


/* The API lists only months that had payments -- "nothing recorded" and
   "recorded nothing" are different claims (services/gymPulse.js). On a time
   axis that absence has to show as a gap: laid side by side, payments from
   March to August read as six consecutive months right up to now, for a gym
   that has taken nothing since. */
export function monthAxis(points, endDay, months = 6) {
  const totals = new Map(points.map((p) => [p.month, p.value]));
  const [y, m] = endDay.split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y, m - months + i, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return { month, value: totals.get(month) ?? 0 };
  });
}

/* ── a bar series with no library, so it costs nothing to load ── */
/* ₹1.4L, ₹35K, ₹2.1Cr: room for an amount over a bar a few pixels wide. */
export const moneyShort = (n) => {
  const v = Math.round(Number(n) || 0);
  if (v >= 1e7) return `₹${+(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `₹${+(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${+(v / 1e3).toFixed(1)}K`;
  return `₹${v}`;
};

export function MiniBars({ points, label, format, short, color = 'var(--m-training)', empty }) {
  const vals = points.map((p) => p.value);
  const peak = Math.max(...vals, 1);
  const total = vals.reduce((s, v) => s + v, 0);

  if (!points.length || total === 0) {
    return (
      <div className="py-6 text-center text-[11px]" style={{ color: 'var(--faint)' }}>{empty}</div>
    );
  }

  /* A handful of bars (months) each get their own label and amount. Drawn
     like the thirty daily ones, six months became three fat blocks pressed
     to one side with a label at each end, and no figure anywhere. */
  if (points.length <= 12) {
    const nameOf = (p) => (p.date ? shortDate(p.date) : shortMonth(p.month));
    return (
      <div className="flex items-end gap-1.5" style={{ height: 112 }}
           role="img" aria-label={`${label}. ${points.map((p) => `${nameOf(p)} ${format ? format(p.value) : p.value}`).join(', ')}.`}>
        {points.map((p) => (
          <div key={p.date || p.month} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full"
               title={`${nameOf(p)}: ${format ? format(p.value) : p.value}`}>
            <span className="text-[9.5px] font-semibold tabular-nums leading-none mb-1 whitespace-nowrap" style={{ color: 'var(--mute)' }}>
              {p.value > 0 ? (short ? short(p.value) : p.value) : ''}
            </span>
            <div className="w-full max-w-[28px] flex items-end" style={{ height: 72 }}>
              <div className="w-full rounded-t-[4px]"
                   style={{ height: `${p.value > 0 ? Math.max(6, (p.value / peak) * 100) : 0}%`, background: color }} />
            </div>
            <span className="w-full max-w-[28px] mt-1.5" style={{ height: 1, background: 'var(--line)' }} aria-hidden="true" />
            <span className="text-[9.5px] mt-1 tabular-nums leading-none" style={{ color: 'var(--faint)' }}>{nameOf(p)}</span>
          </div>
        ))}
      </div>
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


/* ── a smooth six-month revenue curve, drawn by hand: a chart library's
   axes and gridlines are exactly the clutter a hero card must not have ── */
function Sparkline({ points, height = 64 }) {
  const vals = points.map((p) => Number(p.value) || 0);
  const peak = Math.max(...vals, 1);
  const w = 300;
  const step = vals.length > 1 ? w / (vals.length - 1) : w;
  const xy = vals.map((v, i) => [i * step, height - 6 - (v / peak) * (height - 14)]);
  // Catmull-Rom to cubic Bezier: a gentle curve through every month.
  const d = xy.reduce((acc, [x, y], i) => {
    if (i === 0) return `M${x},${y}`;
    const [x0, y0] = xy[i - 1];
    const [xp, yp] = xy[i - 2] || xy[i - 1];
    const [xn, yn] = xy[i + 1] || [x, y];
    const c1 = [x0 + (x - xp) / 6, y0 + (y - yp) / 6];
    const c2 = [x - (xn - x0) / 6, y - (yn - y0) / 6];
    return `${acc} C${c1[0]},${Math.min(height - 2, c1[1])} ${c2[0]},${Math.min(height - 2, c2[1])} ${x},${y}`;
  }, '');
  const area = `${d} L${w},${height} L0,${height} Z`;
  const last = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full block" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id="ws-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".32" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#ws-spark)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {last && <circle cx={last[0] - 1} cy={last[1]} r="4" fill="var(--accent)" stroke="var(--panel)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/* ── membership mix as a ring ── */
const STATUS_TINT = {
  active: 'var(--m-body)', overdue: 'var(--m-energy)', pending: 'var(--m-strength)', paused: 'var(--m-strength)',
  lapsed: 'rgb(var(--tint-rgb) / .32)', expired: 'rgb(var(--tint-rgb) / .32)', cancelled: 'rgb(var(--tint-rgb) / .18)',
};
function Ring({ rows, size = 132, stroke = 16 }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--tint-rgb) / .08)" strokeWidth={stroke} />
      {rows.map((row) => {
        const len = (row.value / total) * c;
        const seg = (
          <circle key={row.status} cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={STATUS_TINT[row.status] || 'rgb(var(--tint-rgb) / .3)'} strokeWidth={stroke}
            strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt" />
        );
        offset += len;
        return seg;
      })}
    </svg>
  );
}

/* ── one number, what it is, and where to go about it ── */
function Stat({ to, label, value, sub, tone }) {
  return (
    <Link to={to} className="block rounded-2xl p-3.5 sm:p-4 transition-colors hover:bg-[rgb(var(--tint-rgb)/.05)]">
      <div className="text-[13px] font-medium" style={{ color: 'var(--mute)' }}>{label}</div>
      <div className="mt-1 font-bold tabular-nums leading-none" style={{ fontSize: 'clamp(1.5rem, 1.2rem + .9vw, 1.875rem)', letterSpacing: '-.03em', color: tone || 'var(--ink)' }}>{value}</div>
      {sub && <div className="text-[13px] mt-1.5 leading-snug" style={{ color: 'var(--faint)' }}>{sub}</div>}
    </Link>
  );
}

/* ── something that needs doing, with its colour and where to do it ── */
function AttentionRow({ to, text, detail, icon, tint }) {
  return (
    <Link to={to} className="flex items-center gap-3.5 px-4 sm:px-5 py-3.5 transition-colors hover:bg-[rgb(var(--tint-rgb)/.04)]" style={{ minHeight: 64 }}>
      <span className="ws-tile" style={{ ...tileStyle(tint), '--s': '36px' }}><Icon name={icon} size={17} strokeWidth={1.8} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-snug" style={{ color: 'var(--ink)' }}>{text}</span>
        {detail && <span className="block text-[13px] mt-0.5" style={{ color: 'var(--mute)' }}>{detail}</span>}
      </span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m9 18 6-6-6-6" /></svg>
    </Link>
  );
}

export default function GymPulse({ pulse, kpis, loading, error, onRetry }) {
  /* A skeleton, not an empty gap: the owner's most important card simply
     absent for a beat reads as the page having finished loading wrong. */
  if (loading && !pulse) {
    return <div className="card" style={{ minHeight: 260 }}><div className="p-6"><div className="skeleton h-3 w-40" /><div className="skeleton h-10 w-56 mt-4" /><div className="skeleton h-16 w-full mt-8" /></div></div>;
  }
  /* A failure says so and offers a way back, rather than a dashboard
     that looks complete and is missing half its answer. */
  if (error && !pulse) {
    return (
      <Card className="p-5">
        <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Couldn&apos;t load your gym&apos;s numbers</div>
        <div className="text-[13px] mt-1" style={{ color: 'var(--mute)' }}>Check-ins, revenue and memberships are unavailable right now.</div>
        {onRetry && <button onClick={onRetry} className="btn btn-sm mt-3">Try again</button>}
      </Card>
    );
  }
  if (!pulse) return null;
  const { today, money: m, members, series } = pulse;

  const months = monthAxis(series.revenue, today.date);
  const monthName = (key) => new Date(`${key}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long' });
  const thisMonth = months[months.length - 1];
  const lastMonth = months[months.length - 2];
  const checkins30 = (series.attendance || []).reduce((s, p) => s + (Number(p.value) || 0), 0);

  /* THE ACTION CENTRE IS DERIVED, NEVER AUTHORED. Each row exists only
     because a real count came back above zero. */
  const actions = [];
  if (m.overdueCount > 0) {
    actions.push({ to: '/app/trainer/business', icon: 'card', tint: TINT.red,
      text: `${m.overdueCount} membership${m.overdueCount > 1 ? 's' : ''} overdue`, detail: `${money(m.outstandingAmount, m.currency)} to collect` });
  } else if (m.outstandingCount > 0) {
    actions.push({ to: '/app/trainer/business', icon: 'card', tint: TINT.orange,
      text: `${m.outstandingCount} payment${m.outstandingCount > 1 ? 's' : ''} pending`, detail: money(m.outstandingAmount, m.currency) });
  }
  if (members.expiringSoon > 0) {
    actions.push({ to: '/app/trainer/clients', icon: 'calendar', tint: TINT.orange,
      text: `${members.expiringSoon} membership${members.expiringSoon > 1 ? 's' : ''} ending soon`, detail: 'Within 30 days. Renew before they lapse.' });
  }
  if (kpis?.atRisk > 0) {
    actions.push({ to: '/app/trainer/clients', icon: 'alert', tint: TINT.pink,
      text: `${kpis.atRisk} client${kpis.atRisk > 1 ? 's' : ''} at risk`, detail: 'Training or nutrition has dropped off' });
  }
  if (kpis?.inactive > 0) {
    actions.push({ to: '/app/trainer/clients', icon: 'users', tint: TINT.gray,
      text: `${kpis.inactive} client${kpis.inactive > 1 ? 's' : ''} inactive`, detail: 'No activity logged recently' });
  }
  if (today.trainersTotal > 0 && today.trainersIn < today.trainersTotal) {
    const missing = today.trainersTotal - today.trainersIn;
    actions.push({ to: '/app/trainer/attendance?tab=trainers', icon: 'whistle', tint: TINT.purple,
      text: `${missing} trainer${missing > 1 ? 's' : ''} not checked in`, detail: "Today's roster" });
  }

  const ringRows = members.byStatus.filter((r) => r.value > 0);
  const ringTotal = ringRows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="space-y-8">
      {/* ── the hero: money first, then the four numbers that run the day ── */}
      <section aria-label="This month" className="card !p-0 overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="p-5 sm:p-7 flex flex-col">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--mute)' }}>Collected in {monthName(thisMonth.month)}</div>
            <Link to="/app/trainer/business" className="mt-1.5 font-bold tabular-nums leading-none w-fit"
              style={{ fontSize: 'clamp(2.5rem, 1.9rem + 2.4vw, 3.5rem)', letterSpacing: '-.04em', color: 'var(--ink)' }}>
              {money(m.collectedThisMonth, m.currency)}
            </Link>
            <div className="text-[14px] mt-2.5" style={{ color: 'var(--mute)' }}>
              {m.paymentsThisMonth > 0 ? `${m.paymentsThisMonth} payment${m.paymentsThisMonth > 1 ? 's' : ''}` : 'No payments yet'}
              {lastMonth ? ` · ${monthName(lastMonth.month)} ${money(lastMonth.value, m.currency)}` : ''}
            </div>
            <div className="mt-auto pt-6">
              <Sparkline points={months} />
              <div className="flex justify-between mt-2 text-[12px] tabular-nums" style={{ color: 'var(--faint)' }}>
                {months.map((p) => <span key={p.month}>{new Date(`${p.month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</span>)}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1 p-2.5 sm:p-3 lg:border-l" style={{ borderColor: 'var(--line)', background: 'rgb(var(--tint-rgb) / .025)' }}>
            <Stat to="/app/trainer/clients" label="Active members" value={kpis?.activeClients ?? '—'}
              sub={kpis?.newClients != null ? `${kpis.newClients} joined in 30 days` : null} />
            <Stat to="/app/trainer/attendance" label="Check-ins today" value={today.checkIns}
              sub={today.trainersTotal > 0 ? `${today.trainersIn} of ${today.trainersTotal} trainers in` : 'No trainers yet'} />
            <Stat to="/app/trainer/business" label="To collect" value={money(m.outstandingAmount, m.currency)}
              tone={m.overdueCount > 0 ? 'var(--bad)' : undefined}
              sub={m.outstandingCount > 0 ? `${m.outstandingCount} membership${m.outstandingCount > 1 ? 's' : ''}${m.overdueCount ? `, ${m.overdueCount} overdue` : ''}` : 'Everyone is paid up'} />
            <Stat to="/app/trainer/clients" label="Ending soon" value={members.expiringSoon}
              sub="memberships, next 30 days" />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        {/* ── what needs you ── */}
        <section className="xl:col-span-3">
          <div className="ws-section-head">
            <h2 className="ws-section-title">Needs your attention</h2>
            {actions.length > 0 && <span className="ws-count">{actions.length}</span>}
          </div>
          <Card className="!p-0 overflow-hidden">
            {actions.length ? actions.map((a, i) => (
              <div key={a.text} style={i ? { borderTop: '1px solid var(--line)' } : undefined}><AttentionRow {...a} /></div>
            )) : (
              <div className="flex items-center gap-3.5 px-5 py-5">
                <span className="ws-tile" style={{ ...TINT.green, '--s': '36px' }}><Icon name="check" size={17} strokeWidth={1.8} /></span>
                <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>All clear. Nothing needs you right now.</span>
              </div>
            )}
          </Card>
        </section>

        {/* ── the shape of the gym ── */}
        <div className="xl:col-span-2 space-y-6">
          <section>
            <div className="ws-section-head"><h2 className="ws-section-title">Memberships</h2></div>
            <Card className="p-5">
              {ringRows.length ? (
                <div className="flex items-center gap-5">
                  <div className="relative">
                    <Ring rows={ringRows} />
                    <div className="absolute inset-0 grid place-items-center text-center">
                      <div>
                        <div className="text-[26px] font-bold tabular-nums leading-none" style={{ color: 'var(--ink)' }}>{ringTotal}</div>
                        <div className="text-[12px] mt-1" style={{ color: 'var(--mute)' }}>total</div>
                      </div>
                    </div>
                  </div>
                  <ul className="flex-1 min-w-0 space-y-2">
                    {ringRows.map((r) => (
                      <li key={r.status} className="flex items-center gap-2.5 text-[14px]">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_TINT[r.status] || 'rgb(var(--tint-rgb) / .3)' }} />
                        <span className="flex-1 capitalize truncate" style={{ color: 'var(--mute)' }}>{r.status}</span>
                        <span className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{r.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <div className="text-[15px] py-4" style={{ color: 'var(--mute)' }}>No memberships yet.</div>}
            </Card>
          </section>

          <section>
            <div className="ws-section-head">
              <h2 className="ws-section-title">Check-ins</h2>
              <span className="text-[13px]" style={{ color: 'var(--mute)' }}>{checkins30} in {series.days} days</span>
            </div>
            <Card className="p-5">
              <MiniBars points={series.attendance} label={`Daily check-ins over ${series.days} days`} color="var(--accent)" empty="No check-ins yet." />
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
