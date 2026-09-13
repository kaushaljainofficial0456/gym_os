/**
 * PROGRESS — the weekly report, body measurements and milestones.
 *
 * Split out of Progress.jsx purely for file size: these three sections are
 * self-contained and read better beside each other than buried in a
 * 1,000-line page. They follow the same rules as everything else on
 * Progress — nothing is rendered unless real rows back it, and no number
 * is fabricated to fill a card.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card } from '../../components/UI.jsx';
import Icon from '../../components/Icon.jsx';
import Ring from '../../components/Ring.jsx';
import MetricChart from '../../components/MetricChart.jsx';
import { useUnits } from '../../unitsContext.jsx';
import { buildAchievements, achievementSummary, ACHIEVEMENT_GROUPS } from '../../achievements.js';

const n1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());

/* ══════════════════════════ this week ══════════════════════════ */

/**
 * The weekly report. Compares against last week ONLY when there is a last
 * week to compare against — a first-week user gets their real numbers
 * without a meaningless "+100%" pinned beside them.
 */
export function WeekSection({ week, Section, Stat }) {
  const u = useUnits();
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
          <Stat label="Volume" value={fmtNum(u.weightNum(week.volume || 0, { decimals: 0 }))} unit={u.weightUnit} />
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
  const u = useUnits();
  const keys = Object.keys(measurements || {}).filter((k) => measurements[k]?.length);
  const [sel, setSel] = useState(null);
  const [logging, setLogging] = useState(false);
  // Bumped on any save or delete so the history refetches without the
  // whole Progress page reloading underneath the reader.
  const [historyKey, setHistoryKey] = useState(0);
  /* The most recent reading per site, in canonical cm, so the log form
     can show what each figure was last time and what just changed. */
  const previous = Object.fromEntries(
    Object.entries(measurements || {})
      .map(([k, series]) => [k, series?.length ? series[series.length - 1].value : null])
      .filter(([, v]) => v != null),
  );
  const changed = () => { setHistoryKey((k) => k + 1); onLogged?.(); };

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
              ? <MeasurementForm clientId={clientId} previous={previous} onDone={() => { setLogging(false); changed(); }} onCancel={() => setLogging(false)} />
              : <button className="btn mt-3 w-full" onClick={() => setLogging(true)}>Add measurements</button>
          )}
        </Card>
        {clientId && <CustomMetrics />}
      </Section>
    );
  }

  const active = keys.includes(sel) ? sel : keys[0];
  const series = measurements[active];
  const a = analyze(series);

  /* EVERY TRACKED SITE AT ONCE, then one of them in detail.
     A chip row plus a single number answered "what is my waist" but not
     "what is my shape doing", which is the only reason to measure more
     than one site. The grid is the section's real content now; selecting
     a tile swaps which one gets the chart underneath, so the detail is
     still one tap away and nothing was lost. */
  const tiles = keys.map((k) => {
    const s = measurements[k];
    const st = analyze(s);
    return { key: k, label: MEASURE_LABEL[k] || k, current: st.current, change: st.count > 1 ? st.change : null };
  });

  // Direction is stated in words as well as colour -- for most
  // circumferences down is the wanted direction, and colour alone would
  // be the only carrier of that for anyone who cannot separate the hues.
  const toneFor = (change) => (change == null || change === 0 ? 'var(--faint)' : change < 0 ? 'var(--good)' : 'var(--warn)');

  return (
    <Section title="Measurements">
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
          {tiles.map((t) => {
            const on = t.key === active;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSel(t.key)}
                aria-pressed={on}
                className="rounded-[var(--r-lg)] p-2.5 text-left transition-colors"
                style={{
                  border: `1px solid ${on ? 'var(--m-body)' : 'var(--line)'}`,
                  background: on ? 'var(--m-body-bg)' : 'transparent',
                  minHeight: 62,
                }}
              >
                <div className="text-[9.5px] font-semibold uppercase tracking-[.07em] truncate" style={{ color: 'var(--faint)' }}>
                  {t.label}
                </div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-[17px] font-black leading-none tabular-nums" style={{ color: 'var(--ink)' }}>
                    {u.lengthNum(t.current, { decimals: 1 }) ?? '—'}
                  </span>
                  <span className="text-[9.5px]" style={{ color: 'var(--faint)' }}>{u.lengthUnit}</span>
                </div>
                <div className="mt-0.5 text-[9.5px] tabular-nums" style={{ color: toneFor(t.change) }}>
                  {t.change == null
                    ? 'first reading'
                    : t.change === 0
                      ? 'no change'
                      : `${t.change < 0 ? '−' : '+'}${u.lengthNum(Math.abs(t.change), { decimals: 1 })} ${u.lengthUnit} ${t.change < 0 ? 'down' : 'up'}`}
                </div>
              </button>
            );
          })}
        </div>

        {clientId && (
          logging
            ? <MeasurementForm clientId={clientId} previous={previous} onDone={() => { setLogging(false); changed(); }} onCancel={() => setLogging(false)} />
            : (
              <button className="btn btn-sm mt-3 w-full" onClick={() => setLogging(true)}>Add measurements</button>
            )
        )}
        <MeasurementHistory clientId={clientId} reloadKey={historyKey} onChanged={changed} />

        {series.length >= 2 ? (
          <div className="mt-3">
            <div className="text-[10px] font-bold uppercase tracking-[.09em] mb-1" style={{ color: 'var(--faint)' }}>
              {MEASURE_LABEL[active] || active} over time
              {a.count > 1 && (
                <span className="ml-1.5 font-semibold tracking-normal normal-case" style={{ color: toneFor(a.change) }}>
                  {a.change > 0 ? '+' : a.change < 0 ? '−' : ''}
                  {u.lengthNum(Math.abs(a.change), { decimals: 1 })} {u.lengthUnit} since first
                </span>
              )}
            </div>
            <MetricChart
              /* Converted as a SERIES, not per point at render: the axis,
                 the tooltip and the label all read one array, so they
                 cannot end up in different units. */
              points={series.map((p) => ({ ...p, value: u.lengthNum(p.value, { decimals: 1 }) }))}
              color="var(--m-body)"
              unit={u.lengthUnit}
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

      {/* The other half of "measurements": the things only this person
          thought to track. One screen, because the product had two and
          the navigation already called both of them Measurements. */}
      {clientId && <CustomMetrics />}
    </Section>
  );
}

