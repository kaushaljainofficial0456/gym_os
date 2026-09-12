/**
 * CHALLENGES — set one, and see where everyone actually is.
 *
 * A challenge can only be created for something the product can COUNT from
 * rows that already exist: sessions, days trained, kilograms lifted, records
 * set. There is no free-text goal, because a goal nobody can measure turns
 * into a number somebody has to make up.
 *
 * Progress is never stored. Every figure in the detail sheet is recomputed
 * from the same workouts and records the boards read, which is why deleting a
 * session moves the number back down.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';
import { Avatar } from '../../UI.jsx';
import { challengeHue, challengeUnit, fmt, fmtVolume } from '../CommunityPieces.jsx';

const METRICS = [
  { key: 'workouts', label: 'Workouts', hint: 'Completed sessions', goals: [10, 20, 40] },
  { key: 'active_days', label: 'Active days', hint: 'Days with a session', goals: [3, 4, 5] },
  { key: 'volume', label: 'Volume', hint: 'Kilograms lifted', goals: [10000, 25000, 50000] },
  { key: 'prs', label: 'Records', hint: 'Personal records set', goals: [3, 5, 10] },
];

const DURATIONS = [
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
];

const addDays = (key, days) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function CreateChallengeSheet({ communityId, today, onClose, onCreated, toast }) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState('workouts');
  const [scope, setScope] = useState('community');
  const [goal, setGoal] = useState(20);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const chosen = METRICS.find((m) => m.key === metric);
  const hue = challengeHue(metric);
  const unit = challengeUnit(metric);

  const pickMetric = (key) => {
    setMetric(key);
    const next = METRICS.find((m) => m.key === key);
    setGoal(next.goals[scope === 'community' ? 1 : 0]);
  };

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api(`/communities/${communityId}/challenges`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          metric,
          scope,
          goal: Number(goal),
          // The server's own "today" travels with the challenge list, so a
          // phone in a different timezone cannot pick a start date the
          // server will reject as being in the past.
          start_date: today,
          end_date: addDays(today, days - 1),
        }),
      });
      toast?.('Challenge created');
      onCreated?.(res.id);
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not create that challenge');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New challenge"
      sub={`Ends ${new Date(`${addDays(today, days - 1)}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
      footer={(
        <button
          type="button"
          onClick={create}
          disabled={busy || name.trim().length < 2 || !(Number(goal) > 0)}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{
            minHeight: 46,
            background: name.trim().length >= 2 ? hue.fg : 'var(--line)',
            color: name.trim().length >= 2 ? 'var(--accent-contrast)' : 'var(--mute)',
          }}
        >
          {busy ? 'Creating…' : 'Create challenge'}
        </button>
      )}
    >
      <Label>What is it called?</Label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 60))}
        placeholder="Twenty sessions together"
        aria-label="Challenge name"
        autoFocus
        className="w-full rounded-xl px-3 text-[13px] mb-4"
        style={{ minHeight: 46, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
      />

      <Label>What does it count?</Label>
      <div className="grid grid-cols-2 gap-1.5 mb-4">
        {METRICS.map((m) => {
          const on = m.key === metric;
          const mh = challengeHue(m.key);
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => pickMetric(m.key)}
              aria-pressed={on}
              className="rounded-xl px-3 py-2.5 text-left"
              style={{
                background: on ? mh.bg : 'var(--panel2)',
                border: `1px solid ${on ? mh.fg : 'var(--line)'}`,
              }}
            >
              <span className="block text-[12.5px] font-semibold" style={{ color: on ? mh.fg : 'var(--ink)' }}>{m.label}</span>
              <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--mute)' }}>{m.hint}</span>
            </button>
          );
        })}
      </div>

      <Label>Who chases it?</Label>
      <div className="flex gap-1.5 mb-4" role="radiogroup" aria-label="Challenge scope">
        {[['community', 'Everyone together'], ['member', 'Each member']].map(([key, label]) => {
          const on = scope === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setScope(key)}
              className="flex-1 rounded-xl text-[11.5px] font-semibold px-2"
              style={{
                minHeight: 44,
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

      <Label>Target</Label>
      <div className="flex gap-1.5 mb-2 flex-wrap">
        {chosen.goals.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGoal(g)}
            className="rounded-lg px-3 text-[11.5px] font-semibold tabular-nums"
            style={{
              minHeight: 38,
              background: Number(goal) === g ? hue.bg : 'transparent',
              border: `1px solid ${Number(goal) === g ? hue.fg : 'var(--line)'}`,
              color: Number(goal) === g ? hue.fg : 'var(--mute)',
            }}
          >
            {metric === 'volume' ? `${fmtVolume(g)} kg` : `${fmt(g)} ${unit}`}
          </button>
        ))}
      </div>
      <input
        value={goal}
        onChange={(e) => setGoal(e.target.value.replace(/[^\d.]/g, ''))}
        inputMode="numeric"
        aria-label="Challenge target"
        className="w-full rounded-xl px-3 text-[13px] tabular-nums mb-4"
        style={{ minHeight: 44, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
      />

      <Label>How long?</Label>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Challenge length">
        {DURATIONS.map((d) => {
          const on = days === d.days;
          return (
            <button
              key={d.days}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setDays(d.days)}
              className="flex-1 rounded-xl text-[11.5px] font-semibold"
              style={{
                minHeight: 42,
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
              }}
            >
              {d.label}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] mt-4 leading-relaxed" style={{ color: 'var(--faint)' }}>
        Progress is counted from sessions members log, for everyone who shares their stats with this
        community. Nothing is counted twice and nothing is estimated.
      </p>

      {err && <div className="text-[12px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}

export function ChallengeDetailSheet({ communityId, challengeId, canManage, onClose, onChanged, toast }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/communities/${communityId}/challenges/${challengeId}`));
    } catch (e) {
      setErr(e.message || 'Could not load that challenge');
    }
  }, [communityId, challengeId]);

  useEffect(() => { load(); }, [load]);

  const remove = async () => {
    try {
      await api(`/communities/${communityId}/challenges/${challengeId}`, { method: 'DELETE' });
      toast?.('Challenge removed');
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not remove that challenge');
    }
  };

  const c = data?.challenge;
  const hue = c ? challengeHue(c.metric) : null;
  const unit = c ? challengeUnit(c.metric) : '';
  const value = (v) => (c?.metric === 'volume' ? `${fmtVolume(v)} kg` : `${fmt(v)} ${unit}`);
  const daysLeft = c ? Math.max(0, Math.round((Date.parse(`${c.endDate}T23:59:59Z`) - Date.now()) / 86400000)) : 0;

  return (
    <Modal open onClose={onClose} title={c?.name || 'Challenge'} sub={c ? (c.scope === 'community' ? 'Everyone together' : 'Each member') : undefined}>
      {!data && !err && <div className="text-[12px] py-6 text-center" style={{ color: 'var(--mute)' }}>Loading…</div>}

      {c && (
        <>
          <div className="rounded-2xl p-4" style={{ background: hue.bg, border: `1px solid ${hue.fg}` }}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-black tabular-nums leading-none" style={{ fontSize: 26, color: hue.fg }}>
                {value(c.scope === 'community' ? c.value : c.yourValue)}
              </span>
              <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--mute)' }}>of {value(c.goal)}</span>
            </div>
            <div className="mt-2.5 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg)' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${c.scope === 'community' ? c.percent : c.yourPercent}%`,
                  background: hue.fg,
                  transition: 'width .6s cubic-bezier(.22,.8,.3,1)',
                }}
              />
            </div>
            <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: 'var(--mute)' }}>
              <span>
                {c.status === 'ended' ? 'Finished'
                  : daysLeft === 0 ? 'Ends today'
                    : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to go`}
              </span>
              {c.membersParticipating > 0 && (
                <span className="tabular-nums">{fmt(c.membersCompleted)} of {fmt(c.membersParticipating)} finished</span>
              )}
            </div>
          </div>

          {c.description && (
            <p className="text-[12.5px] mt-3 leading-relaxed" style={{ color: 'var(--mute)' }}>{c.description}</p>
          )}

          <div className="mt-4">
            <h3 className="text-[11px] font-bold uppercase tracking-[.14em] mb-2" style={{ color: 'var(--mute)' }}>
              Where everyone is
            </h3>
            {data.standings.length === 0 ? (
              <div className="text-[12px] py-3" style={{ color: 'var(--mute)' }}>
                Nobody has logged anything towards this yet.
              </div>
            ) : (
              <ol className="space-y-1">
                {data.standings.map((s) => <Standing key={s.clientId} entry={s} hue={hue} value={value} />)}
                {data.you && (
                  <>
                    <li className="text-center text-[10px] py-1" style={{ color: 'var(--faint)' }}>···</li>
                    <Standing entry={data.you} hue={hue} value={value} you />
                  </>
                )}
              </ol>
            )}
          </div>

          {canManage && (
            confirm ? (
              <div className="mt-4 rounded-xl p-3" style={{ background: 'var(--panel2)', border: '1px solid rgb(var(--bad-rgb) / .4)' }}>
                <div className="text-[12.5px]" style={{ color: 'var(--ink)' }}>Remove this challenge?</div>
                <p className="text-[11.5px] mt-1" style={{ color: 'var(--mute)' }}>
                  Everyone&apos;s workouts stay exactly as they are — only the challenge goes.
                </p>
                <div className="grid grid-cols-2 gap-2 mt-2.5">
                  <button type="button" onClick={() => setConfirm(false)} className="rounded-xl text-[12.5px] font-semibold"
                    style={{ minHeight: 42, border: '1px solid var(--line)', color: 'var(--mute)' }}>Cancel</button>
                  <button type="button" onClick={remove} className="rounded-xl text-[12.5px] font-semibold"
                    style={{ minHeight: 42, background: 'rgb(var(--bad-rgb))', color: '#fff' }}>Remove</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirm(true)}
                className="w-full mt-4 rounded-xl text-[12.5px] font-semibold"
                style={{ minHeight: 44, border: '1px solid var(--line)', color: 'rgb(var(--bad-rgb))' }}
              >
                Remove challenge
              </button>
            )
          )}
        </>
      )}

      {err && <div className="text-[12px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}

function Standing({ entry, hue, value, you }) {
  return (
    <li>
      <div
        className="flex items-center gap-2.5 rounded-xl px-2.5"
        style={{
          minHeight: 46,
          background: you ? hue.bg : 'transparent',
          border: `1px solid ${you ? hue.fg : 'transparent'}`,
        }}
      >
        <span className="tabular-nums text-[11.5px] font-semibold w-6 shrink-0" style={{ color: 'var(--faint)' }}>
          {entry.rank}
        </span>
        <Avatar name={entry.name} size={28} />
        <span className="flex-1 min-w-0 truncate text-[12.5px]" style={{ color: 'var(--ink)' }}>{entry.name}</span>
        {entry.complete && (
          <span className="text-[9px] font-bold uppercase tracking-[.12em] px-2 py-0.5 rounded-full shrink-0"
            style={{ background: hue.bg, color: hue.fg }}>
            Done
          </span>
        )}
        <span className="tabular-nums text-[12px] font-bold shrink-0" style={{ color: hue.fg }}>{value(entry.value)}</span>
      </div>
    </li>
  );
}

function Label({ children }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-[.13em] mb-1.5" style={{ color: 'var(--mute)' }}>
      {children}
    </div>
  );
}
