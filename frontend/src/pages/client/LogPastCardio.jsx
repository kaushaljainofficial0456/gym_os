/**
 * LOG A PAST CARDIO OR SPORT SESSION — the run you did this morning, or
 * the hour of badminton last night.
 *
 * THIS COULD NOT EXIST BEFORE, because cardio was never stored. A live
 * session lived in React state, showed a calorie summary and vanished;
 * there was no table, no endpoint and nowhere for a past one to go. With
 * cardio_sessions behind it, logging one afterwards is the same write the
 * live session now makes, with a date and a duration you type instead of
 * a timer you ran.
 *
 * ONE ACTIVITY PER SESSION, deliberately. The live flow supports several
 * bouts back to back because that is how a gym cardio block works; a
 * remembered session is "I played football for an hour", and asking
 * someone to build a multi-bout structure from memory would be a worse
 * form for the commoner case. Log two if you did two.
 *
 * THE CALORIE FIGURE IS AN ESTIMATE and says so. It is a MET model
 * applied to your body mass -- good for comparing your Tuesday to your
 * Thursday, not for balancing against what you ate.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Sheet } from '../../components/UI.jsx';
import {
  ACTIVITIES, ACTIVITY_GROUPS, activityName, activityFields,
  estimateKcal, usesEffortLevel, EFFORTS,
} from '../../cardioActivities.js';

const pad = (n) => String(n).padStart(2, '0');
const localDateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default function LogPastCardio({ open, onClose, onSaved, bodyWeightKg, toast }) {
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [activityId, setActivityId] = useState(null);
  const [search, setSearch] = useState('');
  const [minutes, setMinutes] = useState(45);
  const [effort, setEffort] = useState('moderate');
  const [params, setParams] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDate(localDateKey(new Date()));
    setActivityId(null); setSearch(''); setMinutes(45);
    setEffort('moderate'); setParams({}); setError(null);
  }, [open]);

  // Seed each field from its own placeholder so the estimate is live from
  // the moment an activity is picked, rather than zero until you type.
  const pickActivity = (id) => {
    setActivityId(id);
    const seeded = {};
    activityFields(id).forEach((f) => { if (f.placeholder) seeded[f.key] = f.placeholder; });
    setParams(seeded);
    setSearch('');
  };

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ACTIVITY_GROUPS.map((g) => ({
      ...g,
      items: ACTIVITIES.filter((a) => a.kind === g.key && (!q || a.name.toLowerCase().includes(q))),
    })).filter((g) => g.items.length);
  }, [search]);

  const kcal = useMemo(() => (activityId
    ? estimateKcal({ activityId, minutes, bodyWeightKg, params, effort })
    : 0), [activityId, minutes, bodyWeightKg, params, effort]);

  const today = localDateKey(new Date());
  const canSave = !!activityId && Number(minutes) > 0 && date <= today;

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api('/me/cardio', {
        method: 'POST',
        body: JSON.stringify({
          activity_id: activityId,
          activity_name: activityName(activityId),
          date,
          duration_sec: Math.round(Number(minutes) * 60),
          effort: usesEffortLevel(activityId) ? effort : undefined,
          params,
          kcal: kcal || null,
          source: 'manual_retroactive',
        }),
      });
      toast?.(kcal ? `${activityName(activityId)} logged · ~${kcal} kcal` : `${activityName(activityId)} logged`);
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(e.message || "Couldn't save that session. Try again.");
    }
    setSaving(false);
  };

  const field = { background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)' };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log cardio or a sport"
      sub="A run, a ride, or a game you already played"
      footer={
        <button className="btn-primary btn-block" disabled={!canSave || saving} onClick={save} style={{ minHeight: 48 }}>
          {saving ? 'Saving…' : 'Save session'}
        </button>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>When</span>
          <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)}
            aria-label="Date" className="input mt-1 w-full" style={{ ...field, minHeight: 44 }} />
        </label>

        {!activityId ? (
          <div>
            <div className="t-micro mb-2">What did you do?</div>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search running, cycling, badminton…" aria-label="Search activities"
              className="input w-full" style={{ ...field, minHeight: 44 }} />
            <div className="mt-2 space-y-3">
              {grouped.map((g) => (
                <div key={g.key}>
                  <div className="text-[9.5px] font-semibold uppercase tracking-[.08em] mb-1"
                       style={{ color: 'var(--faint)' }}>{g.label}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {g.items.map((a) => (
                      <button key={a.id} onClick={() => pickActivity(a.id)}
                        className="rounded-lg px-2.5 text-left text-[12px] font-semibold truncate"
                        style={{ ...field, minHeight: 42 }}>
                        {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!grouped.length && (
                <div className="text-[11px] py-3 text-center" style={{ color: 'var(--faint)' }}>
                  Nothing matches “{search.trim()}”.
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="font-grotesk text-[15px] font-bold" style={{ color: 'var(--ink)' }}>
                {activityName(activityId)}
              </div>
              <button className="text-[10.5px] font-semibold tap-target" style={{ color: 'var(--accent)' }}
                      onClick={() => setActivityId(null)}>Change</button>
            </div>

            <div>
              <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>How long</span>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {[15, 30, 45, 60, 90].map((m) => (
                  <button key={m} type="button" onClick={() => setMinutes(m)}
                    className="rounded-full px-3 text-[11.5px] font-semibold"
                    style={{
                      minHeight: 40,
                      background: Number(minutes) === m ? 'var(--cta-solid)' : 'transparent',
                      color: Number(minutes) === m ? 'var(--cta-ink)' : 'var(--mute)',
                      border: `1px solid ${Number(minutes) === m ? 'transparent' : 'var(--line)'}`,
                    }}>{m}m</button>
                ))}
                <input type="number" min="1" max="600" value={minutes} aria-label="Minutes"
                  onChange={(e) => setMinutes(e.target.value)}
                  className="input w-20 text-right tabular-nums" style={{ ...field, minHeight: 40 }} />
              </div>
            </div>

            {activityFields(activityId).length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {activityFields(activityId).map((f) => (
                  <label key={f.key} className="block">
                    <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>
                      {f.label}{f.unit ? ` (${f.unit})` : ''}
                    </span>
                    <input type="number" inputMode="decimal" min={f.min} max={f.max}
                      placeholder={f.placeholder} aria-label={`${f.label}${f.unit ? ` in ${f.unit}` : ''}`}
                      value={params[f.key] ?? ''}
                      onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                      className="input mt-1 w-full text-right tabular-nums" style={{ ...field, minHeight: 44 }} />
                  </label>
                ))}
              </div>
            )}

            {/* Offered only where it means something: for a run, the speed
                IS the effort, and a light/hard picker on top would
                double-count it. */}
            {usesEffortLevel(activityId) && (
              <div>
                <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>How hard</span>
                <div className="flex gap-1.5 mt-1">
                  {EFFORTS.map((e) => (
                    <button key={e.key} type="button" onClick={() => setEffort(e.key)}
                      className="flex-1 rounded-lg px-2 text-[11.5px] font-semibold"
                      style={{
                        minHeight: 42,
                        background: effort === e.key ? 'var(--cta-solid)' : 'transparent',
                        color: effort === e.key ? 'var(--cta-ink)' : 'var(--mute)',
                        border: `1px solid ${effort === e.key ? 'transparent' : 'var(--line)'}`,
                      }}>{e.label}</button>
                  ))}
                </div>
                <div className="text-[10px] mt-1" style={{ color: 'var(--faint)' }}>
                  {EFFORTS.find((e) => e.key === effort)?.hint}
                </div>
              </div>
            )}

            <div className="rounded-xl p-3" style={{ border: '1px solid var(--line)' }}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px]" style={{ color: 'var(--mute)' }}>Estimated burn</span>
                <span className="font-grotesk text-[19px] font-black tabular-nums" style={{ color: 'var(--ink)' }}>
                  {kcal ? `~${kcal}` : '—'}<span className="text-[11px] font-medium ml-1" style={{ color: 'var(--mute)' }}>kcal</span>
                </span>
              </div>
              <div className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--faint)' }}>
                {bodyWeightKg
                  ? 'Estimated from the activity, how long and your body weight — not measured.'
                  : 'Add your weight in your profile and this can be estimated.'}
              </div>
            </div>
          </>
        )}

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
