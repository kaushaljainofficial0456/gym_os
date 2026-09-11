/**
 * ANALYTICS — why the revenue number moved.
 *
 * WHAT EXISTED BEFORE. One chart, revenue by month, on the Business page.
 * Revenue is an OUTPUT: it tells an owner what happened and nothing about
 * what caused it. The inputs underneath it — who joined, who left, and
 * whether anyone is actually turning up — had no view at all.
 *
 * SO EVERY SERIES HERE IS A CAUSE, NOT A RESTATEMENT. Joins against
 * departures is the one an owner acts on: revenue can hold steady for a
 * month while the membership quietly churns underneath it, and that is
 * precisely the month you want to notice.
 *
 * WHAT IS DELIBERATELY ABSENT. No lifetime value, no forecast, no
 * projected churn. The schema records joins, subscription states,
 * payments and attendance; a projection built on that would be a number
 * an owner might genuinely plan around, and it would be made up. Where
 * the data is thin the page says so rather than drawing a confident flat
 * line along zero.
 */
import { useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Kicker, ErrorState, PageSkeleton } from '../../components/UI.jsx';

const WINDOWS = [[6, '6 months'], [12, '12 months'], [24, '24 months']];

const monthLabel = (key) => {
  const [y, m] = String(key).split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function Analytics() {
  const [months, setMonths] = useState(6);
  const { data, loading, error, reload } = useFetch(
    () => api(`/admin/analytics?months=${months}`), [months]);

  if (loading) return <PageSkeleton variant="dashboard" label="Loading analytics" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const { series = [], totals = {}, churnPct, activeMembers, hasRevenue, hasAttendance } = data || {};

  return (
    <div className="space-y-5 pb-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl tracking-tight">Analytics</h1>
          <p className="text-mute text-sm">Joins, departures, revenue and footfall — what moved and when.</p>
        </div>
        <div className="flex gap-1.5">
          {WINDOWS.map(([value, label]) => (
            <button
              key={value} type="button" onClick={() => setMonths(value)} aria-pressed={months === value}
              className="rounded-lg px-2.5 text-[11.5px] font-semibold"
              style={{
                minHeight: 34,
                background: months === value ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${months === value ? 'var(--accent)' : 'var(--line)'}`,
                color: months === value ? 'var(--accent)' : 'var(--mute)',
              }}
            >{label}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Joined" value={totals.joined} hue="var(--m-body)" sub={`over ${months} months`} />
        <Stat label="Left" value={totals.left} hue="var(--m-energy)" sub="subscriptions ended" />
        <Stat
          label="Net change"
          value={(totals.joined || 0) - (totals.left || 0)}
          hue={(totals.joined || 0) - (totals.left || 0) >= 0 ? 'var(--m-body)' : 'var(--m-energy)'}
          sub={`${activeMembers} active now`}
          signed
        />
        {/* Churn against nobody is not 0% -- it is unmeasurable, and a
            green 0% on an empty gym reads as an achievement. */}
        <Stat
          label="Churn"
          value={churnPct}
          hue={churnPct == null ? 'var(--mute)' : churnPct > 10 ? 'var(--m-energy)' : 'var(--m-body)'}
          sub={churnPct == null ? 'no members to measure' : 'of members on the books'}
          suffix="%"
        />
      </div>

      <Card>
        <Kicker>Members joined vs left</Kicker>
        {/* The two series sit back to back on a shared baseline rather
            than stacked: stacking them would make the total look like
            growth, when the thing being read is the GAP between them. */}
        {series.some((m) => m.joined || m.left) ? (
          <GroupedBars
            rows={series}
            series={[
              ['joined', 'Joined', 'var(--m-body)'],
              ['left', 'Left', 'var(--m-energy)'],
            ]}
          />
        ) : (
          <Blank>No joins or departures recorded in this window.</Blank>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <Kicker>Revenue by month</Kicker>
          {hasRevenue ? (
            <GroupedBars rows={series} series={[['revenue', 'Revenue', 'var(--m-training)']]} format={money} />
          ) : (
            <Blank>No payments recorded in this window.</Blank>
          )}
          <div className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
            Total {money(totals.revenue)} from recorded payments
          </div>
        </Card>

        <Card>
          <Kicker>Gym visits</Kicker>
          {hasAttendance ? (
            <GroupedBars rows={series} series={[['visits', 'Visits', 'var(--m-recovery)']]} />
          ) : (
            <Blank>No attendance marked in this window.</Blank>
          )}
          <div className="text-[11px] mt-2" style={{ color: 'var(--faint)' }}>
            {Number(totals.visits || 0).toLocaleString('en-IN')} member check-ins
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, hue, sub, suffix = '', signed }) {
  const missing = value == null;
  const shown = missing ? '—' : `${signed && value > 0 ? '+' : ''}${value}${suffix}`;
  return (
    <div className="rounded-xl px-3 py-3" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <div className="t-micro">{label}</div>
      <div className="font-grotesk font-black tabular-nums mt-1"
        style={{ fontSize: 24, letterSpacing: '-.03em', color: missing ? 'var(--mute)' : hue }}>
        {shown}
      </div>
      <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>{sub}</div>
    </div>
  );
}

/**
 * Bars, drawn from the data's own maximum.
 *
 * Built from divs rather than a chart library because the shape is
 * trivial and the library's defaults (its own palette, its own tooltip)
 * would have to be fought back to the app's. Heights are relative to the
 * largest value across ALL series shown, so two series in one chart stay
 * comparable to each other — scaling each to its own max would make a
 * month with 2 departures look the same height as one with 40 joins.
 */
function GroupedBars({ rows, series, format }) {
  const max = Math.max(1, ...rows.flatMap((r) => series.map(([key]) => Number(r[key]) || 0)));

  return (
    <div>
      <div className="flex items-end gap-1.5 mt-1" style={{ height: 132 }}>
        {rows.map((r) => (
          <div key={r.month} className="flex-1 min-w-0 flex flex-col items-center gap-1">
            <div className="w-full flex items-end justify-center gap-[3px]" style={{ height: 110 }}>
              {series.map(([key, label, hue]) => {
                const v = Number(r[key]) || 0;
                return (
                  <div
                    key={key}
                    title={`${label}: ${format ? format(v) : v}`}
                    style={{
                      width: series.length > 1 ? 9 : 18,
                      // A real zero keeps a visible sliver so the month
                      // reads as "measured, and it was zero" rather than
                      // as a gap where no bar was drawn at all.
                      height: `${Math.max(v > 0 ? 4 : 2, (v / max) * 110)}px`,
                      background: v > 0 ? hue : 'var(--line)',
                      borderRadius: 3,
                      transition: 'height .5s var(--ease-out)',
                    }}
                  />
                );
              })}
            </div>
            <div className="text-[9.5px] truncate w-full text-center" style={{ color: 'var(--faint)' }}>
              {monthLabel(r.month)}
            </div>
          </div>
        ))}
      </div>

      {series.length > 1 && (
        <div className="flex gap-3 mt-2.5">
          {series.map(([key, label, hue]) => (
            <span key={key} className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--mute)' }}>
              <span className="rounded-full" style={{ width: 8, height: 8, background: hue }} />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Blank({ children }) {
  return (
    <div className="text-[12px] py-10 text-center" style={{ color: 'var(--mute)' }}>{children}</div>
  );
}
