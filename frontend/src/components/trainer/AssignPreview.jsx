/**
 * ASSIGN PREVIEW — what this client has actually done, before you commit.
 *
 * WHY IT IS HERE AND NOT IN THE EDITOR. Previous performance needs a
 * client, and a template does not have one: it is a blueprint that may
 * be assigned to forty people. The only moment where "last time, Priya
 * pressed 60kg for 8" is both true and useful is the moment a trainer
 * picks Priya. So it lives in the assignment step, and appears only once
 * a client is chosen.
 *
 * WHAT IT REFUSES TO DO. Exercises the client has never logged show
 * nothing -- not a zero, not a dash, not a guessed starting weight. An
 * invented baseline is worse than an absent one, because a trainer can
 * act on it. The suggested next target and its reasoning come from the
 * server's progressive-overload service; this component renders that
 * judgement, it does not compute a second opinion of its own.
 *
 * The prescription is never auto-changed by any of this. The trainer
 * reads it and decides.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { prettyName } from './ExercisePicker.jsx';

export default function AssignPreview({ clientId, exercises }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    // Only exercises linked to the library have a history to look up;
    // a free-typed name cannot be matched to past logs.
    const linked = (exercises || []).filter((x) => x.exercise_id);
    if (!clientId || !linked.length) { setRows([]); return undefined; }

    const mine = ++reqId.current;
    let cancelled = false;
    setLoading(true);

    // In parallel: this is a modal the trainer is waiting in front of,
    // and a template of eight exercises done sequentially would be eight
    // round trips of latency stacked end to end.
    Promise.all(linked.map(async (x) => {
      try {
        const r = await api(`/workouts/clients/${clientId}/overload/${x.exercise_id}`);
        return { key: x.exercise_id, name: x.name, suggestion: r?.suggestion || null };
      } catch {
        // One exercise failing to load must not blank the whole panel.
        return { key: x.exercise_id, name: x.name, suggestion: null };
      }
    })).then((all) => {
      if (cancelled || reqId.current !== mine) return;
      setRows(all.filter((r) => r.suggestion));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [clientId, exercises]);

  if (!clientId) return null;
  if (loading) {
    return (
      <div className="text-[11.5px] py-2" style={{ color: 'var(--mute)' }}>
        Checking this client's history…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div
        className="rounded-xl px-3 py-2.5 text-[11.5px]"
        style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--mute)' }}
      >
        No logged history for these exercises yet — this will be their first time on record.
      </div>
    );
  }

  return (
    <div>
      <div className="t-micro mb-1.5">Last time, for this client</div>
      <div className="space-y-1.5 max-h-[220px] overflow-y-auto pr-0.5">
        {rows.map((r) => {
          const s = r.suggestion;
          const cur = s.current || {};
          return (
            <div
              key={r.key}
              className="rounded-xl px-3 py-2"
              style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
            >
              <div className="flex items-baseline gap-2">
                <div className="text-[12px] font-semibold truncate flex-1" style={{ color: 'var(--ink)' }}>
                  {prettyName(r.name)}
                </div>
                <div className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--ink)' }}>
                  {cur.weight ? `${cur.weight} kg × ${cur.reps}` : `${cur.reps} reps`}
                </div>
              </div>
              <div className="text-[10.5px] mt-1 flex items-center gap-1.5 flex-wrap">
                {/* The direction is stated as a suggestion, with its
                    reason, because a bare arrow would read as an
                    instruction the app is giving the coach. */}
                <span
                  className="rounded px-1.5 py-0.5 font-semibold tabular-nums"
                  style={{
                    background: s.progress ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${s.progress ? 'var(--accent)' : 'var(--line)'}`,
                    color: s.progress ? 'var(--accent)' : 'var(--mute)',
                  }}
                >
                  {s.progress ? `Suggest ${s.suggested.weight} kg × ${s.suggested.reps}` : 'Suggest holding'}
                </span>
                <span style={{ color: 'var(--mute)' }}>{s.rationale}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
