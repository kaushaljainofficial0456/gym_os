/**
 * TODAY'S BURN — the itemized day.
 *
 * Answers "what did I actually burn, and where did every calorie come
 * from" as a list you can audit line by line, rather than one number you
 * have to trust. Reads GET /api/health/burn-breakdown, which composes
 * already-reconciled rows (see backend/src/services/health/
 * dailyIntelligence.js's getBurnBreakdown) -- opening this screen never
 * triggers a recompute.
 *
 * The honesty rules the design follows:
 *  - resting, workouts and everyday movement are SEPARATE lines that sum
 *    to the total, so the total is never a black box.
 *  - a measured figure and an estimated one never look alike: estimates
 *    carry an explicit "Estimated" tag.
 *  - when a wearable measured a session, SK OS's own estimate is shown
 *    NEXT TO it rather than being silently replaced -- that difference is
 *    information, not an error to hide.
 *  - an unknown value renders as "—" with the reason, never as 0.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { PageHeader, PageSkeleton, ErrorState, Card, Empty } from '../../components/UI.jsx';
import ActivityRings from '../../components/ActivityRings.jsx';
import { PROVIDER_LABEL } from '../../healthProviderLabels.js';

// Default goals. These are GOALS, not measurements, and are labelled as
// such everywhere they appear -- no attempt is made to pass an arbitrary
// default off as personalised.
const GOALS = { move: 500, exercise: 30, steps: 10000 };

const TYPE_META = {
  resting: { icon: '◍', tint: 'var(--faint)' },
  workout: { icon: '▲', tint: 'var(--accent)' },
  movement: { icon: '↗', tint: 'var(--warn)' },
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function timeLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function sourceLabel(entry) {
  if (entry.source === 'skos_bmr') return 'Barbell';
  if (entry.source === 'skos_steps') return 'Step count';
  if (PROVIDER_LABEL[entry.source]) return PROVIDER_LABEL[entry.source];
  return 'Barbell';
}

function Num({ value, unit = 'kcal', size = 'text-[15px]' }) {
  if (value == null) {
    return <span className={`${size} font-bold tabular-nums`} style={{ color: 'var(--faint)' }}>—</span>;
  }
  return (
    <span className={`${size} font-bold tabular-nums`} style={{ color: 'var(--ink)' }}>
      {Math.round(value).toLocaleString()}
      <span className="ml-1 text-[10px] font-medium" style={{ color: 'var(--faint)' }}>{unit}</span>
    </span>
  );
}

function EntryRow({ entry }) {
  const meta = TYPE_META[entry.type] || TYPE_META.workout;
  const start = timeLabel(entry.startTime);
  const end = timeLabel(entry.endTime);
  const when = entry.type === 'resting'
    ? 'Across the day'
    : (start ? (end ? `${start} – ${end}` : start) : 'Throughout the day');

  return (
    <div className="flex items-start gap-3 py-3.5" style={{ borderTop: '1px solid var(--line)' }}>
      <span className="mt-0.5 text-[13px] leading-none" style={{ color: meta.tint }} aria-hidden="true">{meta.icon}</span>

      <div className="min-w-0 flex-1">
        {/* wrap rather than truncate: at ~360px the badge was squeezing
            real labels down to "Everyd..." / "Resti...". */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)' }}>{entry.label}</span>
          {entry.isEstimate && (
            <span className="shrink-0 rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[.06em]"
              style={{ color: 'var(--faint)', border: '1px solid var(--line)' }}>
              Estimated
            </span>
          )}
        </div>

        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--faint)' }}>
          {when} · {sourceLabel(entry)}
          {entry.sublabel ? ` · ${entry.sublabel}` : ''}
        </div>

        {/* Both numbers, side by side -- the wearable's measurement and
            what Barbell would have estimated on its own. */}
        {entry.comparison && entry.comparison.skosEstimateKcal != null && (
          <div className="mt-1.5 text-[10.5px]" style={{ color: 'var(--mute)' }}>
            {sourceLabel(entry)} measured {Math.round(entry.comparison.measuredKcal)} · Barbell estimated{' '}
            {Math.round(entry.comparison.skosEstimateKcal)}
          </div>
        )}

        {entry.detail && !entry.comparison && (
          <div className="mt-1 text-[10.5px]" style={{ color: 'var(--faint)' }}>{entry.detail}</div>
        )}

        {entry.dataQuality === 'suspicious' && (
          <div className="mt-1 text-[10.5px]" style={{ color: 'var(--warn)' }}>
            Flagged — this session's duration looks implausible, so no energy was counted for it.
          </div>
        )}
      </div>

      <div className="shrink-0 pt-0.5 text-right">
        <Num value={entry.kcal} />
      </div>
    </div>
  );
}

