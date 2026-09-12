/**
 * SHARE A SESSION — to the places you pick, and nowhere else.
 *
 * This is the one screen that decides who sees a workout, so it starts with
 * NOTHING selected. There is no "share everywhere", no remembered default
 * that quietly posts to a group you forgot you were in, and no way to share
 * from here without seeing exactly which communities are about to receive it.
 *
 * Records are their own choice. A session and the personal records it set are
 * different things to publish -- plenty of people will happily post the
 * session and keep the numbers to themselves.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';
import { IdentityMark, TypeChip } from '../identity.jsx';

export default function ShareToCommunitiesSheet({ workoutId, onClose, onShared, toast }) {
  const [targets, setTargets] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [includePrs, setIncludePrs] = useState(false);
  const [gymAudience, setGymAudience] = useState('everyone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setTargets(await api(`/communities/share-targets?workout_id=${encodeURIComponent(workoutId)}`));
    } catch (e) {
      setErr(e.message || 'Could not load your communities');
      setTargets({ gym: { available: false }, communities: [], prCount: 0 });
    }
  }, [workoutId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (key) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const share = async () => {
    setBusy(true); setErr('');
    const jobs = [];
    if (picked.has('gym')) {
      jobs.push({
        label: targets.gym.name,
        run: () => api('/community/shares', {
          method: 'POST',
          body: JSON.stringify({ workout_id: workoutId, visibility: gymAudience }),
        }),
      });
    }
    for (const c of targets.communities) {
      if (!picked.has(c.id)) continue;
      jobs.push({
        label: c.name,
        run: () => api(`/communities/${c.id}/shares`, {
          method: 'POST',
          body: JSON.stringify({ workout_id: workoutId, include_workout: true, include_prs: includePrs }),
        }),
      });
    }

    const results = await Promise.allSettled(jobs.map((j) => j.run()));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? jobs[i].label : null))
      .filter(Boolean);
    setBusy(false);

    if (failed.length === jobs.length) {
      setErr(`Could not share to ${failed.join(', ')}`);
      return;
    }
    const shared = jobs.length - failed.length;
    toast?.(failed.length
      ? `Shared to ${shared} of ${jobs.length}. ${failed.join(', ')} failed.`
      : `Shared to ${jobs.map((j) => j.label).filter((l) => !failed.includes(l)).join(', ')}`);
    onShared?.();
    onClose();
  };

  const destinations = targets
    ? [
      ...(targets.gym?.available && targets.gym.joined
        ? [{ key: 'gym', name: targets.gym.name, type: 'gym', shared: targets.gym.shared }]
        : []),
      ...targets.communities.map((c) => ({
        key: c.id, name: c.name, type: 'friend', theme: c.theme, mark: c.mark,
        shared: c.sharedWorkout, sharedPrs: c.sharedPrs,
      })),
    ]
    : [];
  const available = destinations.filter((d) => !d.shared);

  return (
    <Modal
      open
      onClose={onClose}
      title="Share this workout"
      sub={targets?.workout?.name}
      footer={available.length > 0 ? (
        <button
          type="button"
          onClick={share}
          disabled={busy || picked.size === 0}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{
            minHeight: 46,
            background: picked.size ? 'var(--accent)' : 'var(--line)',
            color: picked.size ? 'var(--accent-contrast)' : 'var(--mute)',
          }}
        >
          {busy ? 'Sharing…' : picked.size ? `Share to ${picked.size} ${picked.size === 1 ? 'place' : 'places'}` : 'Pick where to share'}
        </button>
      ) : null}
    >
      {targets === null && <div className="text-[12px] py-4" style={{ color: 'var(--mute)' }}>Loading…</div>}

      {targets && destinations.length === 0 && (
        <div className="text-[12.5px] py-4 leading-relaxed text-center" style={{ color: 'var(--mute)' }}>
          You are not in a community yet. Create one, or join your gym community, and this session
          will have somewhere to go.
        </div>
      )}

      {destinations.length > 0 && (
        <div className="space-y-1.5">
          {destinations.map((d) => {
            const on = picked.has(d.key);
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => !d.shared && toggle(d.key)}
                disabled={d.shared}
                aria-pressed={on}
                className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-transform active:scale-[.99]"
                style={{
                  minHeight: 60,
                  background: on ? 'var(--accent-soft)' : 'var(--panel2)',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  opacity: d.shared ? 0.6 : 1,
                }}
              >
                <span
                  className="w-5 h-5 rounded-md grid place-items-center shrink-0"
                  style={{
                    background: on ? 'var(--accent)' : 'transparent',
                    border: `2px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  }}
                >
                  {on && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)"
                      strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <IdentityMark name={d.name} theme={d.type === 'gym' ? 'gym' : d.theme} mark={d.mark} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{d.name}</span>
                  {d.shared && <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>Already shared</span>}
                </span>
                <TypeChip type={d.type} theme={d.theme} />
              </button>
            );
          })}
        </div>
      )}

      {/* Records: a separate decision from the session itself. */}
      {targets?.prCount > 0 && picked.size > 0 && (
        <button
          type="button"
          onClick={() => setIncludePrs((v) => !v)}
          aria-pressed={includePrs}
          className="w-full mt-3 flex items-center gap-3 rounded-xl px-3 py-3 text-left"
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
          <span className="min-w-0">
            <span className="block text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
              Include {targets.prCount === 1 ? 'the personal record' : `all ${targets.prCount} personal records`} from this session
            </span>
            <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
              Posted as its own card, with what each record beat.
            </span>
          </span>
        </button>
      )}

      {/* The gym's audience control, exactly as the gym community defines it. */}
      {picked.has('gym') && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[.13em] mb-1.5" style={{ color: 'var(--faint)' }}>
            In {targets.gym.name}, show it to
          </div>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Gym audience">
            {[['everyone', 'Everyone in the gym'], ['followers', 'Only my followers']].map(([key, label]) => {
              const on = gymAudience === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setGymAudience(key)}
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
      )}

      <p className="text-[10.5px] mt-3 leading-relaxed" style={{ color: 'var(--faint)' }}>
        Nothing is shared anywhere until you pick it here.
      </p>

      {err && <div className="text-[12px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}
