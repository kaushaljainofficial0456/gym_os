/**
 * GYM PULSE — the gym's shape, for Reports.
 *
 * This used to be the whole owner Home: a revenue hero, four more
 * numbers, an action centre, a membership ring and a check-in chart, all
 * on the first screen. Home is now three numbers and a to-do list
 * (OwnerHome.jsx); the trends that were here moved, intact, to Reports
 * (GymTrends below, rendered by Analytics.jsx), beside revenue by month.
 * The helpers (money, monthAxis, MiniBars) are shared with Payments.
 *
 * NOTHING IS INVENTED. A gym with no payments recorded gets a no-data
 * state, not a flat line at zero — those are different claims, and
 * quietly drawing the second one is how a dashboard starts lying.
 */
import { Card } from '../UI.jsx';

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

/**
 * The membership mix and the last 30 days of check-ins: what Home's ring
 * and bar chart showed, now under "Right now" on Reports.
 */
export function GymTrends({ pulse }) {
  const { members, series } = pulse;
  const ringRows = members.byStatus.filter((r) => r.value > 0);
  const ringTotal = ringRows.reduce((s, r) => s + r.value, 0);
  const checkins30 = (series.attendance || []).reduce((s, p) => s + (Number(p.value) || 0), 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
      <section>
        <div className="ws-section-head">
          <h2 className="ws-section-title">Memberships</h2>
          {members.expiringSoon > 0 && (
            <span className="text-[13px]" style={{ color: 'var(--mute)' }}>{members.expiringSoon} ending in 30 days</span>
          )}
        </div>
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
  );
}
