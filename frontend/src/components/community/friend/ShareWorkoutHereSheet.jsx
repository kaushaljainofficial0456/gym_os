/**
 * SHARE A SESSION INTO THIS COMMUNITY.
 *
 * Opened from inside a community, so the destination is already known and the
 * only question left is WHICH session — and whether its personal records go
 * with it. Sessions already shared here are marked and cannot be posted
 * twice.
 *
 * From the workout summary screen the other direction applies: the session is
 * known and the destinations are the question (ShareToCommunitiesSheet).
 */
import { useState, useEffect } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';

export default function ShareWorkoutHereSheet({ communityId, communityName, onClose, onShared, toast }) {
  const [workouts, setWorkouts] = useState(null);
  const [includePrs, setIncludePrs] = useState(true);
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(() => new Set());
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api('/me/workouts')
      .then((res) => {
        if (!alive) return;
        setWorkouts((res.workouts || []).filter((w) => w.status === 'completed'));
      })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load your workouts'); setWorkouts([]); } });
    return () => { alive = false; };
  }, []);

  const share = async (w) => {
    setBusy(w.id); setErr('');
    try {
      const res = await api(`/communities/${communityId}/shares`, {
        method: 'POST',
        body: JSON.stringify({ workout_id: w.id, include_workout: true, include_prs: includePrs }),
      });
      setDone((prev) => new Set(prev).add(w.id));
      const addedRecords = !!res?.prs?.created;
      toast?.(res?.workout?.created === false && !addedRecords
        ? `Already in ${communityName}`
        : `Shared with ${communityName}${addedRecords ? ' with your records' : ''}`);
      onShared?.();
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not share that workout');
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Share a workout" sub={`To ${communityName}`}>
      <button
        type="button"
        onClick={() => setIncludePrs((v) => !v)}
        aria-pressed={includePrs}
        className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left mb-3"
        style={{
          background: includePrs ? 'var(--m-strength-bg)' : 'var(--panel2)',
          border: `1px solid ${includePrs ? 'var(--m-strength)' : 'var(--line)'}`,
        }}
      >
        <span
          className="w-5 h-5 rounded-md grid place-items-center shrink-0"
          style={{
            background: includePrs ? 'var(--m-strength)' : 'transparent',
            border: `2px solid ${includePrs ? 'var(--m-strength)' : 'var(--line)'}`,
          }}
        >
          {includePrs && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--bg)" strokeWidth="3.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
          Include any personal records from the session
        </span>
      </button>

      {workouts === null && <div className="text-[12px] py-4" style={{ color: 'var(--mute)' }}>Loading your workouts…</div>}

      {workouts?.length === 0 && (
        <div className="text-[12.5px] py-6 text-center leading-relaxed" style={{ color: 'var(--mute)' }}>
          You have no completed workouts yet. Finish a session and it will be here to share.
        </div>
      )}

      <div className="space-y-1.5">
        {(workouts || []).map((w) => {
          const shared = done.has(w.id);
          return (
            <div
              key={w.id}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5"
              style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
                  {w.name || 'Workout'}
                </div>
                <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                  {w.scheduled_date}
                  {w.exercise_count > 0 ? ` · ${w.exercise_count} ${w.exercise_count === 1 ? 'exercise' : 'exercises'}` : ''}
                </div>
              </div>
              <button
                type="button"
                disabled={shared || busy === w.id}
                onClick={() => share(w)}
                className="rounded-lg px-3 text-[11.5px] font-semibold shrink-0"
                style={{
                  minHeight: 36,
                  background: shared ? 'transparent' : 'var(--accent)',
                  color: shared ? 'var(--mute)' : 'var(--accent-contrast)',
                  border: shared ? '1px solid var(--line)' : 'none',
                }}
              >
                {shared ? 'Shared' : busy === w.id ? 'Sharing…' : 'Share'}
              </button>
            </div>
          );
        })}
      </div>

      {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}
