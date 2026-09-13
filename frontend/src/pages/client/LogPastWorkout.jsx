/**
 * LOG A PAST WORKOUT — the session you did but forgot to start in the app.
 *
 * ARCHITECTURALLY THIS IS NOT A NEW KIND OF WORKOUT. It creates an ordinary
 * workout row and completes it through the ordinary completion endpoint,
 * just with the timestamps it actually happened at. Everything downstream
 * — workout_logs, the PR engine, the skos-cal calorie model, Progress,
 * volume, streaks — runs unchanged, because none of it is reimplemented
 * here. The only differences are the date/time being in the past and
 * `source: manual_retroactive` for provenance.
 *
 * INTENSITY reuses the app's existing per-set RIR (reps in reserve) rather
 * than inventing a second intensity scale: the calorie model already reads
 * RIR, so a four-step "how hard was it" maps onto the input the model
 * genuinely consumes instead of a new number nothing else understands.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useUnits } from '../../unitsContext.jsx';
import WeightInput from '../../components/WeightInput.jsx';
import { Sheet } from '../../components/UI.jsx';

// Easy -> lots left in the tank; Very hard -> nothing left. These are the
// RIR values the existing calorie model already reasons about.
const INTENSITY = [
  { key: 'easy', label: 'Easy', rir: 4 },
  { key: 'moderate', label: 'Moderate', rir: 2 },
  { key: 'hard', label: 'Hard', rir: 1 },
  { key: 'max', label: 'Very hard', rir: 0 },
];

const pad = (n) => String(n).padStart(2, '0');
const localDateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A start time that has ALREADY happened: now minus the session length,
 *  rounded down to five minutes.
 *
 *  A fixed 19:00 default meant opening this sheet before 7pm greeted the
 *  user with "that time is in the future" before they had typed anything --
 *  an error state as the opening impression, for a form they had not filled
 *  in yet. Defaulting to a plausible just-finished session also matches why
 *  people open this at all: they just left the gym. */
