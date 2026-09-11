/**
 * PROGRESS 2.0 — SK OS personal performance intelligence.
 *
 * The old page answered one narrow question ("what did I weigh?") with a
 * weight input that dominated the first screen. This one answers three:
 *
 *   BODY         how is my body changing?
 *   PERFORMANCE  how am I performing?
 *   RECOVERY     how is my body responding?   (only when data exists)
 *
 * ARCHITECTURAL RULES THIS FILE FOLLOWS
 *
 * 1. Sections are DERIVED from capabilities, never assumed. The backend
 *    reports, per metric, whether real rows exist (see
 *    services/progress/progressIntel.js). A user with no wearable never
 *    sees an empty Sleep/HRV/Recovery card -- those sections are absent,
 *    replaced by ONE compact "unlock" module. A wall of "--" cards makes
 *    a product feel broken; hiding what isn't there makes it feel honest.
 *
 * 2. No fabricated numbers, anywhere. Every figure traces to a stored
 *    row. Where a trend isn't supported by enough data the UI says what
 *    is still needed rather than drawing a confident line through noise.
 *
 * 3. Trend/insight maths lives in the backend (services/progress/*), so
 *    there is exactly one implementation of "what changed".
 *
 * 4. Weight logging still exists but is now secondary -- progress first,
 *    data entry second.
 *
 * Deep link: /app/client/progress?section=prs opens Personal Records
 * directly (Workout's "My PRs" action links here).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Card, Modal, Empty } from '../../components/UI.jsx';
import MetricChart from '../../components/MetricChart.jsx';
import PeriodChart from '../../components/PeriodChart.jsx';
import { WeekSection, MeasurementsSection, AchievementsSection, StrengthProgressSection } from './ProgressSections.jsx';
import { RecoverySection, TransformationSection } from './ProgressRecovery.jsx';
import Icon from '../../components/Icon.jsx';
import Ring from '../../components/Ring.jsx';

const PERIODS = [
  { key: 7, label: '7D' },
  { key: 30, label: '30D' },
  { key: 90, label: '90D' },
  { key: 180, label: '6M' },
  { key: 365, label: '1Y' },
];

const INSIGHT_TONE = {
  positive: 'var(--good)',
  milestone: 'var(--m-pr)',
  warning: 'var(--warn)',
  observation: 'var(--faint)',
};

const PR_TYPE_LABEL = {
  heaviest_weight: 'Heaviest weight',
  best_reps: 'Most reps',
  est_1rm: 'Est. 1RM',
  best_volume: 'Best set volume',
};

const n1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const n0 = (v) => (v == null ? null : Math.round(v));
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());
const relDay = (iso) => {
  if (!iso) return '';
  const d = Math.round((Date.now() - Date.parse(`${iso}T00:00:00`)) / 86400000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
};

/* ══════════════════════════ small primitives ══════════════════════════ */