/* The typical adult range for each site, in centimetres, alongside the
   label. These are NOT a validation gate -- the server owns that -- they
   drive a hint next to a value that looks like a mistake, which is the
   only place a mistake can actually be corrected. Generous on both ends:
   the point is to catch an inch typed into a centimetre field or a
   slipped decimal, not to tell anyone their body is out of range. */
const MEASURE_FIELDS = [
  { key: 'waist', label: 'Waist', lo: 50, hi: 160 },
  { key: 'chest', label: 'Chest', lo: 60, hi: 160 },
  { key: 'arms', label: 'Arms', lo: 18, hi: 60 },
  { key: 'thighs', label: 'Thighs', lo: 30, hi: 90 },
  { key: 'hips', label: 'Hips', lo: 60, hi: 170 },
  { key: 'neck', label: 'Neck', lo: 25, hi: 55 },
];

/** Logs or corrects a measurement set.
 *
 *  Creating posts to the EXISTING POST /clients/:id/measurements; editing
 *  PATCHes the one row. Every field is optional: someone who only ever
 *  tracks their waist should not have to invent a neck measurement to
 *  save, and clearing a field on an edit sends an explicit null so the
 *  one bad reading goes without taking the set with it.
 */
function MeasurementForm({ clientId, onDone, onCancel, editing, previous }) {
  const u = useUnits();
  const isEdit = !!editing;
  const [vals, setVals] = useState(() => {
    if (!editing) return {};
    const out = {};
    for (const f of MEASURE_FIELDS) {
      const cm = editing[f.key];
      if (cm != null) out[f.key] = String(u.lengthNum(cm, { decimals: u.isImperial ? 1 : 0 }));
    }
    return out;
  });
  /* THE DATE IS PART OF THE READING. Without it every entry lands on
     today, so a set measured on Sunday and typed in on Tuesday is
     recorded two days late -- and the trend line is drawn from these
     dates. Defaults to today, which is the common case. */
  const [takenOn, setTakenOn] = useState(() => (editing?.taken_at || new Date().toISOString()).slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    let any = false;
    for (const f of MEASURE_FIELDS) {
      const raw = vals[f.key];
      /* The number typed is in the reader's unit; the API stores
         centimetres. Converting here -- at the one boundary where a human
         entered it -- is what stops a series from becoming a mix of cm
         and inch rows, which no later formatter could untangle. */
      const v = u.toCm(raw);
      if (Number.isFinite(v) && v > 0) { body[f.key] = v; any = true; }
      else if (isEdit && editing[f.key] != null && (raw ?? '').trim() === '') {
        // Emptied a field that had a value: that is a deliberate clear.
        body[f.key] = null; any = true;
      }
    }
    if (!any) { setErr(isEdit ? 'Nothing changed' : 'Enter at least one measurement'); return; }
    // Midday, not midnight: a date-only value parsed as UTC midnight lands
    // on the previous day for anyone west of Greenwich.
    body.taken_at = `${takenOn}T12:00:00.000Z`;
    setSaving(true);
    try {
      if (isEdit) {
        await api(`/clients/${clientId}/measurements/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await api(`/clients/${clientId}/measurements`, { method: 'POST', body: JSON.stringify(body) });
      }
      onDone?.();
    } catch (e2) { setErr(e2.message); }
    setSaving(false);
  };

  // Compared in CANONICAL centimetres, so the hint behaves identically
  // in either unit rather than needing a second set of thresholds.
  const odd = MEASURE_FIELDS.filter((f) => {
    const cm = u.toCm(vals[f.key]);
    return Number.isFinite(cm) && cm > 0 && (cm < f.lo || cm > f.hi);
  });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form onSubmit={submit} className="mt-3 rounded-[var(--r-sm)] p-3" style={{ border: '1px solid var(--line)' }}>
      <label className="block mb-2.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Measured on</span>
        <input
          type="date" value={takenOn} max={today} aria-label="Date measured"
          onChange={(e) => setTakenOn(e.target.value)}
          className="input mt-0.5 w-full text-[13px]" style={{ minHeight: 40 }}
        />
      </label>
      {/* EACH FIELD KNOWS WHAT IT WAS LAST TIME.
          Six bare number boxes made this pure data entry: you typed a
          figure with no idea whether it was progress, and found out
          later on a chart. Showing the previous reading turns the same
          form into the thing people actually came for -- the change --
          and it appears as you type, in your own unit. */}
      <div className="grid grid-cols-2 gap-2 min-[380px]:grid-cols-3">
        {MEASURE_FIELDS.map((f) => {
          const prevCm = previous?.[f.key];
          const nowCm = u.toCm(vals[f.key]);
          const delta = (Number.isFinite(nowCm) && nowCm > 0 && Number.isFinite(Number(prevCm)))
            ? nowCm - Number(prevCm) : null;
          const tone = delta == null || Math.abs(delta) < 0.05
            ? 'var(--faint)' : delta < 0 ? 'var(--good)' : 'var(--warn)';
          return (
            <label key={f.key} className="block">
              <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>{f.label}</span>
              <input
                type="number" inputMode="decimal" step="0.1" min="0" placeholder={u.lengthUnit}
                aria-label={`${f.label} in ${u.isImperial ? 'inches' : 'centimetres'}`}
                value={vals[f.key] || ''}
                onChange={(ev) => setVals((v) => ({ ...v, [f.key]: ev.target.value }))}
                className="input mt-0.5 w-full text-[14px] tabular-nums" style={{ minHeight: 46 }}
              />
              <span className="block mt-0.5 text-[9.5px] tabular-nums truncate" style={{ color: tone }}>
                {delta != null
                  ? (Math.abs(delta) < 0.05
                      ? 'no change'
                      : `${delta < 0 ? '−' : '+'}${u.lengthNum(Math.abs(delta), { decimals: 1 })} ${u.lengthUnit}`)
                  : (prevCm != null ? `was ${u.lengthNum(prevCm, { decimals: 1 })}` : '—')}
              </span>
            </label>
          );
        })}
      </div>
      {/* A value far outside the human range is nearly always a unit
          mix-up or a slipped decimal, and saying so BEFORE the save is
          what stops it owning the chart forever. Phrased as a question,
          not a rejection -- the save still goes through. */}
      {odd.length > 0 && (
        <div className="mt-2 text-[11px] leading-snug" style={{ color: 'var(--warn)' }}>
          {odd.map((f) => f.label).join(' and ')} {odd.length === 1 ? 'looks' : 'look'} unusual for
          {u.isImperial ? ' inches' : ' centimetres'} — worth a second look before saving.
        </div>
      )}
      {err && <div className="mt-2 text-[11px]" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-sm flex-1" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary btn-sm flex-1" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
        </button>
      </div>
      <div className="mt-2 text-[9.5px]" style={{ color: 'var(--faint)' }}>
        {isEdit ? 'Clear a box to remove just that reading.' : 'Leave any blank — only what you fill in is saved.'}
      </div>
    </form>
  );
}

/**
 * MEASUREMENT HISTORY — every set you have recorded, newest first.
 *
 * The charts above answer "which way is this going". This answers "what
 * did I actually write down, and can I fix it" -- which until now had no
 * answer at all, because nothing in the product could edit or remove a
 * measurement once saved. A tape read into the wrong column was
 * permanent, and it bends a trend line forever.
 *
 * Cards rather than a table: six columns of numbers on a 360px phone is
 * a horizontal scroll pretending to be a data grid.
 */
function MeasurementHistory({ clientId, reloadKey, onChanged }) {
  const u = useUnits();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !clientId) return undefined;
    let alive = true;
    setErr(null);
    api(`/clients/${clientId}/measurements`)
      .then((r) => { if (alive) setRows(r.measurements || []); })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [clientId, open, reloadKey]);

  const remove = async (row) => {
    // Confirmed, and named: "are you sure?" over a list of six identical
    // cards does not tell you WHICH one is about to go.
    const when = new Date(row.taken_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    if (!window.confirm(`Delete the measurements recorded on ${when}? This cannot be undone.`)) return;
    setBusyId(row.id);
    try {
      await api(`/clients/${clientId}/measurements/${row.id}`, { method: 'DELETE' });
      setRows((rs) => (rs || []).filter((x) => x.id !== row.id));
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusyId(null);
  };

  if (!clientId) return null;

  if (!open) {
    return (
      <button className="btn btn-sm mt-2 w-full" onClick={() => setOpen(true)}>
        View measurement history
      </button>
    );
  }

  const ordered = [...(rows || [])].sort((a, b) => String(b.taken_at).localeCompare(String(a.taken_at)));

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-bold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>History</div>
        <button className="text-[10.5px] font-semibold tap-target" style={{ color: 'var(--accent)' }} onClick={() => { setOpen(false); setEditingId(null); }}>
          Hide
        </button>
      </div>

      {err && <div className="text-[11px] mb-2" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}
      {rows === null && !err && <div className="text-[11px]" style={{ color: 'var(--faint)' }}>Loading…</div>}
      {rows && !ordered.length && (
        <div className="text-[11px]" style={{ color: 'var(--faint)' }}>Nothing recorded yet.</div>
      )}

      <div className="space-y-2">
        {ordered.map((row) => {
          const present = MEASURE_FIELDS.filter((f) => row[f.key] != null);
          return (
            <div key={row.id} className="rounded-[var(--r-sm)] p-2.5" style={{ border: '1px solid var(--line)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11.5px] font-bold" style={{ color: 'var(--ink)' }}>
                  {new Date(row.taken_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="chip !text-[10px] tap-target"
                    onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                    aria-label={`Edit the measurements from ${new Date(row.taken_at).toLocaleDateString()}`}
                  >
                    {editingId === row.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    className="chip !text-[10px] !border-bad/40 tap-target"
                    style={{ color: 'var(--bad)' }}
                    disabled={busyId === row.id}
                    onClick={() => remove(row)}
                    aria-label={`Delete the measurements from ${new Date(row.taken_at).toLocaleDateString()}`}
                  >
                    {busyId === row.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>

              {present.length ? (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {present.map((f) => (
                    <span key={f.key} className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
                      {f.label} <strong style={{ color: 'var(--ink)' }}>{u.lengthNum(row[f.key], { decimals: 1 })} {u.lengthUnit}</strong>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[10.5px]" style={{ color: 'var(--faint)' }}>No readings left in this entry.</div>
              )}

              {editingId === row.id && (
                <MeasurementForm
                  clientId={clientId}
                  editing={row}
                  onCancel={() => setEditingId(null)}
                  onDone={() => { setEditingId(null); onChanged?.(); }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ANYTHING ELSE YOU WANT TO TRACK.
 *
 * The product had two places for "a number about me, over time" and the
 * navigation could not tell them apart: Progress held body measurements
 * (fixed sites, metric storage) and Profile held "My Metrics" (anything
 * you name yourself) -- and the sidebar row pointing at the second one
 * was labelled "Measurements". Two screens, one job, one name between
 * them. So they are one screen now: the six body sites above, and
 * whatever else you have defined here, with the same logging and the
 * same history underneath.
 *
 * THE UNIT STAYS YOURS. Body sites are stored in centimetres and drawn
 * in whatever you read in, because the app knows what they are. A custom
 * metric's unit is a label you typed -- "steps", "hours", "mg" -- so it
 * is stored and shown exactly as entered and never converted. Guessing
 * that "kg" on a custom metric means bodyweight would be the app being
 * clever about a number it does not understand.
 */
function CustomMetrics() {
  const metrics = useFetch(() => api('/me/metrics'), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', unit: '', type: 'number', frequency: 'weekly', target: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [logFor, setLogFor] = useState(null);
  const [logValue, setLogValue] = useState('');

  const rows = metrics.data?.metrics || [];

  const create = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr('Give it a name'); return; }
    setBusy(true); setErr('');
    try {
      await api('/me/metrics', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          unit: form.unit.trim() || null,
          type: form.type,
          frequency: form.frequency,
          target: form.target === '' ? null : Number(form.target),
        }),
      });
      setForm({ name: '', unit: '', type: 'number', frequency: 'weekly', target: '' });
      setAdding(false);
      metrics.reload({ silent: true });
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  const logEntry = async (m) => {
    const v = Number(logValue);
    if (!Number.isFinite(v)) { setErr('Enter a number'); return; }
    setBusy(true); setErr('');
    try {
      await api(`/me/metrics/${m.id}/entries`, { method: 'POST', body: JSON.stringify({ value: v }) });
      setLogFor(null); setLogValue('');
      metrics.reload({ silent: true });
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };

  const remove = async (m) => {
    if (!window.confirm(
      `Delete "${m.name}" and every reading you have recorded for it?\n\nThis cannot be undone.`,
    )) return;
    try {
      await api(`/me/metrics/${m.id}`, { method: 'DELETE' });
      metrics.reload({ silent: true });
    } catch (e2) { setErr(e2.message); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold uppercase tracking-[.09em]" style={{ color: 'var(--faint)' }}>
          Anything else you track
        </div>
        {!adding && (
          <button className="text-[10.5px] font-semibold tap-target" style={{ color: 'var(--accent)' }}
                  onClick={() => { setAdding(true); setErr(''); }}>
            + Add
          </button>
        )}
      </div>

      {err && <div className="mt-2 text-[11px]" style={{ color: 'var(--bad)' }} role="alert">{err}</div>}

      {adding && (
        <form onSubmit={create} className="mt-2.5 rounded-[var(--r-sm)] p-3" style={{ border: '1px solid var(--line)' }}>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>What</span>
              <input className="input mt-0.5 w-full text-[13px]" style={{ minHeight: 40 }} autoFocus
                     placeholder="Resting heart rate" aria-label="Metric name"
                     value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="block">
              <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Unit</span>
              <input className="input mt-0.5 w-full text-[13px]" style={{ minHeight: 40 }}
                     placeholder="bpm" aria-label="Unit"
                     value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label className="block">
              <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>How often</span>
              <select className="input mt-0.5 w-full text-[13px]" style={{ minHeight: 40 }} aria-label="How often"
                      value={form.frequency} onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Target</span>
              <input className="input mt-0.5 w-full text-[13px] tabular-nums" style={{ minHeight: 40 }}
                     type="number" placeholder="optional" aria-label="Target"
                     value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn btn-sm flex-1" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
            <button type="submit" className="btn-primary btn-sm flex-1" disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          <div className="mt-2 text-[9.5px]" style={{ color: 'var(--faint)' }}>
            The unit is shown exactly as you type it — custom metrics are never converted.
          </div>
        </form>
      )}

      {!rows.length && !adding && (
        <p className="mt-2 text-[11.5px] leading-snug" style={{ color: 'var(--faint)' }}>
          Resting heart rate, sleep hours, step count, a lift you want to watch — anything with a
          number and a date belongs here.
        </p>
      )}

      <div className="mt-2.5 space-y-2">
        {rows.map((m) => {
          const entries = m.entries || [];
          const values = entries.map((e) => e.value).reverse();
          return (
            <div key={m.id} className="rounded-[var(--r-sm)] p-2.5" style={{ border: '1px solid var(--line)' }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-bold truncate" style={{ color: 'var(--ink)' }}>
                    {m.name}
                    {m.unit && <span className="ml-1 text-[10px] font-medium" style={{ color: 'var(--faint)' }}>{m.unit}</span>}
                  </div>
                  <div className="text-[10.5px] mt-0.5 tabular-nums" style={{ color: 'var(--mute)' }}>
                    {m.latest
                      ? <>Latest <strong style={{ color: 'var(--ink)' }}>{m.latest.value}{m.unit ? ` ${m.unit}` : ''}</strong> · {String(m.latest.date).slice(0, 10)}</>
                      : 'Nothing recorded yet'}
                    {m.target != null && <> · target {m.target}{m.unit ? ` ${m.unit}` : ''}</>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="chip !text-[10px] tap-target"
                          onClick={() => { setLogFor(logFor === m.id ? null : m.id); setLogValue(''); setErr(''); }}
                          aria-label={`Log a reading for ${m.name}`}>
                    {logFor === m.id ? 'Close' : 'Log'}
                  </button>
                  <button className="chip !text-[10px] !border-bad/40 tap-target" style={{ color: 'var(--bad)' }}
                          onClick={() => remove(m)} aria-label={`Delete ${m.name}`}>
                    Delete
                  </button>
                </div>
              </div>

              {values.length > 1 && <MiniTrend values={values} />}

              {logFor === m.id && (
                <div className="mt-2 flex gap-2">
                  <input className="input flex-1 text-[13px] tabular-nums" style={{ minHeight: 40 }}
                         type="number" inputMode="decimal" autoFocus
                         placeholder={m.unit || 'value'} aria-label={`New reading for ${m.name}`}
                         value={logValue} onChange={(e) => setLogValue(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter') logEntry(m); }} />
                  <button className="btn-primary btn-sm shrink-0" disabled={busy} onClick={() => logEntry(m)}>
                    {busy ? '…' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** A bare sparkline. No axis, no labels -- it answers "which way" and
 *  the number above it answers "how much". */
function MiniTrend({ values }) {
  const v = (values || []).filter((n) => Number.isFinite(Number(n))).map(Number);
  if (v.length < 2) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * 100},${28 - ((n - min) / span) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 w-full" style={{ height: 30 }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--m-body)" strokeWidth="1.6"
                vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ══════════════════════════ milestones ══════════════════════════ */

/**
 * MILESTONES — 120 of them, and none awarded for nothing.
 *
 * This was four families and thirteen badges, which is a summary rather
 * than somewhere to aim. The catalogue lives in achievements.js and every
 * entry reads the same progress payload the charts on this page read, so
 * a badge can never disagree with the chart above it.
 *
 * WHAT IS SHOWN BY DEFAULT is the part that is actually useful: what you
 * just earned, and the handful you are closest to. A wall of 120 cards is
 * a reference document, not a screen -- so the full list is behind a
 * deliberate tap and grouped, rather than being the first thing you have
 * to scroll past.
 */
export function AchievementsSection({ intel, Section }) {
  const u = useUnits();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState('Training');

  /* Volume milestones run to millions; a decimal there reads as false
     precision ("11023.1 lb"). Body-weight ones are the opposite -- 2.5 kg
     down is a real distinction. So the split is by magnitude. */
  const all = useMemo(
    () => buildAchievements(intel, (kg) => u.fmtWeight(kg, { decimals: Math.abs(kg) >= 1000 ? 0 : 1 })),
    [intel, u.system],
  );
  const { earned, total } = achievementSummary(all);

  // The value as a person would say it: weights follow the unit
  // preference, everything else is a plain count.
  const amount = (a, v) => (a.isWeight ? u.fmtWeight(v) : `${Math.round(v).toLocaleString()} ${a.unit}`);

  /* The highest tier reached in each family -- one card per idea, not one
     per rung, so the earned view reads as achievements rather than as a
     changelog of every threshold crossed. */
  const latest = useMemo(() => {
    const byFamily = new Map();
    for (const a of all) {
      if (!a.earned) continue;
      const cur = byFamily.get(a.familyId);
      if (!cur || a.tier > cur.tier) byFamily.set(a.familyId, a);
    }
    return [...byFamily.values()].sort((x, y) => y.level / y.levels - x.level / x.levels);
  }, [all]);

  /* Closest to earning: sorted by how nearly done, and only ones actually
     started. "0 of 500 sessions" is not a near miss, it is the whole
     ladder, and putting it here would bury the genuine ones. */
  const nearest = useMemo(() => all
    .filter((a) => !a.earned && a.progress > 0.15)
    .sort((x, y) => y.progress - x.progress)
    .slice(0, 3), [all]);

  if (!all.length) return null;

  const Badge = ({ a, showProgress }) => (
    <div
      className="rounded-[var(--r-lg)] p-3"
      style={{
        background: a.earned ? `var(--m-${a.hue}-bg)` : 'transparent',
        border: `1px solid ${a.earned ? 'transparent' : 'var(--line)'}`,
        opacity: a.earned ? 1 : 0.75,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="inline-flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 26, height: 26,
            background: a.earned ? `var(--m-${a.hue})` : 'var(--line)',
            color: a.earned ? 'var(--bg)' : 'var(--faint)',
          }}
        >
          <Icon name={a.earned ? 'check' : a.icon} size={13} />
        </span>
        {a.levels > 1 && (
          <span className="text-[9px] font-bold tabular-nums shrink-0"
                style={{ color: a.earned ? `var(--m-${a.hue})` : 'var(--faint)' }}>
            {a.level}/{a.levels}
          </span>
        )}
      </div>

      <div className="mt-1.5 text-[12px] font-bold leading-tight" style={{ color: 'var(--ink)' }}>
        {a.name}
      </div>
      <div className="text-[10px] leading-snug mt-0.5" style={{ color: 'var(--faint)' }}>
        {a.description}
      </div>

      {showProgress && !a.earned && (
        <>
          <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            <div className="h-full rounded-full"
                 style={{ width: `${a.progress * 100}%`, background: `var(--m-${a.hue})`, transition: 'width .6s' }} />
          </div>
          <div className="mt-1 text-[9.5px] tabular-nums" style={{ color: 'var(--faint)' }}>
            {amount(a, a.value)} of {amount(a, a.tier)}
          </div>
        </>
      )}
    </div>
  );

  return (
    <Section
      title="Milestones"
      action={
        <span className="text-[10.5px] font-semibold tabular-nums" style={{ color: 'var(--accent)' }}>
          {earned} of {total}
        </span>
      }
    >
      {latest.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 min-[420px]:grid-cols-3">
          {latest.slice(0, 6).map((a) => <Badge key={a.key} a={a} />)}
        </div>
      )}

      {nearest.length > 0 && (
        <>
          <div className="text-[10px] font-bold uppercase tracking-[.09em] mt-1" style={{ color: 'var(--faint)' }}>
            Closest to earning
          </div>
          <div className="grid grid-cols-2 gap-2.5 min-[420px]:grid-cols-3">
            {nearest.map((a) => <Badge key={a.key} a={a} showProgress />)}
          </div>
        </>
      )}

      {!latest.length && !nearest.length && (
        <Card className="p-4">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
            Your first milestone is one session away
          </div>
          <div className="mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--faint)' }}>
            Log a workout or a day of food and this fills in. There are {total} to find.
          </div>
        </Card>
      )}

      <button className="btn btn-sm w-full" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide all milestones' : `Browse all ${total} milestones`}
      </button>

      {open && (
        <Card className="p-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-0.5 px-0.5" role="tablist" aria-label="Milestone category">
            {ACHIEVEMENT_GROUPS.map((g) => {
              const on = g === group;
              const done = all.filter((a) => a.group === g && a.earned).length;
              const of = all.filter((a) => a.group === g).length;
              return (
                <button
                  key={g}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setGroup(g)}
                  className="shrink-0 rounded-full px-3 text-[11px] font-semibold whitespace-nowrap"
                  style={{
                    minHeight: 34,
                    background: on ? 'var(--cta-solid)' : 'transparent',
                    color: on ? 'var(--cta-ink)' : 'var(--mute)',
                    border: `1px solid ${on ? 'transparent' : 'var(--line)'}`,
                  }}
                >
                  {g} <span className="tabular-nums opacity-70">{done}/{of}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-2.5 mt-3 min-[420px]:grid-cols-3">
            {all.filter((a) => a.group === group).map((a) => (
              <Badge key={a.key} a={a} showProgress />
            ))}
          </div>
        </Card>
      )}
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
  const u = useUnits();
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
            {u.fmtWeight(p.from.weight)} × {p.from.reps} → <span style={{ color: 'var(--mute)' }}>{u.fmtWeight(p.to.weight)} × {p.to.reps}</span>
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