const defaultStartTime = (durationMin) => {
  const d = new Date(Date.now() - (Number(durationMin) || 60) * 60000);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function LogPastWorkout({ open, onClose, onSaved, libList, loadLib, toast }) {
  const u = useUnits();
  const today = new Date();
  const [date, setDate] = useState(localDateKey(today));
  const [startTime, setStartTime] = useState(() => defaultStartTime(60));
  const [durationMin, setDurationMin] = useState(60);
  const [intensity, setIntensity] = useState('moderate');
  const [rows, setRows] = useState([]);          // { exercise_id, name, sets, reps, weight }
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [overlaps, setOverlaps] = useState([]);
  const [confirmDupe, setConfirmDupe] = useState(false);

  useEffect(() => { if (open && !libList) loadLib?.(); }, [open, libList, loadLib]);

  // Reset every time the sheet opens: a half-filled previous attempt
  // reappearing is its own small bug.
  useEffect(() => {
    if (!open) return;
    setDate(localDateKey(new Date()));
    setStartTime(defaultStartTime(60));
    setDurationMin(60);
    setIntensity('moderate');
    setRows([]); setSearch(''); setError(null); setOverlaps([]); setConfirmDupe(false);
  }, [open]);

  const startedAtIso = useMemo(() => {
    const d = new Date(`${date}T${startTime}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [date, startTime]);

  /* END TIME AND DURATION ARE THE SAME FACT, entered from either side.
   *
   * The form only took a duration, so someone who remembers "I got there
   * at 7 and left at half eight" had to do the subtraction themselves --
   * and the end time was shown as a read-only consequence, which is the
   * one thing people actually know. Now duration derives the end, typing
   * an end derives the duration, and neither is the privileged one. */
  const endTime = useMemo(() => {
    if (!startedAtIso) return '';
    const end = new Date(Date.parse(startedAtIso) + Number(durationMin) * 60000);
    return `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  }, [startedAtIso, durationMin]);

  const onEndTimeChange = (value) => {
    if (!value || !startedAtIso) return;
    const [h, m] = value.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const start = new Date(startedAtIso);
    const end = new Date(start);
    end.setHours(h, m, 0, 0);
    // A session that ends "before" it started ran past midnight -- 23:30
    // to 00:45 is a real hour and a quarter, not a negative one.
    let mins = Math.round((end - start) / 60000);
    if (mins <= 0) mins += 24 * 60;
    if (mins > 0 && mins <= 360) setDurationMin(mins);
  };

  // Kept for the places that render the plain label.
  const endLabel = endTime;

  const isFuture = startedAtIso ? Date.parse(startedAtIso) > Date.now() : false;

  // Ask the server whether something is already logged around this time,
  // rather than silently creating a second session for one workout.
  useEffect(() => {
    if (!open || !startedAtIso || isFuture) { setOverlaps([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const q = `date=${date}&started_at=${encodeURIComponent(startedAtIso)}&duration_min=${durationMin}`;
        const r = await api(`/me/workouts/overlapping?${q}`);
        if (!cancelled) { setOverlaps(r.overlapping || []); setConfirmDupe(false); }
      } catch { /* advisory only — never block logging on this check */ }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, date, startedAtIso, durationMin, isFuture]);

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = libList || [];
    if (!q) return all.slice(0, 8);
    return all.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 8);
  }, [libList, search]);

  /* SETS ARE A LIST, not a count.
   *
   * This used to hold one reps value and one weight per exercise and
   * multiply it out, so a real session -- 60kg, 60kg, then 50kg when the
   * last set fell apart -- could only be logged as three sets at 60. That
   * inflates volume and hands the PR engine a lift that never happened.
   * Now each set is its own row, seeded from the previous one so the
   * common case (three identical sets) is still three taps. */
  const addExercise = (e) => {
    if (rows.some((r) => r.exercise_id === e.id)) return;
    setRows((rs) => [...rs, {
      exercise_id: e.id,
      name: e.name,
      sets: [
        { reps: 8, weight: 20 },
        { reps: 8, weight: 20 },
        { reps: 8, weight: 20 },
      ],
    }]);
    setSearch('');
  };
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));

  const patchSet = (i, si, patch) => setRows((rs) => rs.map((r, j) => (
    j === i ? { ...r, sets: r.sets.map((st, k) => (k === si ? { ...st, ...patch } : st)) } : r
  )));
  // A new set copies the one above it: the next set is usually the same
  // weight, and retyping it every time is the tax this screen existed to
  // avoid.
  const addSet = (i) => setRows((rs) => rs.map((r, j) => (
    j === i ? { ...r, sets: [...r.sets, { ...(r.sets[r.sets.length - 1] || { reps: 8, weight: 20 }) }] } : r
  )));
  const removeSet = (i, si) => setRows((rs) => rs.map((r, j) => (
    j === i && r.sets.length > 1 ? { ...r, sets: r.sets.filter((_, k) => k !== si) } : r
  )));

  const canSave = rows.length > 0 && startedAtIso && !isFuture && Number(durationMin) > 0
    && (overlaps.length === 0 || confirmDupe);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const rir = INTENSITY.find((i) => i.key === intensity)?.rir ?? 2;
      // 1. create the workout, at the time it actually happened
      const created = await api('/me/workouts', {
        method: 'POST',
        body: JSON.stringify({
          name: `Workout · ${new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
          date,
          started_at: startedAtIso,
          exercises: rows.map((r) => ({
            exercise_id: r.exercise_id,
            sets: r.sets.length,
            // The prescription line still wants one representative figure;
            // the real per-set numbers go in the completion below.
            reps: String(r.sets[0]?.reps ?? 0),
            weight: String(r.sets[0]?.weight ?? 0),
            rest_sec: 90,
          })),
        }),
      });
      // 2. complete it through the SAME endpoint a live session uses, so
      //    PRs, the calorie model and history all behave identically.
      const byExercise = new Map((created.exercises || []).map((e) => [e.exercise_id, e.id]));
      const logs = rows.map((r) => ({
        exercise_id: byExercise.get(r.exercise_id),
        // Each set exactly as entered -- this is what reaches workout_logs,
        // the PR engine and the calorie model.
        sets: r.sets.map((st) => ({
          actual_reps: Number(st.reps) || 0,
          actual_weight: Number(st.weight) || 0,
          rir, completed: true,
        })),
      })).filter((l) => l.exercise_id && l.sets.length);

      const res = await api(`/workouts/${created.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          logs,
          performed_date: date,
          started_at: startedAtIso,
          completed_at: new Date(Date.parse(startedAtIso) + Number(durationMin) * 60000).toISOString(),
          duration_seconds: Number(durationMin) * 60,
        }),
      });
      const kcal = res?.calorie?.estimated_active_kcal;
      toast?.(kcal ? `Workout logged · ~${Math.round(kcal)} kcal` : 'Workout logged');
      onSaved?.(res);
      onClose?.();
    } catch (e) {
      setError(e.message || "Couldn't save that workout. Try again.");
    }
    setSaving(false);
  };

  if (!open) return null;

  const field = { background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' };

  /* THIS SHEET USED TO BUILD ITS OWN OVERLAY, and that is why its blocks
     sat on top of each other on a phone. It positioned itself with
     `fixed inset-0` -- but `position: fixed` is resolved against the
     nearest TRANSFORMED ancestor, not the viewport, and this app animates
     cards in with transforms (anim-fadeUp / anim-scaleIn). Opened from
     inside one of those, the overlay anchored to the card instead of the
     screen and everything stacked.
     The shared Sheet portals to document.body, so it cannot inherit an
     ancestor's transform. It also brings the three things this hand-rolled
     copy never had: the page behind stops scrolling, Escape closes, and
     the save button clears the phone's home indicator
     (env(safe-area-inset-bottom)) instead of sitting under it. On mobile
     it is a bottom sheet rather than a centred modal, which is what the
     rest of the app already does. */
  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
      title="Log a past workout"
      sub="For a session you already did"
      footer={(
        <button className="btn-primary btn-block" disabled={!canSave || saving} onClick={save} style={{ minHeight: 48 }}>
          {saving ? 'Saving…' : 'Save workout'}
        </button>
      )}
    >
        <div className="space-y-4">
          {/* ── when ── */}
          <div>
            <div className="t-micro mb-2">When did you train?</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Date</span>
                <input type="date" value={date} max={localDateKey(new Date())}
                  onChange={(e) => setDate(e.target.value)}
                  className="input mt-1 w-full" style={{ ...field, minHeight: 44 }} />
              </label>
              <label className="block">
                <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Start time</span>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                  className="input mt-1 w-full" style={{ ...field, minHeight: 44 }} />
              </label>
            </div>

            {/* Either end of the session, whichever you remember. */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <label className="block">
                <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>End time</span>
                <input type="time" value={endTime} onChange={(e) => onEndTimeChange(e.target.value)}
                  aria-label="End time" className="input mt-1 w-full" style={{ ...field, minHeight: 44 }} />
              </label>
              <label className="block">
                <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Minutes</span>
                <input type="number" min="1" max="360" value={durationMin}
                  onChange={(e) => setDurationMin(e.target.value)} aria-label="Duration in minutes"
                  className="input mt-1 w-full text-right tabular-nums" style={{ ...field, minHeight: 44 }} />
              </label>
            </div>

            <div className="flex gap-1.5 mt-2 flex-wrap">
              {[30, 45, 60, 75, 90].map((m) => (
                <button key={m} onClick={() => setDurationMin(m)} type="button"
                  className="rounded-full px-3 text-[11.5px] font-semibold"
                  style={{
                    minHeight: 40,
                    background: Number(durationMin) === m ? 'var(--cta-solid)' : 'transparent',
                    color: Number(durationMin) === m ? 'var(--cta-ink)' : 'var(--mute)',
                    border: `1px solid ${Number(durationMin) === m ? 'var(--cta-edge)' : 'var(--line)'}`,
                  }}>{m}m</button>
              ))}
            </div>
            {startedAtIso && !isFuture && (
              <div className="text-[10px] mt-1.5" style={{ color: 'var(--faint)' }}>
                {startTime} → {endLabel} · {durationMin} min
              </div>
            )}

            {isFuture && (
              <div role="alert" className="mt-2 text-[11px]" style={{ color: 'var(--bad)' }}>
                That time is in the future — pick a session you've already done.
              </div>
            )}
          </div>

          {/* ── possible duplicate ── */}
          {overlaps.length > 0 && !isFuture && (
            <div className="rounded-xl p-3" style={{ border: '1px solid rgb(var(--warn-rgb) / .4)', background: 'rgb(var(--warn-rgb) / .08)' }}>
              <div className="text-[11.5px] font-semibold" style={{ color: 'var(--ink)' }}>
                You already have a workout around this time
              </div>
              <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                {overlaps.map((o) => o.name).join(', ')}
              </div>
              <label className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: 'var(--mute)' }}>
                <input type="checkbox" checked={confirmDupe} onChange={(e) => setConfirmDupe(e.target.checked)} />
                Log it anyway — this was a separate session
              </label>
            </div>
          )}

          {/* ── exercises ── */}
          <div>
            <div className="t-micro mb-2">What did you do?</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search exercises… (e.g. bench, squat)" aria-label="Search exercises"
              className="input w-full" style={{ ...field, minHeight: 44 }} />
            {search.trim() && (
              <div className="mt-1.5 space-y-1">
                {results.map((e) => (
                  <button key={e.id} onClick={() => addExercise(e)}
                    className="w-full text-left rounded-lg px-3 py-2 text-[12px]"
                    style={{ ...field, minHeight: 44 }}>{e.name}</button>
                ))}
                {!results.length && <div className="text-[11px] py-2" style={{ color: 'var(--faint)' }}>No matches.</div>}
              </div>
            )}

            <div className="space-y-2 mt-2">
              {rows.map((r, i) => (
                <div key={r.exercise_id} className="rounded-xl p-2.5" style={{ border: '1px solid var(--line)' }}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-grotesk text-[12px] font-semibold truncate">{r.name}</span>
                    <button type="button" onClick={() => removeRow(i)} className="text-[10px] shrink-0 tap-target"
                      style={{ color: 'var(--bad)', minHeight: 32 }}>Remove</button>
                  </div>

                  {/* One row per set, because that is how the session
                      happened. The old form took a single reps/weight and
                      multiplied it out, so 60/60/50 could only be logged
                      as three sets at 60 — inflating volume and handing
                      the PR engine a lift that never took place. */}
                  <div className="grid grid-cols-[18px_1fr_1fr_28px] gap-1.5 items-center px-0.5 mb-1">
                    <span className="text-[8.5px] uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>#</span>
                    <span className="text-[8.5px] uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Reps</span>
                    <span className="text-[8.5px] uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>{u.weightUnit}</span>
                    <span />
                  </div>

                  <div className="space-y-1.5">
                    {r.sets.map((st, si) => (
                      <div key={si} className="grid grid-cols-[18px_1fr_1fr_28px] gap-1.5 items-center">
                        <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>{si + 1}</span>
                        <input
                          type="number" min="0" inputMode="numeric" value={st.reps}
                          aria-label={`${r.name} set ${si + 1} reps`}
                          onChange={(e) => patchSet(i, si, { reps: e.target.value })}
                          className="input w-full text-right tabular-nums" style={{ ...field, minHeight: 40 }}
                        />
                        {/* Weight is the one field whose stored value and
                            typed value differ, so it uses the shared
                            kg-canonical input rather than a raw box. */}
                        <WeightInput
                          valueKg={st.weight}
                          onChangeKg={(kg) => patchSet(i, si, { weight: kg })}
                          ariaLabel={`${r.name} set ${si + 1} weight in ${u.isImperial ? 'pounds' : 'kilograms'}`}
                          className="input w-full text-right tabular-nums" style={{ ...field, minHeight: 40 }}
                        />
                        <button
                          type="button"
                          onClick={() => removeSet(i, si)}
                          disabled={r.sets.length <= 1}
                          aria-label={`Remove set ${si + 1} of ${r.name}`}
                          className="grid place-items-center rounded-md disabled:opacity-25"
                          style={{ width: 28, height: 34, color: 'var(--faint)' }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => addSet(i)}
                    className="mt-2 w-full rounded-lg text-[11px] font-semibold"
                    style={{ minHeight: 36, border: '1px dashed var(--line)', color: 'var(--mute)' }}
                  >
                    + Add set
                  </button>
                </div>
              ))}
              {!rows.length && (
                <div className="text-[11px] py-3 text-center" style={{ color: 'var(--faint)' }}>
                  Search above to add the exercises you did.
                </div>
              )}
            </div>
          </div>

          {/* ── intensity ── */}
          <div>
            <div className="t-micro mb-2">How hard was it?</div>
            <div className="flex gap-1.5 flex-wrap">
              {INTENSITY.map((o) => (
                <button key={o.key} onClick={() => setIntensity(o.key)}
                  className="rounded-full px-3 text-[11.5px] font-semibold"
                  style={{
                    minHeight: 44,
                    background: intensity === o.key ? 'var(--cta-solid)' : 'transparent',
                    color: intensity === o.key ? 'var(--cta-ink)' : 'var(--mute)',
                    border: `1px solid ${intensity === o.key ? 'var(--cta-edge)' : 'var(--line)'}`,
                  }}>{o.label}</button>
              ))}
            </div>
            <div className="text-[10px] mt-1.5" style={{ color: 'var(--faint)' }}>
              Calories are ESTIMATED from your exercises, duration and effort — not measured.
            </div>
          </div>

          {error && (
            <div role="alert" className="rounded-xl px-3 py-2 text-[11.5px]"
              style={{ background: 'rgb(var(--bad-rgb) / .10)', border: '1px solid rgb(var(--bad-rgb) / .35)', color: 'var(--bad)' }}>
              {error}
            </div>
          )}
        </div>
    </Sheet>
  );
}