export default function BurnDetail() {
  const nav = useNavigate();
  const [date, setDate] = useState(todayKey());
  const fetchState = useFetch(() => api(`/health/burn-breakdown?date=${date}`), [date]);

  const isToday = date === todayKey();
  const b = fetchState.data?.breakdown;

  const rings = b ? {
    move: { value: b.totals.active, goal: GOALS.move },
    exercise: {
      value: b.entries
        .filter((e) => e.type === 'workout' && e.durationSeconds)
        .reduce((s, e) => s + e.durationSeconds / 60, 0) || null,
      goal: GOALS.exercise,
    },
    steps: { value: b.steps, goal: GOALS.steps },
  } : null;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Health intelligence"
        title={isToday ? "Today's burn" : 'Daily burn'}
        sub={isToday ? 'So far today' : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
        onBack={() => nav(-1)}
      />

      {/* Day stepper -- "next" is disabled on today rather than hidden, so
          the control does not jump around as you move through days. */}
      <div className="flex items-center justify-between">
        <button className="btn btn-sm" onClick={() => setDate(shiftDate(date, -1))}>← Previous</button>
        {!isToday && <button className="btn btn-sm" onClick={() => setDate(todayKey())}>Today</button>}
        <button className="btn btn-sm" disabled={isToday} onClick={() => setDate(shiftDate(date, 1))}>Next →</button>
      </div>

      {fetchState.loading && <PageSkeleton variant="list" label="Loading your day" />}
      {fetchState.error && <ErrorState error={fetchState.error} onRetry={fetchState.reload} />}

      {!fetchState.loading && !fetchState.error && !b && (
        <Empty
          title="Nothing recorded yet"
          hint="Log a workout or connect a wearable and this day will fill in."
        />
      )}

      {/* Gated on !loading as well as on data: useFetch keeps the previous
          response while the next one is in flight, which meant switching
          days briefly showed yesterday's totals under today's heading. */}
      {b && !fetchState.loading && (
        <>
          <Card className="p-5">
            <div className="flex flex-col items-center">
              <ActivityRings values={rings} size={190} />

              <div className="mt-5 text-center">
                <div className="t-micro" style={{ color: 'var(--faint)' }}>Total burned</div>
                <div className="mt-1">
                  <Num value={b.totals.total} size="text-[34px]" />
                </div>
                {b.totals.total == null && (
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--faint)' }}>
                    Add your height, weight, age and sex in your profile to see a full-day total.
                  </div>
                )}
              </div>
            </div>

            {/* resting vs active, the two halves of the total */}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl p-3" style={{ border: '1px solid var(--line)' }}>
                <div className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Resting</div>
                <div className="mt-1"><Num value={b.totals.resting} /></div>
              </div>
              <div className="rounded-xl p-3" style={{ border: '1px solid var(--line)' }}>
                <div className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Active</div>
                <div className="mt-1"><Num value={b.totals.active} /></div>
              </div>
            </div>

            {b.activeSource === 'wearable_daily_total' && (
              <div className="mt-3 text-[10.5px]" style={{ color: 'var(--faint)' }}>
                Active energy comes from your wearable's own whole-day figure, so individual
                sessions below are shown for detail rather than added on top.
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="section-head !mb-1">
              <span className="t-micro">Where it came from</span>
              {b.providers?.length > 0 && (
                <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
                  {b.providers.filter((p) => PROVIDER_LABEL[p]).map((p) => PROVIDER_LABEL[p]).join(' · ') || 'Barbell'}
                </span>
              )}
            </div>

            {b.entries.length === 0 ? (
              <div className="py-6 text-center text-[12px]" style={{ color: 'var(--faint)' }}>
                Nothing recorded for this day yet.
              </div>
            ) : (
              <div className="mt-1">
                {b.entries.map((e, i) => <EntryRow key={`${e.type}-${i}`} entry={e} />)}
              </div>
            )}
          </Card>

          <button className="btn w-full" onClick={() => nav('/app/client/health')}>
            Manage connected devices
          </button>
        </>
      )}
    </div>
  );
}
