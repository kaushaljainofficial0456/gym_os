/**
 * PROGRESS — the weekly report, body measurements and milestones.
 *
 * Split out of Progress.jsx purely for file size: these three sections are
 * self-contained and read better beside each other than buried in a
 * 1,000-line page. They follow the same rules as everything else on
 * Progress — nothing is rendered unless real rows back it, and no number
 * is fabricated to fill a card.
 */
import { useState } from 'react';
import { Card } from '../../components/UI.jsx';
import MetricChart from '../../components/MetricChart.jsx';

const n1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());

/* ══════════════════════════ this week ══════════════════════════ */

/**
 * The weekly report. Compares against last week ONLY when there is a last
 * week to compare against — a first-week user gets their real numbers
 * without a meaningless "+100%" pinned beside them.
 */
export function WeekSection({ week, Section, Stat }) {
  if (!week) return null;
  if (!week.workouts && !week.nutritionDays && !week.prs) return null;

  const Delta = ({ now, before, unit = '' }) => {
    if (!week.hasPrevious || before == null || before === 0 || now == null) return null;
    const d = now - before;
    if (d === 0) {
      return <span className="text-[10px]" style={{ color: 'var(--faint)' }}>same as last week</span>;
    }
    return (
      <span className="text-[10px] font-semibold tabular-nums" style={{ color: d > 0 ? 'var(--good)' : 'var(--faint)' }}>
        {d > 0 ? '+' : ''}{Math.round(d)}{unit} vs last week
      </span>
    );
  };

  return (
    <Section title="This week">
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Workouts" value={week.workouts || 0} />
          <Stat label="Volume" value={fmtNum(week.volume || 0)} unit="kg" />
          <Stat label="Food logged" value={week.nutritionDays || 0} sub="days" />
        </div>

        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          <Delta now={week.workouts} before={week.previousWorkouts} />
          <Delta now={week.avgProtein} before={week.previousAvgProtein} unit="g protein" />
        </div>

        {week.prs > 0 && (
          <div className="mt-2.5 text-[11.5px]" style={{ color: 'var(--mute)' }}>
            <strong style={{ color: 'var(--accent)' }}>
              {week.prs} personal record{week.prs === 1 ? '' : 's'}
            </strong>{' '}
            this week.
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ measurements ══════════════════════════ */

const MEASURE_LABEL = {
  waist: 'Waist', chest: 'Chest', arms: 'Arms', thighs: 'Thighs', hips: 'Hips', neck: 'Neck',
};

function analyze(series) {
  if (!series?.length) return null;
  const vals = series.map((p) => p.value);
  const first = series[0].value;
  const last = series[series.length - 1].value;
  return { current: last, change: last - first, count: series.length, min: Math.min(...vals), max: Math.max(...vals) };
}

/**
 * Body measurements as one selectable chart rather than six stacked cards.
 * Only parts the user has ACTUALLY recorded become tabs — a "Chest" tab
 * with no chest readings is the empty-card problem wearing a different hat.
 */
export function MeasurementsSection({ measurements, Section, ChipRow, NeedMore }) {
  const keys = Object.keys(measurements || {}).filter((k) => measurements[k]?.length);
  const [sel, setSel] = useState(null);
  if (!keys.length) return null;

  const active = keys.includes(sel) ? sel : keys[0];
  const series = measurements[active];
  const a = analyze(series);

  return (
    <Section title="Measurements">
      <Card className="p-4">
        {keys.length > 1 && (
          <ChipRow
            options={keys.map((k) => ({ key: k, label: MEASURE_LABEL[k] || k }))}
            value={active}
            onChange={setSel}
            ariaLabel="Body measurement"
          />
        )}

        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>
              {MEASURE_LABEL[active] || active}
            </div>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-[26px] font-black leading-none tabular-nums tracking-[-.03em]" style={{ color: 'var(--ink)' }}>
                {n1(a.current)}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--faint)' }}>cm</span>
            </div>
          </div>
          {a.count > 1 && (
            <div className="text-right">
              {/* Down is the desirable direction for most circumference
                  measurements, so a reduction reads as positive. */}
              <div
                className="text-[13px] font-bold tabular-nums"
                style={{ color: a.change < 0 ? 'var(--good)' : a.change > 0 ? 'var(--warn)' : 'var(--faint)' }}
              >
                {a.change > 0 ? '+' : ''}{n1(a.change)} cm
              </div>
              <div className="text-[9.5px]" style={{ color: 'var(--faint)' }}>since first</div>
            </div>
          )}
        </div>

        {series.length >= 2 ? (
          <div className="mt-2">
            <MetricChart
              points={series}
              color="var(--good)"
              unit="cm"
              decimals={1}
              height={150}
              ariaLabel={`${MEASURE_LABEL[active] || active} measurements over time`}
            />
          </div>
        ) : (
          <div className="mt-3">
            <NeedMore need={1} what={(MEASURE_LABEL[active] || active).toLowerCase()} />
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ milestones ══════════════════════════ */

/**
 * Milestones the data has ACTUALLY passed.
 *
 * Nothing aspirational and nothing locked-and-greyed: a wall of un-earned
 * badges is the gamified look this product is explicitly not going for,
 * and it also tells the user what they haven't done, which is the opposite
 * of the point. If none are earned yet the section doesn't render at all.
 */
export function AchievementsSection({ intel, Section }) {
  const earned = [];
  const w = intel.weight?.analysis;
  const trained = intel.consistency?.trainedDays?.length || 0;
  const prTotal = intel.prs?.total || 0;
  const best = intel.consistency?.streak?.best || 0;

  if (w && w.change != null && w.change <= -5) {
    earned.push({ label: `${Math.abs(Math.round(w.change))} kg down`, detail: 'since your first logged weight' });
  }
  for (const n of [10, 25, 50, 100]) {
    if (trained >= n) earned.push({ label: `${n} training days`, detail: 'logged and qualifying' });
  }
  for (const n of [1, 10, 25, 50]) {
    if (prTotal >= n) earned.push({ label: `${n} personal record${n === 1 ? '' : 's'}`, detail: 'across all exercises' });
  }
  if (best >= 7) {
    earned.push({ label: `${best}-day streak`, detail: 'your longest run so far' });
  }

  if (!earned.length) return null;
  // The most recent/highest tiers are the interesting ones; earlier tiers
  // stay earned but stop taking up space.
  const shown = earned.slice(-6);

  return (
    <Section title="Milestones">
      <div className="grid grid-cols-2 gap-2.5">
        {shown.map((e, i) => (
          <div key={i} className="rounded-[var(--r-lg)] p-3" style={{ border: '1px solid var(--line)' }}>
            <div className="text-[12.5px] font-bold leading-tight" style={{ color: 'var(--ink)' }}>{e.label}</div>
            <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--faint)' }}>{e.detail}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