function Section({ title, action, children, id }) {
  return (
    <section id={id} className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A number with its label. The number carries the weight, literally. */
function Stat({ label, value, unit, tone, sub }) {
  return (
    <div className="min-w-0">
      {/* Wraps rather than truncates: at 360px a four-across row clipped
          real labels to "SESSIO..." / "ADHER...". Two short lines read;
          a severed word does not. */}
      <div className="text-[9.5px] font-semibold uppercase leading-tight tracking-[.06em]" style={{ color: 'var(--faint)' }}>{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[19px] font-black leading-none tabular-nums tracking-[-.02em]" style={{ color: tone || 'var(--ink)' }}>
          {value ?? '—'}
        </span>
        {unit && value != null && <span className="text-[10px] font-medium" style={{ color: 'var(--faint)' }}>{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[9.5px] truncate" style={{ color: 'var(--faint)' }}>{sub}</div>}
    </div>
  );
}

/** Horizontal scroller for chips — the metric explorer's control surface.
 *  44px min touch targets; never a tiny legend that needs precision. */
function ChipRow({ options, value, onChange, ariaLabel }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label={ariaLabel}
      style={{ scrollbarWidth: 'none' }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className="shrink-0 rounded-full px-3 text-[11.5px] font-semibold transition-colors"
            style={{
              minHeight: 34,
              background: on ? 'var(--cta-solid)' : 'transparent',
              color: on ? 'var(--cta-ink)' : 'var(--mute)',
              border: `1px solid ${on ? 'var(--cta-edge)' : 'var(--line)'}`,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Keep logging to unlock this" — the honest alternative to an empty chart. */
function NeedMore({ need, what }) {
  return (
    <div className="rounded-[var(--r-lg)] px-4 py-6 text-center" style={{ border: '1px dashed var(--line)' }}>
      <div className="text-[12px] font-semibold" style={{ color: 'var(--mute)' }}>Not enough data yet</div>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--faint)' }}>
        {need > 0 ? `${need} more ${need === 1 ? 'entry' : 'entries'} and ` : ''}your {what} trend appears here.
      </div>
    </div>
  );
}

/* ══════════════════════════ hero ══════════════════════════ */

function Hero({ intel, period }) {
  const w = intel.weight?.analysis;
  const lead = intel.insights?.[0];
  const prCount = intel.prs?.recentCount ?? 0;
  const workouts = intel.training?.sessions?.length ?? 0;
  const adherence = useMemo(() => {
    const s = intel.adherence?.series || [];
    if (!s.length) return null;
    return Math.round(s.reduce((a, b) => a + (b.score || 0), 0) / s.length);
  }, [intel.adherence]);

  return (
    <div className="space-y-3">
      {/* The headline IS an insight, generated from the data — not a
          static "Progress" title. If there is no insight yet, the page
          says so plainly rather than inventing enthusiasm. */}
      <div>
        <div className="text-[10.5px] font-bold uppercase tracking-[.12em]" style={{ color: 'var(--accent)' }}>
          Your progress
        </div>
        <h1 className="mt-1 text-[26px] font-black leading-[1.12] tracking-[-.03em]" style={{ color: 'var(--ink)' }}>
          {lead ? lead.title : 'Keep logging to see your first trend'}
        </h1>
        {lead?.description && (
          <p className="mt-1.5 text-[12.5px] leading-snug" style={{ color: 'var(--mute)' }}>{lead.description}</p>
        )}
      </div>

      {/* TILES, not a flat row of numbers. Each metric family carries its
          own hue (see theme.css's metric-hue block) so six different KINDS
          of information stop looking like one kind. The tint is a wash and
          the saturation lives in the icon and ring, which is what keeps a
          six-colour page calm instead of loud.

          Two-up below 360px, four-up above: "ADHERENCE" is a single
          unbreakable word that overran its column in a four-across row on
          a narrow phone. */}
      <div className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4">
        <MetricTile
          label="Weight" hue="body" icon="trending"
          value={w && !w.insufficient && w.change != null ? `${w.change > 0 ? '+' : ''}${n1(w.change)}` : (w?.current != null ? n1(w.current) : null)}
          unit="kg" sub={w && !w.insufficient ? `${period}d` : 'current'}
        />
        <MetricTile label="Sessions" hue="training" icon="strength" value={workouts || null} sub={`${period}d`} />
        {/* Adherence is a true percentage, so it earns a ring. Open-ended
            counts deliberately do not get one -- a ring implies a ceiling. */}
        <MetricTile
          label="Adherence" hue="nutrition" icon="target"
          value={adherence != null ? adherence : null} unit="%"
          ring={adherence != null ? adherence / 100 : null}
        />
        <MetricTile label="PRs" hue="strength" icon="bulb" value={prCount || null} sub="30d" />
      </div>
    </div>
  );
}

/** One tinted metric tile. `hue` selects a metric family; `ring` is only
 *  passed for values that genuinely run 0..1. */
function MetricTile({ label, value, unit, sub, hue = 'energy', icon, ring = null }) {
  const color = `var(--m-${hue})`;
  return (
    <div className="rounded-[var(--r-lg)] p-2.5" style={{ background: `var(--m-${hue}-bg)`, border: '1px solid var(--line)' }}>
      <div className="flex items-start justify-between gap-1">
        <span className="inline-flex items-center justify-center rounded-full" style={{ width: 22, height: 22, background: `var(--m-${hue}-bg)`, color }}>
          <Icon name={icon} size={13} />
        </span>
        {ring != null && (
          <Ring value={ring} size={26} stroke={3} color={color} label={`${label} ${Math.round(ring * 100)} percent`} />
        )}
      </div>
      <div className="mt-1.5 text-[9.5px] font-semibold uppercase leading-tight tracking-[.06em]" style={{ color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-[19px] font-black leading-none tabular-nums tracking-[-.02em]" style={{ color: 'var(--ink)' }}>
          {value ?? '—'}
        </span>
        {unit && value != null && <span className="text-[10px] font-medium" style={{ color: 'var(--faint)' }}>{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[9.5px] truncate" style={{ color: 'var(--faint)' }}>{sub}</div>}
    </div>
  );
}

/* ══════════════════════════ metric explorer ══════════════════════════ */

/** Builds the selectable metric list from what the user ACTUALLY has.
 *  A metric with no rows never appears as a chip -- the explorer offers
 *  only real choices. */
function useMetrics(intel) {
  return useMemo(() => {
    const caps = intel.capabilities || {};
    const out = [];

    if (caps.weight?.available) {
      out.push({
        key: 'weight', label: 'Weight', category: 'body', unit: 'kg', decimals: 1,
        series: intel.weight.series,
        goal: intel.weight.target ?? null,
        // Every other series takes the hue of its declared category;
        // these two were pinned to the theme accent, so the two most-
        // looked-at charts on the page rendered in whatever colour the
        // theme happened to be rather than their own.
        color: 'var(--m-body)',
      });
    }
    const t = intel.training?.sessions || [];
    if (t.length) {
      out.push({
        key: 'volume', label: 'Volume', category: 'training', unit: 'kg', decimals: 0, fillZero: true,
        series: t.map((s) => ({ date: s.date, value: s.volume })), color: 'var(--m-training)', variant: 'bar',
      });
      out.push({
        key: 'sets', label: 'Sets', category: 'training', unit: '', decimals: 0, fillZero: true,
        series: t.map((s) => ({ date: s.date, value: s.sets })), color: 'var(--m-training)', variant: 'bar',
      });
    }
    const nu = intel.nutrition?.days || [];
    if (nu.length) {
      out.push({
        key: 'calories', label: 'Calories', category: 'nutrition', unit: 'kcal', decimals: 0, fillZero: true,
        series: nu.map((d) => ({ date: d.date, value: d.calories })),
        goal: intel.nutrition.targets?.calories ?? null, color: 'var(--m-nutrition)',
      });
      // Stacked macros: the only chart here where the SPLIT is the point,
      // not the total. Drawn as columns because a day's macro breakdown is
      // a composition, not a trend line.
      out.push({
        key: 'macros', label: 'Macros', category: 'nutrition', unit: 'g', decimals: 0,
        columns: nu.map((d) => ({
          date: d.date,
          parts: [
            { key: 'protein', value: d.protein || 0 },
            { key: 'carbs', value: d.carbs || 0 },
            { key: 'fat', value: d.fat || 0 },
          ],
        })),
        stacks: [
          { key: 'protein', label: 'Protein', color: 'var(--m-body)' },
          { key: 'carbs', label: 'Carbs', color: 'var(--m-nutrition)' },
          { key: 'fat', label: 'Fat', color: 'var(--m-strength)' },
        ],
        series: nu.map((d) => ({ date: d.date, value: (d.protein || 0) + (d.carbs || 0) + (d.fat || 0) })),
      });
      out.push({
        key: 'protein', label: 'Protein', category: 'nutrition', unit: 'g', decimals: 0, fillZero: true,
        series: nu.map((d) => ({ date: d.date, value: d.protein })),
        goal: intel.nutrition.targets?.protein ?? null, color: 'var(--m-nutrition)',
      });
    }
    const h = intel.health?.days || [];
    if (caps.energy?.available) {
      out.push({
        key: 'energy', label: 'Energy', category: 'energy', unit: 'kcal', decimals: 0,
        series: h.filter((d) => d.total_energy != null).map((d) => ({ date: d.date, value: d.total_energy })),
        color: 'var(--m-energy)',
      });
    }
    if (caps.steps?.available) {
      out.push({
        key: 'steps', label: 'Steps', category: 'energy', unit: '', decimals: 0, fillZero: true,
        series: h.filter((d) => d.steps != null).map((d) => ({ date: d.date, value: d.steps })),
        color: 'var(--warn)',
      });
    }
    // SLEEP AND RECOVERY ARE DELIBERATELY NOT CHARTED HERE.
    //
    // The explorer should offer the same shelf of metrics to everyone. If
    // sleep and recovery appear as chips, a wearable user gets a Recovery
    // category that a non-wearable user simply never sees, and the screen
    // becomes two different products depending on hardware. Those two
    // figures are reported as plain numbers in the Recovery section
    // instead, which is all they are worth here -- a seven-point sleep
    // line tells you very little that '7h 21m average' does not.
    //
    // Energy stays, because SK OS computes it for everyone (BMR plus
    // logged workouts) rather than it being wearable-only.
    return out.filter((m) => m.series && m.series.length);
  }, [intel]);
}

function localAnalyze(series) {
  if (!series?.length) return null;
  const vals = series.map((p) => p.value);
  const first = series[0]; const last = series[series.length - 1];
  const spanDays = (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) / 86400000;
  const change = last.value - first.value;
  return {
    current: last.value, change,
    min: Math.min(...vals), max: Math.max(...vals),
    average: vals.reduce((a, b) => a + b, 0) / vals.length,
    count: series.length, spanDays,
    ratePerWeek: series.length >= 4 && spanDays >= 7 ? (change / spanDays) * 7 : null,
  };
}

/**
 * "What's happening?" — a plain-language reading of the selected metric.
 *
 * Built from the SAME numbers already on screen, so the user can check it
 * against the chart rather than having to trust it. Returns null whenever
 * the data doesn't support a statement: a sentence is generated only when
 * there is a real trend, a real plateau, or a real recent divergence.
 * Vague filler ("keep going!") is worse than saying nothing.
 */
function describeMetric(metric, a, windowed, period) {
  if (!a || !metric || windowed.length < 4) return null;
  const unit = metric.unit ? ` ${metric.unit}` : '';
  const dp = metric.decimals ?? 0;
  const fmt = (v) => `${Math.abs(v).toFixed(dp)}${unit}`;
  const down = metric.key === 'weight';          // lower is the goal here

  // Compare the most recent third against the earliest third: this is what
  // catches "falling, but slower lately", which a single slope cannot say.
  const third = Math.max(2, Math.floor(windowed.length / 3));
  const early = windowed.slice(0, third);
  const late = windowed.slice(-third);
  const mean = (arr) => arr.reduce((x, p) => x + p.value, 0) / arr.length;
  const earlyMean = mean(early);
  const lateMean = mean(late);
  const shift = lateMean - earlyMean;
  const spread = a.max - a.min;
  const moved = spread > 0 && Math.abs(shift) / spread > 0.12;

  if (!moved) {
    return `Your ${metric.label.toLowerCase()} has held steady around ${fmt(a.average)} across these ${period} days.`;
  }

  const dir = shift < 0 ? 'down' : 'up';
  const good = down ? shift < 0 : shift > 0;
  const rate = a.ratePerWeek != null ? `, about ${fmt(a.ratePerWeek)} a week` : '';
  let sentence = `Your ${metric.label.toLowerCase()} has moved ${dir} ${fmt(shift)} from the start of this window to now${rate}.`;

  // Has the recent pace changed? Only worth saying if it clearly has.
  const half = Math.floor(windowed.length / 2);
  if (half >= 3) {
    const firstHalfShift = mean(windowed.slice(half - half, half)) - windowed[0].value;
    const secondHalfShift = windowed[windowed.length - 1].value - mean(windowed.slice(half - half, half));
    if (Math.sign(firstHalfShift) === Math.sign(secondHalfShift) && Math.abs(secondHalfShift) < Math.abs(firstHalfShift) * 0.5) {
      sentence += ' The pace has slowed over the second half.';
    }
  }
  if (!good) sentence += down ? ' That is away from a lower target.' : '';
  return sentence;
}

function MetricExplorer({ intel, period }) {
  const metrics = useMetrics(intel);
  const categories = useMemo(() => {
    const seen = [];
    for (const m of metrics) if (!seen.includes(m.category)) seen.push(m.category);
    return seen.map((c) => ({ key: c, label: c[0].toUpperCase() + c.slice(1) }));
  }, [metrics]);

  const [cat, setCat] = useState(null);
  const activeCat = cat && categories.some((c) => c.key === cat) ? cat : categories[0]?.key;
  const inCat = metrics.filter((m) => m.category === activeCat);
  const [metricKey, setMetricKey] = useState(null);
  const [comparing, setComparing] = useState(false);
  const active = inCat.find((m) => m.key === metricKey) || inCat[0];

  if (!metrics.length) return null;

  const windowed = useMemo(() => {
    if (!active) return [];
    const s = active.series;
    if (!s.length) return s;
    const lastMs = Date.parse(`${s[s.length - 1].date}T00:00:00Z`);
    return s.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= lastMs - (period - 1) * 86400000);
  }, [active, period]);

  // The window immediately BEFORE the current one, never overlapping it.
  // Same length, so laying them over each other compares like with like.
  const previous = useMemo(() => {
    if (!comparing || !active) return [];
    const all = active.series;
    if (!all.length) return [];
    const lastMs = Date.parse(`${all[all.length - 1].date}T00:00:00Z`);
    const curFrom = lastMs - (period - 1) * 86400000;
    const prevFrom = curFrom - period * 86400000;
    return all.filter((p) => {
      const t = Date.parse(`${p.date}T00:00:00Z`);
      return t >= prevFrom && t < curFrom;
    });
  }, [comparing, active, period]);

  // A WEEK VIEW SHOULD SHOW THE WHOLE WEEK. Series only contain days that
  // have records, so a 7-day window with two training days rendered two
  // lonely columns and five invisible gaps -- the rest days, which are
  // themselves information, simply weren't there.
  //
  // Only ever applied to metrics where an absent record genuinely MEANS
  // zero (sets done, calories eaten, steps taken). Never to a measurement:
  // a day you didn't weigh yourself is not a day you weighed nothing, and
  // filling it with 0 would drag the line to the floor.
  const columns = useMemo(() => {
    if (!active) return [];
    const base = active.stacks
      ? (active.columns || []).filter((c) => windowed.some((w) => w.date === c.date))
      : windowed;
    if (!active.fillZero && !active.stacks) return base;
    const byDate = new Map(base.map((p) => [p.date, p]));
    const out = [];
    const today = new Date();
    for (let i = period - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push(byDate.get(key) || (active.stacks
        ? { date: key, parts: (active.stacks || []).map((sr) => ({ key: sr.key, value: 0 })) }
        : { date: key, value: 0 }));
    }
    return out;
  }, [active, windowed, period]);

  const a = localAnalyze(windowed);
  const prevA = localAnalyze(previous);
  const smoothed = useMemo(() => {
    if (windowed.length < 5) return [];
    const half = 3;
    return windowed.map((p, i) => {
      const from = Math.max(0, i - half); const to = Math.min(windowed.length - 1, i + half);
      let sum = 0; for (let j = from; j <= to; j++) sum += windowed[j].value;
      return { date: p.date, value: sum / (to - from + 1) };
    });
  }, [windowed]);

  return (
    <Section title="Explore your data">
      <Card className="p-4">
        {categories.length > 1 && (
          <ChipRow options={categories} value={activeCat} onChange={(k) => { setCat(k); setMetricKey(null); }} ariaLabel="Metric category" />
        )}
        {inCat.length > 1 && (
          <div className="mt-2">
            <ChipRow options={inCat.map((m) => ({ key: m.key, label: m.label }))} value={active?.key} onChange={setMetricKey} ariaLabel="Metric" />
          </div>
        )}

        {active && windowed.length > 0 ? (
          <>
            {/* Compare is opt-in rather than always on: a second line on
                every chart by default doubles the ink for a question the
                user has not asked yet. */}
            <div className="mt-2.5 flex items-center justify-end">
              <button
                onClick={() => setComparing((v) => !v)}
                aria-pressed={comparing}
                className="rounded-full px-3 text-[10.5px] font-semibold transition-colors"
                style={{
                  // 44px: the brief's touch-target floor. This was 30px,
                  // which is comfortable with a mouse and fiddly with a
                  // thumb -- and this control lives on a phone-first page.
                  minHeight: 44,
                  background: comparing ? 'var(--cta-solid)' : 'transparent',
                  color: comparing ? 'var(--cta-ink)' : 'var(--faint)',
                  border: `1px solid ${comparing ? 'var(--cta-edge)' : 'var(--line)'}`,
                }}
              >
                Compare previous {period}d
              </button>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>{active.label}</div>
                <div className="mt-0.5 flex items-baseline gap-1.5">
                  <span className="text-[28px] font-black leading-none tabular-nums tracking-[-.03em]" style={{ color: 'var(--ink)' }}>
                    {active.decimals ? n1(a.current) : fmtNum(n0(a.current))}
                  </span>
                  <span className="text-[11px] font-medium" style={{ color: 'var(--faint)' }}>{active.unit}</span>
                </div>
              </div>
              {a.count > 1 && (
                <div className="text-right">
                  <div className="text-[13px] font-bold tabular-nums" style={{ color: a.change === 0 ? 'var(--faint)' : (active.key === 'weight' ? (a.change < 0 ? 'var(--good)' : 'var(--warn)') : (a.change > 0 ? 'var(--good)' : 'var(--warn)')) }}>
                    {a.change > 0 ? '+' : ''}{active.decimals ? n1(a.change) : fmtNum(n0(a.change))}
                  </div>
                  <div className="text-[9.5px]" style={{ color: 'var(--faint)' }}>over {period}d</div>
                </div>
              )}
            </div>

            <div className="mt-2">
              {/* A week or so of columns -> the readable weekly-trends
                  shape, where every value is printed. Past that the dense
                  scrubbable line is the right instrument: 30 printed
                  labels on a phone is not a chart, it is a collision.
                  Stacked series always use columns -- a composition
                  cannot be drawn as a single line. */}
              {(active.stacks || windowed.length <= 8) ? (
                <PeriodChart
                  points={columns}
                  series={active.stacks || null}
                  color={active.color}
                  unit={active.unit}
                  decimals={active.decimals}
                  todayKey={new Date().toISOString().slice(0, 10)}
                  ariaLabel={`${active.label} for each of the last ${period} days`}
                />
              ) : (
              <MetricChart
                points={windowed}
                smoothed={comparing ? [] : smoothed}
                compare={previous}
                variant={active.variant || 'line'}
                goal={active.goal}
                color={active.color}
                unit={active.unit}
                decimals={active.decimals}
                ariaLabel={`${active.label} over the last ${period} days`}
              />
              )}
            </div>

            {/* The comparison only means something once there IS a previous
                window with data in it -- otherwise say so rather than
                drawing an empty dashed line and leaving the user to guess. */}
            {comparing && (
              <div className="mt-2 rounded-[var(--r-sm)] px-3 py-2" style={{ background: 'var(--bg2)' }}>
                {prevA ? (
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
                      Previous {period}d averaged{' '}
                      <strong style={{ color: 'var(--mute)' }}>
                        {active.decimals ? n1(prevA.average) : fmtNum(n0(prevA.average))} {active.unit}
                      </strong>
                    </span>
                    {(() => {
                      const d = a.average - prevA.average;
                      const pct = prevA.average !== 0 ? (d / Math.abs(prevA.average)) * 100 : null;
                      const better = active.key === 'weight' ? d < 0 : d > 0;
                      return (
                        <span className="shrink-0 text-[11.5px] font-bold tabular-nums"
                          style={{ color: d === 0 ? 'var(--faint)' : better ? 'var(--good)' : 'var(--warn)' }}>
                          {d > 0 ? '+' : ''}{active.decimals ? n1(d) : fmtNum(n0(d))}
                          {pct != null && ` (${d > 0 ? '+' : ''}${n1(pct)}%)`}
                        </span>
                      );
                    })()}
                  </div>
                ) : (
                  <span className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
                    No data in the previous {period} days yet — nothing to compare against.
                  </span>
                )}
              </div>
            )}

            {(() => {
              const story = describeMetric(active, a, windowed, period);
              return story ? (
                <div className="mt-2.5 text-[11.5px] leading-snug" style={{ color: 'var(--mute)' }}>
                  {story}
                </div>
              ) : null;
            })()}

            <div className="mt-3 grid grid-cols-4 gap-2 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
              <Stat label="Average" value={active.decimals ? n1(a.average) : fmtNum(n0(a.average))} />
              <Stat label="Lowest" value={active.decimals ? n1(a.min) : fmtNum(n0(a.min))} />
              <Stat label="Highest" value={active.decimals ? n1(a.max) : fmtNum(n0(a.max))} />
              <Stat
                label="Rate"
                value={a.ratePerWeek != null ? `${a.ratePerWeek > 0 ? '+' : ''}${n1(a.ratePerWeek)}` : '—'}
                sub={a.ratePerWeek != null ? '/week' : 'need 7d'}
              />
            </div>

            {active.goal != null && (
              <div className="mt-2 text-[10.5px]" style={{ color: 'var(--faint)' }}>
                Dashed line is your {active.label.toLowerCase()} target ({active.decimals ? n1(active.goal) : fmtNum(active.goal)} {active.unit}).
              </div>
            )}
          </>
        ) : (
          <div className="mt-3"><NeedMore need={0} what={active?.label?.toLowerCase() || 'metric'} /></div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ personal records ══════════════════════════ */

function PrDetail({ open, onClose, exercise }) {
  const hist = useFetch(
    () => (exercise?.exerciseId ? api(`/tracking/me/progress/exercise/${exercise.exerciseId}`) : Promise.resolve({ history: [] })),
    [exercise?.exerciseId],
  );
  const history = hist.data?.history || [];

  // Estimated 1RM is the fairest single progression line across sets of
  // different weights and reps -- and it is the SAME Epley formula the PR
  // engine already uses, not a second definition invented for this chart.
  const series = history.filter((h) => h.est1rm != null).map((h) => ({ date: h.date, value: h.est1rm }));
  const prMarkers = history.filter((h) => h.isPr).map((h) => ({ date: h.date }));
  const best = exercise?.records || {};

  return (
    <Modal open={open} onClose={onClose} title={exercise?.exercise || 'Exercise'} sub="Personal records and progression">
      {!exercise ? null : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5">
            {Object.entries(best).map(([type, r]) => (
              <div key={type} className="rounded-[var(--r-sm)] p-2.5" style={{ border: '1px solid var(--line)' }}>
                <div className="text-[9.5px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
                  {PR_TYPE_LABEL[type] || type}
                </div>
                <div className="mt-0.5 text-[17px] font-black tabular-nums" style={{ color: 'var(--ink)' }}>
                  {n1(r.value)}
                  {type === 'heaviest_weight' || type === 'est_1rm' ? <span className="ml-1 text-[10px] font-medium" style={{ color: 'var(--faint)' }}>kg</span> : null}
                </div>
                <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--faint)' }}>
                  {r.weight != null && r.reps != null ? `${n1(r.weight)} kg × ${n0(r.reps)} · ` : ''}{relDay(r.date)}
                </div>
              </div>
            ))}
          </div>

          {hist.loading && <div className="text-[11px]" style={{ color: 'var(--faint)' }}>Loading history…</div>}

          {series.length >= 2 ? (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.09em] mb-1" style={{ color: 'var(--faint)' }}>
                Estimated 1RM progression
              </div>
              <MetricChart
                points={series} markers={prMarkers} color="var(--m-pr)" unit="kg" decimals={1} height={170}
                ariaLabel={`Estimated one rep max progression for ${exercise.exercise}`}
              />
              <div className="mt-1 text-[10px]" style={{ color: 'var(--faint)' }}>
                Ringed points are sessions where you set a record. Estimated from weight × reps (Epley) — a comparison tool, not a tested max.
              </div>
            </div>
          ) : series.length === 1 ? (
            <NeedMore need={1} what="progression" />
          ) : null}

          {history.length > 0 && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.09em] mb-1.5" style={{ color: 'var(--faint)' }}>
                Recent sessions
              </div>
              <div className="space-y-1.5">
                {history.slice(-6).reverse().map((h, i) => (
                  <div key={i} className="flex items-center justify-between text-[11.5px]" style={{ color: 'var(--mute)' }}>
                    <span>{relDay(h.date)}</span>
                    <span className="tabular-nums" style={{ color: 'var(--ink)' }}>
                      {n1(h.weight)} kg × {n0(h.reps)}{h.sets ? ` × ${h.sets}` : ''}
                      {h.isPr && <span className="ml-1.5 text-[9.5px] font-bold" style={{ color: 'var(--m-pr)' }}>PR</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function PersonalRecords({ intel, sectionRef }) {
  const prs = intel.prs || {};
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const byExercise = prs.byExercise || [];
  const timeline = prs.timeline || [];

  if (!byExercise.length && !timeline.length) {
    return (
      <Section title="Personal records" id="prs">
        <div ref={sectionRef} />
        <Card className="p-5 text-center">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Your first PR will appear here</div>
          <div className="mt-1 text-[11.5px]" style={{ color: 'var(--faint)' }}>
            Log a workout with weight and reps, and SK OS records your bests automatically.
          </div>
        </Card>
      </Section>
    );
  }

  // Rank exercises by how recently a record was set — the ones you are
  // actively pushing lead, rather than an arbitrary alphabetical list.
  const ranked = [...byExercise].sort((a, b) => {
    const ad = Math.max(...Object.values(a.records).map((r) => Date.parse(r.date) || 0));
    const bd = Math.max(...Object.values(b.records).map((r) => Date.parse(r.date) || 0));
    return bd - ad;
  });
  const shown = showAll ? ranked : ranked.slice(0, 6);

  return (
    <Section
      title="Personal records"
      id="prs"
      action={
        prs.recentCount > 0 ? (
          <span className="text-[10.5px] font-semibold" style={{ color: 'var(--accent)' }}>
            {prs.recentCount} new in 30d
          </span>
        ) : null
      }
    >
      <div ref={sectionRef} />

      {/* Most recent record, given real prominence — this is the moment
          worth coming back for. Typography, not a trophy graphic. */}
      {timeline[0] && (
        <Card className="p-4">
          <div className="text-[9.5px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--accent)' }}>
            Latest record · {relDay(timeline[0].date)}
          </div>
          <div className="mt-1 text-[20px] font-black leading-tight tracking-[-.02em]" style={{ color: 'var(--ink)' }}>
            {timeline[0].exercise}
          </div>
          <div className="mt-0.5 text-[13px] font-semibold tabular-nums" style={{ color: 'var(--mute)' }}>
            {n1(timeline[0].weight)} kg × {n0(timeline[0].reps)}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        {shown.map((ex) => {
          const heaviest = ex.records.heaviest_weight;
          const orm = ex.records.est_1rm;
          const latest = Object.values(ex.records).reduce((m, r) => (Date.parse(r.date) > Date.parse(m.date) ? r : m));
          return (
            <button
              key={ex.exerciseId}
              onClick={() => setSelected(ex)}
              className="rounded-[var(--r-lg)] p-3 text-left transition-colors"
              style={{ border: '1px solid var(--line)', background: 'var(--surface, transparent)', minHeight: 44 }}
            >
              {/* Wraps to two lines rather than truncating: an exercise name is
                  the whole point of the card, and "Incline Dumbbell Press" does
                  not fit one line in a two-up grid on a small phone. */}
              <div className="text-[12px] font-bold leading-tight" style={{ color: 'var(--ink)' }}>{ex.exercise}</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-[18px] font-black tabular-nums leading-none" style={{ color: 'var(--ink)' }}>
                  {n1(heaviest?.value ?? orm?.value)}
                </span>
                <span className="text-[9.5px]" style={{ color: 'var(--faint)' }}>kg</span>
              </div>
              <div className="mt-0.5 text-[9.5px]" style={{ color: 'var(--faint)' }}>
                {heaviest?.reps ? `× ${n0(heaviest.reps)} · ` : ''}{relDay(latest.date)}
              </div>
            </button>
          );
        })}
      </div>

      {ranked.length > 6 && (
        <button className="btn w-full" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show less' : `View all ${ranked.length} exercises`}
        </button>
      )}


      <PrDetail open={!!selected} onClose={() => setSelected(null)} exercise={selected} />
    </Section>
  );
}

/* ══════════════════════════ training ══════════════════════════ */

function TrainingSection({ intel, period }) {
  const muscles = (intel.training?.byMuscle || []).filter((m) => m.sets > 0);
  const sessions = intel.training?.sessions || [];
  if (!sessions.length) return null;

  const totalVolume = sessions.reduce((s, x) => s + (x.volume || 0), 0);
  const totalSets = sessions.reduce((s, x) => s + (x.sets || 0), 0);
  const maxSets = Math.max(...muscles.map((m) => m.sets), 1);

  return (
    <Section title="Training">
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Sessions" value={sessions.length} sub={`last ${period}d`} />
          <Stat label="Volume" value={fmtNum(n0(totalVolume))} unit="kg" />
          <Stat label="Sets" value={fmtNum(totalSets)} />
        </div>

        {muscles.length > 0 && (
          <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
            <div className="text-[10px] font-bold uppercase tracking-[.09em] mb-2" style={{ color: 'var(--faint)' }}>
              Where the work went
            </div>
            <div className="space-y-1.5">
              {muscles.slice(0, 7).map((m) => (
                <div key={m.muscle} className="flex items-center gap-2.5">
                  <span className="w-16 shrink-0 truncate text-[10.5px] capitalize" style={{ color: 'var(--mute)' }}>{m.muscle}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
                    <span className="block h-full rounded-full" style={{ width: `${(m.sets / maxSets) * 100}%`, background: 'var(--m-training)' }} />
                  </span>
                  <span className="w-8 shrink-0 text-right text-[10.5px] font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{m.sets}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[9.5px]" style={{ color: 'var(--faint)' }}>Sets per muscle group, from your logged exercises.</div>
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ nutrition ══════════════════════════ */

function NutritionSection({ intel }) {
  const days = intel.nutrition?.days || [];
  const targets = intel.nutrition?.targets;
  if (!days.length) return null;

  const avg = (k) => days.reduce((s, d) => s + (d[k] || 0), 0) / days.length;
  const hit = (k, target) => (target ? days.filter((d) => (d[k] || 0) >= target * 0.9).length : null);

  return (
    <Section title="Nutrition">
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Avg calories" value={fmtNum(n0(avg('calories')))} sub={targets?.calories ? `target ${fmtNum(targets.calories)}` : `${days.length} days`} />
          <Stat label="Avg protein" value={n0(avg('protein'))} unit="g" sub={targets?.protein ? `target ${n0(targets.protein)}` : null} />
          <Stat
            label="On target"
            value={targets?.protein ? hit('protein', targets.protein) : null}
            sub={targets?.protein ? `of ${days.length} days` : 'no target set'}
          />
        </div>
      </Card>
    </Section>
  );
}

/* ══════════════════════════ consistency ══════════════════════════ */

/** A calendar heatmap of the days that actually have data. Reads as a
 *  streak at a glance without any number needing to be parsed. */
function ConsistencySection({ intel }) {
  const c = intel.consistency;
  if (!c || !c.activeDays?.length) return null;

  const trained = new Set(c.trainedDays);
  const logged = new Set(c.nutritionDays);
  const both = new Set(c.bothDays);

  const WEEKS = 12;
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cells = [];
  // Align the grid so every column is a real Mon-Sun week; otherwise the
  // weekday rail on the left would be lying about which row is which day.
  const backToMonday = (today.getDay() + 6) % 7;
  const gridEnd = new Date(today.getTime() + (6 - backToMonday) * 86400000);
  for (let i = WEEKS * 7 - 1; i >= 0; i--) {
    const d = new Date(gridEnd.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isBoth = both.has(key);
    cells.push({
      key,
      // Four distinct states, not three. A day that was BOTH trained and
      // logged used to render identically to a train-only day, so the
      // best days in the grid were invisible.
      future: key > todayKey,
      state: isBoth ? 'both' : trained.has(key) ? 'trained' : logged.has(key) ? 'logged' : 'none',
    });
  }

  const STATE = {
    both: { bg: 'var(--m-body)', label: 'both' },
    trained: { bg: 'var(--m-training)', label: 'trained' },
    logged: { bg: 'var(--m-nutrition)', label: 'logged food' },
    none: { bg: 'var(--line)', label: 'nothing logged' },
  };

  const fmtCell = (cell) => {
    const d = new Date(`${cell.key}T00:00:00`);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `${day} — ${STATE[cell.state].label}`;
  };

  return (
    <Section title="Consistency">
      <Card className="p-4">
        <div className="mb-3 grid grid-cols-3 gap-2">
          {/* A zero streak is a KNOWN zero, not missing data, so it reads 0
              rather than the em-dash used for genuinely unknown values. */}
          <Stat label="Current streak" value={c.streak?.current ?? 0} unit="d"
            tone={c.streak?.current ? 'var(--m-energy)' : undefined} />
          <Stat label="Best streak" value={c.streak?.best ?? 0} unit="d" />
          <Stat label="Training days" value={trained.size || 0} sub="12 weeks" />
        </div>

        {/* A grid of unlabelled squares is a pattern, not a calendar -- you
            could see "lots of colour" but not WHICH days. A weekday rail on
            the left and month markers along the top make it readable as
            actual dates. Columns are weeks; rows are days of the week. */}
        <div className="flex gap-1.5">
          <div className="flex shrink-0 flex-col gap-[3px] pt-[13px]">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i} className="flex items-center text-[8px] leading-none" style={{ height: 11, color: 'var(--faint)' }}>
                {i % 2 === 0 ? d : ''}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
            <div className="flex gap-[3px]">
              {Array.from({ length: WEEKS }, (_, w) => {
                const weekCells = cells.slice(w * 7, w * 7 + 7);
                // Label a column only when its week contains the 1st of a
                // month -- labelling every column would be noise.
                const firstOfMonth = weekCells.find((c) => c.key.endsWith('-01'));
                return (
                  <div key={w} className="flex shrink-0 flex-col gap-[3px]">
                    <span className="h-[10px] text-[8px] leading-none" style={{ color: 'var(--faint)' }}>
                      {firstOfMonth
                        ? new Date(`${firstOfMonth.key}T00:00:00`).toLocaleDateString(undefined, { month: 'short' })
                        : ''}
                    </span>
                    {weekCells.map((cell) => (
                      <span
                        key={cell.key}
                        title={fmtCell(cell)}
                        aria-label={fmtCell(cell)}
                        className="block rounded-[2px]"
                        style={{ width: 11, height: 11, background: STATE[cell.state].bg, opacity: cell.future ? 0.35 : 1 }}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px]" style={{ color: 'var(--faint)' }}>
          {['both', 'trained', 'logged'].map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block rounded-[2px]" style={{ width: 8, height: 8, background: STATE[k].bg }} />
              {STATE[k].label}
            </span>
          ))}
        </div>

        {/* Says out loud why the count may be lower than the number of
            times they opened a workout -- a streak you can pad is a streak
            worth nothing. */}
        {c.skippedShortSessions > 0 && (
          <div className="mt-2.5 text-[10.5px]" style={{ color: 'var(--faint)' }}>
            {c.skippedShortSessions} very short session{c.skippedShortSessions === 1 ? '' : 's'} didn't count
            {' '}— a day needs 3+ sets or 8+ minutes of real work.
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ goal ══════════════════════════ */

/**
 * GOALS — every target the user ACTUALLY has on record.
 *
 * The brief asks for multiple goal types (weight, body fat, strength,
 * frequency, nutrition, habit). Only two of those have real stored
 * targets in this product today: target weight, and the nutrition plan's
 * calorie/protein targets. The rest would mean inventing a number and
 * then measuring the user against it, which is worse than not offering
 * the goal at all — so this renders what exists and grows as real targets
 * are added, rather than shipping placeholder rings.
 */
function GoalSection({ intel }) {
  const g = intel.weight?.goal;
  const targets = intel.nutrition?.targets;
  const days = intel.nutrition?.days || [];

  // Nutrition goals are measured as "days you hit it", not as a single
  // average — an average hides a week of misses balanced by one huge day.
  const nutritionGoals = [];
  if (targets?.protein && days.length) {
    const hit = days.filter((d) => (d.protein || 0) >= targets.protein * 0.9).length;
    nutritionGoals.push({
      key: 'protein', label: 'Protein target', hue: 'body',
      hit, of: days.length, detail: `${Math.round(targets.protein)} g/day`,
    });
  }
  if (targets?.calories && days.length) {
    const hit = days.filter((d) => Math.abs((d.calories || 0) - targets.calories) <= targets.calories * 0.1).length;
    nutritionGoals.push({
      key: 'calories', label: 'Calorie target', hue: 'nutrition',
      hit, of: days.length, detail: `${Math.round(targets.calories)} kcal ±10%`,
    });
  }

  const hasWeightGoal = g && g.target != null;
  if (!hasWeightGoal && !nutritionGoals.length) return null;
  const pct = hasWeightGoal && g.percent != null ? Math.max(0, Math.min(100, g.percent)) : null;

  return (
    <Section title="Goals">
      {nutritionGoals.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {nutritionGoals.map((ng) => (
            <Card key={ng.key} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[9.5px] font-semibold uppercase leading-tight tracking-[.06em]" style={{ color: 'var(--faint)' }}>
                    {ng.label}
                  </div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-[19px] font-black leading-none tabular-nums" style={{ color: 'var(--ink)' }}>{ng.hit}</span>
                    <span className="text-[10px]" style={{ color: 'var(--faint)' }}>/ {ng.of} days</span>
                  </div>
                  <div className="mt-0.5 text-[9.5px] truncate" style={{ color: 'var(--faint)' }}>{ng.detail}</div>
                </div>
                <Ring
                  value={ng.of ? ng.hit / ng.of : 0} size={38} stroke={4}
                  color={`var(--m-${ng.hue})`}
                  label={`${ng.label}: ${ng.hit} of ${ng.of} days`}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {hasWeightGoal && (
      <Card className="p-4">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>Target weight</div>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-[26px] font-black leading-none tabular-nums tracking-[-.03em]" style={{ color: 'var(--ink)' }}>{n1(g.target)}</span>
              <span className="text-[11px]" style={{ color: 'var(--faint)' }}>kg</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{Math.abs(n1(g.remaining))} kg</div>
            <div className="text-[9.5px]" style={{ color: 'var(--faint)' }}>to go</div>
          </div>
        </div>

        {pct != null && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
              <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: 'var(--m-body)' }} />
            </div>
            <div className="mt-1 text-[10px] tabular-nums" style={{ color: 'var(--faint)' }}>{Math.round(pct)}% of the way from where you started</div>
          </div>
        )}

        {g.weeksToTarget != null && (
          <div className="mt-2.5 text-[11px]" style={{ color: 'var(--mute)' }}>
            About <strong style={{ color: 'var(--ink)' }}>{Math.round(g.weeksToTarget)} weeks</strong> away at your current trend — an estimate that moves as the trend moves.
          </div>
        )}
      </Card>
      )}
    </Section>
  );
}

/* ══════════════════════════ insights ══════════════════════════ */

function InsightsSection({ insights }) {
  if (!insights?.length) return null;
  const rest = insights.slice(1);   // the first is already the hero headline
  if (!rest.length) return null;

  return (
    <Section title="What changed">
      <div className="space-y-2">
        {rest.map((i, idx) => (
          <Card key={idx} className="p-3.5">
            <div className="flex gap-2.5">
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: INSIGHT_TONE[i.type] || 'var(--faint)' }} />
              <div className="min-w-0">
                <div className="text-[12.5px] font-bold leading-snug" style={{ color: 'var(--ink)' }}>{i.title}</div>
                <div className="mt-0.5 text-[11.5px] leading-snug" style={{ color: 'var(--mute)' }}>{i.description}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* ══════════════════════════ wearable unlock ══════════════════════════ */

/** ONE compact module, never a wall of locked cards. Lists only what is
 *  genuinely missing, so a user who already has sleep but no recovery
 *  sees an accurate offer rather than a generic advert. */
function UnlockHealthData({ capabilities, onConnect }) {
  const missing = [
    !capabilities.sleep?.available && 'Sleep',
    !capabilities.recovery?.available && 'Recovery',
    !capabilities.steps?.available && 'Steps',
    !capabilities.energy?.available && 'Energy',
  ].filter(Boolean);
  if (!missing.length) return null;

  return (
    <Card className="p-4">
      <div className="text-[11px] font-bold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>More from your body</div>
      <div className="mt-1.5 text-[12.5px] leading-snug" style={{ color: 'var(--mute)' }}>
        Connect a health source to add {missing.join(', ').replace(/, ([^,]*)$/, ' and $1').toLowerCase()} to your progress.
      </div>
      <button className="btn mt-3 w-full" onClick={onConnect}>Connect health data</button>
    </Card>
  );
}

/* ══════════════════════════ photos ══════════════════════════ */

function PhotosSection({ photos }) {
  if (!photos?.length) return null;
  const sorted = [...photos].sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanDays = Math.round((Date.parse(last.taken_at) - Date.parse(first.taken_at)) / 86400000);

  return (
    <Section title="Transformation">
      <Card className="p-4">
        {sorted.length >= 2 ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              {[first, last].map((p, i) => (
                <figure key={p.id} className="space-y-1">
                  <img src={p.imageUrl} alt={i === 0 ? 'Earliest progress photo' : 'Most recent progress photo'}
                    className="w-full rounded-[var(--r-sm)] object-cover" style={{ aspectRatio: '3/4', background: 'var(--line)' }} loading="lazy" />
                  <figcaption className="text-[9.5px]" style={{ color: 'var(--faint)' }}>
                    {i === 0 ? 'Start' : 'Latest'} · {new Date(p.taken_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </figcaption>
                </figure>
              ))}
            </div>
            {spanDays > 0 && (
              <div className="mt-2 text-[10.5px]" style={{ color: 'var(--faint)' }}>{spanDays} days apart · {sorted.length} photos</div>
            )}
          </>
        ) : (
          <div className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
            One photo so far. Add another to see them side by side.
          </div>
        )}
      </Card>
    </Section>
  );
}

/* ══════════════════════════ weight logging ══════════════════════════ */

/** Deliberately at the BOTTOM and compact. Logging used to be the first
 *  and largest thing on this page, which put data entry ahead of the
 *  progress the user came to see. */
function LogWeight({ clientId, current, onLogged }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(t);
  }, [msg]);

  const submit = async (e) => {
    e.preventDefault();
    const w = parseFloat(value);
    if (!w || w <= 0) { setMsg({ text: 'Enter a weight in kilograms', tone: 'bad' }); return; }
    setSaving(true);
    try {
      await api(`/clients/${clientId}/weights`, { method: 'POST', body: JSON.stringify({ weight: w, source: 'manual' }) });
      setMsg({ text: `Logged ${w} kg`, tone: 'good' });
      setValue('');
      onLogged?.();
    } catch (err) { setMsg({ text: err.message, tone: 'bad' }); }
    setSaving(false);
  };

  return (
    <Card className="p-4">
      <form onSubmit={submit}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>Log today's weight</div>
            {current != null && (
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--faint)' }}>Last: {n1(current)} kg</div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="number" inputMode="decimal" step="0.1" min="0" value={value}
              onChange={(e) => setValue(e.target.value)} placeholder="kg" aria-label="Weight in kilograms"
              className="input w-20 text-right tabular-nums" style={{ minHeight: 44 }}
            />
            <button type="submit" className="btn-primary btn-sm" disabled={saving} style={{ minHeight: 44 }}>
              {saving ? '…' : 'Log'}
            </button>
          </div>
        </div>
        {msg && (
          <div className="mt-2 text-[11px]" style={{ color: msg.tone === 'bad' ? 'var(--bad)' : 'var(--good)' }} role="status">{msg.text}</div>
        )}
      </form>
    </Card>
  );
}

/* ══════════════════════════ skeleton ══════════════════════════ */

function ProgressSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading your progress">
      <div>
        <div className="skeleton-text" style={{ width: '28%' }} />
        <div className="skeleton mt-2.5" style={{ height: 32, width: '72%', borderRadius: 'var(--r-sm)' }} />
      </div>
      <div className="skeleton" style={{ height: 76, borderRadius: 'var(--r-lg)' }} />
      <div className="skeleton" style={{ height: 300, borderRadius: 'var(--r-lg)' }} />
      <div className="skeleton" style={{ height: 160, borderRadius: 'var(--r-lg)' }} />
    </div>
  );
}

/* ══════════════════════════ page ══════════════════════════ */

export default function Progress() {
  const home = useOutletContext();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState(90);
  // Tapping a lift in the strength ranking opens the SAME detail sheet the
  // bests grid uses, rather than a second, near-identical sheet.
  const [deepExerciseId, setDeepExercise] = useState(null);
  const prRef = useRef(null);

  const intelFetch = useFetch(() => api(`/tracking/me/progress/intel?days=${period}`), [period]);
  // Photos/measurements still come from the original progress endpoint --
  // reused rather than duplicated into the new one.
  const legacy = useFetch(() => api('/tracking/me/progress'));

  const intel = intelFetch.data;
  const clientId = home.data?.client?.id;

  // Deep link from Workout's "My PRs": open on the records, don't dump the
  // user at the top of a long page to hunt for them.
  useEffect(() => {
    if (params.get('section') !== 'prs') return;
    if (!intel) return;
    const t = setTimeout(() => {
      prRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(t);
  }, [params, intel]);

  if (intelFetch.loading && !intel) return <ProgressSkeleton />;
  if (intelFetch.error) return <ErrorState error={intelFetch.error} onRetry={intelFetch.reload} />;
  if (!intel) return <ProgressSkeleton />;

  const caps = intel.capabilities || {};
  const hasAnything = caps.weight?.available || caps.workouts?.available || caps.nutrition?.available;

  if (!hasAnything) {
    return (
      <div className="page-vivid space-y-4">
        <h1 className="text-[26px] font-black tracking-[-.03em]" style={{ color: 'var(--ink)' }}>Progress</h1>
        <Empty
          title="Nothing to show yet"
          hint="Log a workout, a meal or your weight — this page fills in as soon as there's something real to measure."
        />
        {clientId && <LogWeight clientId={clientId} current={null} onLogged={() => { intelFetch.reload({ silent: true }); }} />}
      </div>
    );
  }


  return (
    // ONE column up to xl, TWO beyond it.
    //
    // An earlier attempt split at lg (1024px) INSIDE the app's 512px
    // shell, which left the main column ~180px wide: the hero headline
    // broke onto five lines and the stat labels stacked on top of each
    // other. The fix was not to abandon the idea but to widen the
    // container first (see ClientLayout's per-route width) and only split
    // once there is genuinely room -- at xl the content area is ~1152px,
    // so a 340px rail still leaves the charts ~780px, wider than they
    // ever get on a phone.
    //
    // Source order is the mobile order. The rail's contents are the
    // reference material (what changed, goals, streaks, logging); the
    // main column keeps everything you came to read.
    <div className="page-vivid space-y-6 pb-4 xl:grid xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start xl:gap-7 xl:space-y-0">
      <div className="space-y-6">
      <div className="space-y-3">
        <Hero intel={intel} period={period} />
        <div role="tablist" aria-label="Time period" className="flex gap-1.5">
          {PERIODS.map((p) => {
            const on = p.key === period;
            return (
              <button
                key={p.key}
                role="tab"
                aria-selected={on}
                onClick={() => setPeriod(p.key)}
                className="flex-1 rounded-[var(--r-sm)] text-[11px] font-bold transition-colors"
                style={{
                  minHeight: 34,
                  background: on ? 'var(--cta-solid)' : 'transparent',
                  color: on ? 'var(--cta-ink)' : 'var(--faint)',
                  border: `1px solid ${on ? 'var(--cta-edge)' : 'var(--line)'}`,
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <RecoverySection intel={intel} Section={Section} Stat={Stat} />

      <MetricExplorer intel={intel} period={period} />

      <InsightsSection insights={intel.insights} />

      <PersonalRecords intel={intel} sectionRef={prRef} />

      <StrengthProgressSection
        progress={intel.strengthProgress}
        Section={Section}
        onSelect={(exerciseId) => setDeepExercise(exerciseId)}
      />

      <TrainingSection intel={intel} period={period} />

      <AchievementsSection intel={intel} Section={Section} />

      <NutritionSection intel={intel} />

      <MeasurementsSection
        measurements={intel.measurements} Section={Section} ChipRow={ChipRow} NeedMore={NeedMore}
        clientId={clientId} onLogged={() => intelFetch.reload({ silent: true })}
      />

      <WeekSection week={intel.week} Section={Section} Stat={Stat} />

      <GoalSection intel={intel} />

      <ConsistencySection intel={intel} />


      <PrDetail
        open={!!deepExerciseId}
        onClose={() => setDeepExercise(null)}
        exercise={(intel.prs?.byExercise || []).find((e) => e.exerciseId === deepExerciseId)
          // A lift can have progression without ever having set a stored PR
          // row, so fall back to a minimal shape the sheet can still render.
          || (deepExerciseId ? { exerciseId: deepExerciseId, exercise: (intel.strengthProgress || []).find((p) => p.exerciseId === deepExerciseId)?.exercise || 'Exercise', records: {} } : null)}
      />

      <TransformationSection photos={legacy.data?.photos} Section={Section} />
      </div>

      {/* Companion rail on xl; simply the next sections on anything
          narrower, in the same order. Sticky so the reference material
          stays put while the charts scroll. */}
      <div className="space-y-6 xl:sticky xl:top-4">
        <UnlockHealthData capabilities={caps} onConnect={() => nav('/app/client/health')} />

        {clientId && (
          <LogWeight
            clientId={clientId}
            current={intel.weight?.analysis?.current}
            onLogged={() => { intelFetch.reload({ silent: true }); home.reload?.({ silent: true }); }}
          />
        )}
      </div>
    </div>
  );
}
