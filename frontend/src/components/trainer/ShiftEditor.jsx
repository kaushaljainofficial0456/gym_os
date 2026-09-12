/**
 * SHIFT EDITOR — the half of attendance that had no way in.
 *
 * WHAT WAS UNREACHABLE. The attendance engine has two modes. In
 * "scheduled" mode a trainer has expected hours, which is what makes
 * lateness measurable and what separates ABSENT ("they were due and did
 * not come") from NO_RECORD ("nobody was expecting them"). All of it was
 * built, tested, and exposed over GET/PUT/DELETE /attendance/shifts/:id
 * -- and there was no UI anywhere, so no gym could define a single shift
 * and the entire scheduled mode was dead weight.
 *
 * A WEEK, NOT A FORM. A rota is read as a week: "who is in on Tuesday"
 * and "does Thursday have anyone". So the editor is seven rows you can
 * see at once, not a create-shift dialog that hides the shape of the
 * week behind a list.
 *
 * ON DELETING VS DEACTIVATING. Removing a day means "not expected" --
 * that day stops generating absences. Keeping it but inactive means the
 * same thing operationally, so this offers only removal: two controls
 * that produce identical behaviour is a way to make people wonder which
 * one they picked.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';

const DAYS = [
  [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'],
  [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday'],
];

/** "09:00" -> "9:00 AM". Storage stays 24h; this is display only. */
function pretty(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return hhmm || '';
  let h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

export default function ShiftEditor({ trainerId, trainerName, onClose, onChanged }) {
  const [shifts, setShifts] = useState(null);
  const [busyDay, setBusyDay] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api(`/attendance/shifts/${trainerId}`);
      const by = new Map();
      for (const s of r.shifts || []) by.set(Number(s.day_of_week), s);
      setShifts(by);
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load shifts');
      setShifts(new Map());
    }
  }, [trainerId]);

  useEffect(() => { load(); }, [load]);

  const save = async (dow, startTime, endTime) => {
    // Caught here as well as on the server: the server's message is
    // correct but a round trip to learn you typed the times backwards is
    // a worse experience than being told immediately.
    if (endTime <= startTime) {
      setErr('A shift must end after it starts.');
      return;
    }
    setBusyDay(dow); setErr('');
    try {
      await api(`/attendance/shifts/${trainerId}`, {
        method: 'PUT',
        body: JSON.stringify({ day_of_week: dow, start_time: startTime, end_time: endTime }),
      });
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not save that shift');
    }
    setBusyDay(null);
  };

  const remove = async (dow, label) => {
    const ok = window.confirm(
      `Remove ${trainerName}'s ${label} shift?\n\nThey will no longer be expected on ${label}s, `
      + 'so that day stops counting as absent.');
    if (!ok) return;
    setBusyDay(dow); setErr('');
    try {
      await api(`/attendance/shifts/${trainerId}/${dow}`, { method: 'DELETE' });
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not remove that shift');
    }
    setBusyDay(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,.6)' }}
      onClick={onClose}
      role="dialog" aria-modal="true" aria-label={`Shifts for ${trainerName}`}
    >
      <div className="card p-5 w-full max-w-lg my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <h2 className="font-grotesk font-bold text-[14px]" style={{ color: 'var(--ink)' }}>
              Weekly shifts
            </h2>
            <div className="text-[11.5px]" style={{ color: 'var(--mute)' }}>{trainerName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-lg px-2 shrink-0" style={{ minHeight: 36, color: 'var(--mute)' }}>Close</button>
        </div>

        <p className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>
          Days with a shift are days this trainer is expected in. Only those days can count as
          late or absent — a day with no shift is simply not tracked.
        </p>

        {err && <div className="text-[11.5px] mb-2.5" role="alert" style={{ color: 'var(--bad)' }}>{err}</div>}

        {shifts === null ? (
          <div className="text-[12px] py-6 text-center" style={{ color: 'var(--mute)' }}>Loading shifts…</div>
        ) : (
          <div className="space-y-1.5">
            {DAYS.map(([dow, label]) => (
              <DayRow
                key={dow}
                label={label}
                shift={shifts.get(dow)}
                busy={busyDay === dow}
                onSave={(s, e) => save(dow, s, e)}
                onRemove={() => remove(dow, label)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DayRow({ label, shift, busy, onSave, onRemove }) {
  const has = Boolean(shift);
  const [start, setStart] = useState(shift?.start_time || DEFAULT_START);
  const [end, setEnd] = useState(shift?.end_time || DEFAULT_END);
  const [editing, setEditing] = useState(false);

  // A reload replaces the shift object; local inputs must follow it or an
  // edit saved on one day silently shows stale times on the next render.
  useEffect(() => {
    setStart(shift?.start_time || DEFAULT_START);
    setEnd(shift?.end_time || DEFAULT_END);
    setEditing(false);
  }, [shift?.start_time, shift?.end_time]);

  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{
        background: has ? 'var(--panel)' : 'var(--bg)',
        border: `1px solid ${has ? 'var(--accent)' : 'var(--line)'}`,
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] font-semibold w-[86px] shrink-0"
          style={{ color: has ? 'var(--ink)' : 'var(--mute)' }}>{label}</span>

        {has && !editing ? (
          <span className="text-[12px] tabular-nums flex-1" style={{ color: 'var(--ink)' }}>
            {pretty(shift.start_time)} – {pretty(shift.end_time)}
          </span>
        ) : has || editing ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)}
              aria-label={`${label} start time`}
              className="input text-[12px] tabular-nums" style={{ minHeight: 34, maxWidth: 104 }} />
            <span className="text-[11px]" style={{ color: 'var(--faint)' }}>to</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)}
              aria-label={`${label} end time`}
              className="input text-[12px] tabular-nums" style={{ minHeight: 34, maxWidth: 104 }} />
          </div>
        ) : (
          <span className="text-[11.5px] flex-1" style={{ color: 'var(--faint)' }}>Not expected in</span>
        )}

        <div className="flex items-center gap-1.5 shrink-0">
          {has && !editing && (
            <Btn onClick={() => setEditing(true)} disabled={busy}>Edit</Btn>
          )}
          {(editing || (!has && false)) && (
            <Btn onClick={() => onSave(start, end)} disabled={busy} primary>
              {busy ? '…' : 'Save'}
            </Btn>
          )}
          {!has && !editing && (
            <Btn onClick={() => setEditing(true)} disabled={busy}>+ Add</Btn>
          )}
          {has && (
            <Btn onClick={onRemove} disabled={busy} danger>Remove</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Btn({ children, onClick, disabled, danger, primary }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className="rounded-lg px-2.5 text-[11px] font-semibold"
      style={{
        minHeight: 32,
        border: `1px solid ${primary ? 'var(--accent)' : 'var(--line)'}`,
        background: primary ? 'var(--accent-soft)' : 'transparent',
        color: danger ? 'var(--bad)' : primary ? 'var(--accent)' : 'var(--mute)',
        opacity: disabled ? 0.5 : 1,
      }}
    >{children}</button>
  );
}
