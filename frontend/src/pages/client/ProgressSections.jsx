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
import { api } from '../../api.js';
import { Card } from '../../components/UI.jsx';
import Icon from '../../components/Icon.jsx';
import Ring from '../../components/Ring.jsx';
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
export function MeasurementsSection({ measurements, Section, ChipRow, NeedMore, clientId, onLogged }) {
  const keys = Object.keys(measurements || {}).filter((k) => measurements[k]?.length);
  const [sel, setSel] = useState(null);
  const [logging, setLogging] = useState(false);

  // Renders even with NOTHING recorded -- previously the whole section
  // vanished when empty, which meant a user had no way to discover that
  // measurement tracking exists, let alone start it.
  if (!keys.length) {
    return (
      <Section title="Measurements">
        <Card className="p-4">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>Track how your shape is changing</div>
          <div className="mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--faint)' }}>
            Weight alone can't tell recomposition from loss. Waist, chest and arms can.
          </div>
          {clientId && (
            logging
              ? <MeasurementForm clientId={clientId} onDone={() => { setLogging(false); onLogged?.(); }} onCancel={() => setLogging(false)} />
              : <button className="btn mt-3 w-full" onClick={() => setLogging(true)}>Add measurements</button>
          )}
        </Card>
      </Section>
    );
  }

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

        {clientId && (
          logging
            ? <MeasurementForm clientId={clientId} onDone={() => { setLogging(false); onLogged?.(); }} onCancel={() => setLogging(false)} />
            : (
              <button className="btn btn-sm mt-3 w-full" onClick={() => setLogging(true)}>Add today's measurements</button>
            )
        )}

        {series.length >= 2 ? (
          <div className="mt-2">
            <MetricChart
              points={series}
              color="var(--m-body)"
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


const MEASURE_FIELDS = [
  { key: 'waist', label: 'Waist' }, { key: 'chest', label: 'Chest' }, { key: 'arms', label: 'Arms' },
  { key: 'thighs', label: 'Thighs' }, { key: 'hips', label: 'Hips' }, { key: 'neck', label: 'Neck' },
];

/** Logs a measurement set through the EXISTING POST /clients/:id/measurements
 *  endpoint -- no new backend was added for this. Every field is optional:
 *  someone who only ever tracks their waist should not be forced to invent
 *  a neck measurement to save. */
function MeasurementForm({ clientId, onDone, onCancel }) {
  const [vals, setVals] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of MEASURE_FIELDS) {
      const v = parseFloat(vals[f.key]);
      if (Number.isFinite(v) && v > 0) body[f.key] = v;
    }
    if (!Object.keys(body).length) { setErr('Enter at least one measurement'); return; }
    setSaving(true);
    try {
      await api(`/clients/${clientId}/measurements`, { method: 'POST', body: JSON.stringify(body) });
      onDone?.();
    } catch (e2) { setErr(e2.message); }
    setSaving(false);
  };

  return (
    <form onSubmit={submit} className="mt-3 rounded-[var(--r-sm)] p-3" style={{ border: '1px solid var(--line)' }}>
      <div className="grid grid-cols-3 gap-2">
        {MEASURE_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>{f.label}</span>
            <input
              type="number" inputMode="decimal" step="0.1" min="0" placeholder="cm"
              aria-label={`${f.label} in centimetres`}
              value={vals[f.key] || ''}
              onChange={(ev) => setVals((v) => ({ ...v, [f.key]: ev.target.value }))}
              className="input mt-0.5 w-full text-[13px] tabular-nums" style={{ minHeight: 40 }}
            />
          </label>
        ))}
      </div>
      {err && <div className="mt-2 text-[11px]" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-sm flex-1" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary btn-sm flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <div className="mt-2 text-[9.5px]" style={{ color: 'var(--faint)' }}>Leave any blank — only what you fill in is saved.</div>
    </form>
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
  const w = intel.weight?.analysis;
  const lost = w && w.change != null && w.change < 0 ? Math.abs(w.change) : 0;
  const trained = intel.consistency?.trainedDays?.length || 0;
  const prTotal = intel.prs?.total || 0;
  const best = intel.consistency?.streak?.best || 0;

  // Each milestone knows its CURRENT value and its TARGET, so an unearned
  // one can show how far away it is instead of just sitting greyed out.
  // Showing the not-yet-earned ones was a deliberate change: hiding them
  // made the section a trophy cabinet, which says nothing about where to
  // go next. They stay visually quiet so they read as a horizon, not as a
  // list of failures.
  const defs = [
    { hue: 'body', icon: 'trending', unit: 'kg', label: (t) => `${t} kg down`, value: lost, tiers: [2, 5, 10] },
    { hue: 'training', icon: 'strength', unit: 'days', label: (t) => `${t} training days`, value: trained, tiers: [10, 25, 50, 100] },
    { hue: 'strength', icon: 'bulb', unit: 'PRs', label: (t) => `${t} personal record${t === 1 ? '' : 's'}`, value: prTotal, tiers: [1, 10, 25, 50] },
    { hue: 'nutrition', icon: 'target', unit: 'day streak', label: (t) => `${t}-day streak`, value: best, tiers: [3, 7, 14, 30] },
  ];

  const items = [];
  for (const d of defs) {
    // The highest tier already cleared, plus the next one to aim at --
    // never the whole ladder, which would bury the page in badges.
    const earnedTiers = d.tiers.filter((t) => d.value >= t);
    const nextTier = d.tiers.find((t) => d.value < t);
    const top = earnedTiers[earnedTiers.length - 1];
    if (top != null) items.push({ ...d, tier: top, earned: true, progress: 1 });
    if (nextTier != null) {
      items.push({ ...d, tier: nextTier, earned: false, progress: Math.max(0, Math.min(1, d.value / nextTier)), remaining: nextTier - d.value });
    }
  }
  if (!items.length) return null;

  return (
    <Section title="Milestones">
      <div className="grid grid-cols-2 gap-2.5">
        {items.map((m, i) => {
          const color = `var(--m-${m.hue})`;
          return (
            <div
              key={i}
              className="rounded-[var(--r-lg)] p-3"
              style={{
                background: m.earned ? `var(--m-${m.hue}-bg)` : 'transparent',
                border: `1px solid ${m.earned ? 'transparent' : 'var(--line)'}`,
                // Unearned tiles sit back without being unreadable --
                // dimming the whole tile would fail contrast on its text.
                opacity: m.earned ? 1 : 0.72,
              }}
            >
              <div className="flex items-center justify-between gap-1">
                <span
                  className="inline-flex items-center justify-center rounded-full"
                  style={{ width: 24, height: 24, background: m.earned ? color : 'var(--line)', color: m.earned ? 'var(--bg)' : 'var(--faint)' }}
                >
                  <Icon name={m.earned ? 'check' : m.icon} size={13} />
                </span>
                {!m.earned && (
                  <Ring value={m.progress} size={24} stroke={3} color={color} label={`${Math.round(m.progress * 100)} percent toward ${m.label(m.tier)}`} />
                )}
              </div>
              <div className="mt-1.5 text-[12.5px] font-bold leading-tight" style={{ color: 'var(--ink)' }}>
                {m.label(m.tier)}
              </div>
              <div className="mt-0.5 text-[9.5px]" style={{ color: m.earned ? color : 'var(--faint)' }}>
                {m.earned
                  ? 'Achieved'
                  : `${Math.round(m.remaining * 10) / 10} ${m.unit} to go`}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/* ══════════════════════════ strength progression ══════════════════════════ */

/**
 * WHERE YOUR STRENGTH IS MOVING — start versus now, per lift, ranked.
 *
 * This replaced a flat "recent PRs" timeline that listed the same exercise
 * names already shown in the bests grid directly above it, clustered on
 * whichever day the user last trained. Six rows all dated the same day is a
 * session dump, not a timeline, and it answered a question nobody asked.
 *
 * "Bench 60 -> 75 kg over 11 weeks" is a different question from "what is
 * my best bench?", and a more useful one: it shows the journey, ranks where
 * progress is actually happening, and — the part a bests grid structurally
 * cannot show — makes lifts that have STOPPED moving or gone backwards
 * visible. A lift going down is the single most actionable thing on this
 * page, and it was previously invisible.
 *
 * Compared on estimated 1RM so 60x10 correctly beats 60x5.
 */
export function StrengthProgressSection({ progress, Section, onSelect }) {
  const [showAll, setShowAll] = useState(false);
  if (!progress?.length) return null;

  const gaining = progress.filter((p) => (p.gainPercent ?? 0) > 0);
  const losing = progress.filter((p) => (p.gainPercent ?? 0) < 0);
  const shown = showAll ? progress : gaining.slice(0, 4);
  if (!shown.length && !losing.length) return null;

  const maxPct = Math.max(...progress.map((p) => Math.abs(p.gainPercent ?? 0)), 1);

  const Row = ({ p }) => {
    const up = (p.gainPercent ?? 0) >= 0;
    const tone = up ? 'var(--good)' : 'var(--warn)';
    return (
      <button
        onClick={() => onSelect?.(p.exerciseId)}
        // Square rows on purpose: rounded rows inside a divide-y container
        // made each separator read as curve-straight-curve. The CARD carries
        // the radius; the rows inside it are flush.
        className="w-full px-1 py-2.5 text-left transition-colors"
        style={{ minHeight: 44 }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 flex-1 text-[12.5px] font-bold leading-tight" style={{ color: 'var(--ink)' }}>
            {p.exercise}
          </span>
          <span className="shrink-0 text-[12.5px] font-black tabular-nums" style={{ color: tone }}>
            {up ? '+' : ''}{p.gainPercent}%
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2">
          {/* Magnitude bar, signed. Direction is carried by the number and
              the words too, never by colour alone. */}
          <span className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
            <span
              className="block h-full rounded-full"
              style={{ width: `${(Math.abs(p.gainPercent ?? 0) / maxPct) * 100}%`, background: tone }}
            />
          </span>
        </div>

        <div className="mt-1 flex items-baseline justify-between gap-2 text-[10px] tabular-nums" style={{ color: 'var(--faint)' }}>
          <span>
            {p.from.weight} kg × {p.from.reps} → <span style={{ color: 'var(--mute)' }}>{p.to.weight} kg × {p.to.reps}</span>
          </span>
          <span>{p.spanDays >= 14 ? `${Math.round(p.spanDays / 7)} wks` : `${p.spanDays}d`}</span>
        </div>
      </button>
    );
  };

  return (
    <Section
      title="Where your strength is moving"
      action={
        progress.length > 4 ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="-my-2 px-2 py-2 text-[10.5px] font-semibold"
            // Padding rather than a taller box: the control has to reach
            // 44px of TAPPABLE area without pushing the section header
            // apart, so the negative margin absorbs it back out of flow.
            style={{ color: 'var(--accent)', minHeight: 44 }}
          >
            {showAll ? 'Show less' : `All ${progress.length}`}
          </button>
        ) : null
      }
    >
      <Card className="p-3">
        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          {shown.map((p) => <Row key={p.exerciseId} p={p} />)}
        </div>

        {/* Lifts going the wrong way get their own, quieter block rather
            than being buried at the bottom of a single ranked list. */}
        {!showAll && losing.length > 0 && (
          <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
            <div className="mb-1 text-[9.5px] font-bold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>
              Going backwards
            </div>
            {losing.slice(0, 2).map((p) => <Row key={p.exerciseId} p={p} />)}
            <div className="mt-1 px-1 text-[10px]" style={{ color: 'var(--faint)' }}>
              Compared on estimated 1RM, so lighter weight at higher reps still counts.
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}
