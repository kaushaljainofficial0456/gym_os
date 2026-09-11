/**
 * SHARE A WORKOUT — pick one of your own completed sessions to publish to
 * the gym community.
 *
 * Sharing is the ONLY way a workout reaches the community feed. Nothing
 * is published automatically, which is why this is an explicit picker
 * rather than a toggle buried in settings: a member should always know
 * the moment something of theirs became visible to other people.
 *
 * The list is the member's own completed workouts, newest first. Sessions
 * already shared are marked and cannot be shared twice.
 */
import { useState, useEffect } from 'react';
import { api } from '../../api.js';

export default function ShareWorkoutSheet({ onClose, onShared, alreadyShared, toast }) {
  const [workouts, setWorkouts] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  // Audience is chosen per share, not inherited from a profile
  // setting: 'I'll post this one to everyone but keep the rest to my
  // followers' is a normal thing to want, and the stored value is what
  // the feed reads later.
  const [audience, setAudience] = useState('everyone');

  useEffect(() => {
    let alive = true;
    api('/me/workouts')
      .then((res) => {
        if (!alive) return;
        const done = (res.workouts || []).filter((w) => w.status === 'completed');
        setWorkouts(done);
      })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load your workouts'); setWorkouts([]); } });
    return () => { alive = false; };
  }, []);

  const share = async (w) => {
    setBusy(w.id); setErr('');
    try {
      await api('/community/shares', {
        method: 'POST',
        body: JSON.stringify({ workout_id: w.id, visibility: audience }),
      });
      toast?.('Shared with your gym');
      onShared?.();
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not share that workout');
    }
    setBusy(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Share a workout"
    >
      <div
        className="w-full max-w-lg rounded-t-3xl p-4 max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>Share a workout</h2>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-lg px-3" style={{ minHeight: 40, color: 'var(--mute)' }}>
            Close
          </button>
        </div>
        <p className="text-[11.5px] mb-3" style={{ color: 'var(--mute)' }}>
          Only the session you pick becomes visible. You can remove it later.
        </p>

        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-[.13em] font-semibold mb-1.5" style={{ color: 'var(--faint)' }}>
            Who can see it
          </div>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Who can see this workout">
            {[
              ['everyone', 'Everyone in the gym'],
              ['followers', 'Only my followers'],
            ].map(([key, label]) => {
              const on = audience === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setAudience(key)}
                  className="flex-1 rounded-xl text-[11.5px] font-semibold px-2"
                  style={{
                    minHeight: 42,
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                    color: on ? 'var(--accent)' : 'var(--mute)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {workouts === null && (
          <div className="text-[12px] py-4" style={{ color: 'var(--mute)' }}>Loading your workouts…</div>
        )}

        {workouts?.length === 0 && (
          <div className="text-[12.5px] py-6 text-center" style={{ color: 'var(--mute)' }}>
            You have no completed workouts to share yet.
          </div>
        )}

        <div className="space-y-1.5">
          {(workouts || []).map((w) => {
            const done = alreadyShared.has(w.id);
            return (
              <div
                key={w.id}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
                    {w.name || 'Workout'}
                  </div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                    {w.scheduled_date}
                    {w.exercise_count > 0
                      ? ` · ${w.exercise_count} ${w.exercise_count === 1 ? 'exercise' : 'exercises'}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={done || busy === w.id}
                  onClick={() => share(w)}
                  className="rounded-lg px-3 text-[11.5px] font-semibold shrink-0"
                  style={{
                    minHeight: 36,
                    background: done ? 'transparent' : 'var(--accent)',
                    color: done ? 'var(--mute)' : 'var(--accent-contrast)',
                    border: done ? '1px solid var(--line)' : 'none',
                  }}
                >
                  {done ? 'Shared' : busy === w.id ? 'Sharing…' : 'Share'}
                </button>
              </div>
            );
          })}
        </div>

        {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </div>
  );
}
