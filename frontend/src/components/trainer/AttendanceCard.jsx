/**
 * TRAINER ATTENDANCE CARD — the trainer's own check-in/out, on their home
 * screen.
 *
 * It lives here rather than behind a Settings tab because it is the first
 * thing a trainer does on arriving and the last before leaving. An
 * attendance control that takes three taps to reach is one people stop
 * using, and an attendance system nobody uses produces worse data than no
 * system at all.
 *
 * The card states the CURRENT state in one line, and offers exactly one
 * action: check in, or check out, never both. The running timer is
 * cosmetic -- the worked total is computed server-side from the two
 * instants, never from this clock.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api.js';
import QrScanner from '../QrScanner.jsx';
import { useAuth } from '../../auth.jsx';

const pad = (n) => String(n).padStart(2, '0');

/** "8h 06m" — the unit people actually use for a shift. */
export function formatDuration(minutes) {
  if (minutes == null) return null;
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Local clock time for an instant, e.g. "7:02 AM". */
export function clockTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const STATUS_TONE = {
  PRESENT: { fg: 'var(--good)', bg: 'rgb(var(--good-rgb) / .10)', label: 'Present' },
  LATE: { fg: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .10)', label: 'Late' },
  ABSENT: { fg: 'var(--bad)', bg: 'rgb(var(--bad-rgb) / .10)', label: 'Absent' },
  LEAVE: { fg: 'var(--accent)', bg: 'var(--accent-soft)', label: 'Leave' },
  OFF_DAY: { fg: 'var(--mute)', bg: 'transparent', label: 'Day off' },
  MISSING_CHECKOUT: { fg: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .10)', label: 'No check-out' },
};

export default function AttendanceCard({ onChanged }) {
  /* Owners see this card because an owner who also coaches has their own
     hours to record -- but recording them is TRAINER-only on the server.
     An owner who does not coach was therefore shown a check-in button
     that could only ever fail with "Only trainers record attendance".
     They still get the card (it is how they see their own day if they do
     coach); they just do not get an action they are not allowed to take. */
  const { user } = useAuth();
  const canRecord = user?.role === 'TRAINER';
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  // Which action the scanner is currently collecting a code for.
  const [scanFor, setScanFor] = useState(null);   // 'check-in' | 'check-out' | null

  const load = useCallback(async () => {
    try {
      setState(await api('/attendance/me/today'));
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load your attendance');
      setState({ attendance: null, scheduled: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Drives the "working for" readout only. One minute is plenty; a
  // per-second timer on a screen that sits open all day is wasted work.
  useEffect(() => {
    const open = state?.attendance?.checkIn && !state?.attendance?.checkOut;
    if (!open) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [state?.attendance?.checkIn, state?.attendance?.checkOut]);

  const act = async (path, qr) => {
    setBusy(true); setErr('');
    try {
      await api(`/attendance/me/${path}`, { method: 'POST', body: JSON.stringify(qr ? { qr } : {}) });
      setScanFor(null);
      await load();
      onChanged?.();
    } catch (e) {
      // Never claim a check-in that the server refused: a trainer who
      // believes they are checked in will not try again, and the day is
      // lost.
      setErr(e.message || `Could not record your ${path.replace('-', ' ')}`);
    }
    setBusy(false);
  };

  if (!state) {
    return (
      <div className="card p-4">
        <div className="text-[12px]" style={{ color: 'var(--mute)' }}>Loading attendance…</div>
      </div>
    );
  }

  const a = state.attendance;
  /* Default to REQUIRED when the server does not say. The failure modes
     are not symmetrical: wrongly showing a scanner costs one confused
     tap, wrongly allowing a tap-only check-in silently produces
     attendance records nobody can stand behind. */
  const requireQr = state.policy?.requireQr !== false;
  const sched = state.scheduled;
  const checkedIn = !!a?.checkIn && !a?.checkOut;
  const done = !!a?.checkOut;
  const tone = a ? (STATUS_TONE[a.status] || STATUS_TONE.PRESENT) : null;

  const workingMinutes = checkedIn && a.checkIn
    ? Math.max(0, Math.round((Date.now() - new Date(a.checkIn).getTime()) / 60000))
    : null;

  return (
    <div className="card p-4" data-tour="trainer-attendance" key={tick}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="t-micro mb-1">Today</div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-grotesk font-bold" style={{ fontSize: 17, color: 'var(--ink)' }}>
              {done ? tone.label : checkedIn ? 'Checked in' : a ? tone.label : 'Not checked in'}
            </span>
            {a && (
              <span
                className="text-[9.5px] uppercase tracking-[.12em] font-bold px-2 py-0.5 rounded-full"
                style={{ background: tone.bg, color: tone.fg }}
              >
                {tone.label}
              </span>
            )}
          </div>

          <div className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
            {/* Only claims a schedule when one exists. A gym running no
                shifts should not be told it has one. */}
            {sched
              ? `Scheduled ${sched.start} – ${sched.end}`
              : 'No shift scheduled — your hours are recorded as you work them.'}
          </div>

          {a?.checkIn && (
            <div className="text-[12px] mt-1.5 tabular-nums" style={{ color: 'var(--ink)' }}>
              {clockTime(a.checkIn)}
              {a.checkOut ? ` – ${clockTime(a.checkOut)}` : ''}
              {a.workedMinutes != null && (
                <span style={{ color: 'var(--mute)' }}> · {formatDuration(a.workedMinutes)}</span>
              )}
              {workingMinutes != null && (
                <span style={{ color: 'var(--mute)' }}> · working {formatDuration(workingMinutes)}</span>
              )}
            </div>
          )}

          {a?.status === 'LATE' && a.lateMinutes > 0 && (
            <div className="text-[11px] mt-1" style={{ color: 'var(--warn)' }}>
              {a.lateMinutes} min after your scheduled start
            </div>
          )}
          {a?.correctionStatus === 'PENDING' && (
            <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>
              Correction requested — waiting for your gym to review it.
            </div>
          )}
        </div>
      </div>

      {err && (
        <div className="text-[11.5px] mt-2.5" role="alert" style={{ color: 'var(--bad)' }}>{err}</div>
      )}

      {/* One action, never two. `disabled` during the request is what
          stops a double tap becoming two writes.

          WHEN THE GYM REQUIRES A CODE THIS OPENS THE SCANNER instead of
          posting. Tapping alone used to record attendance from anywhere,
          which made the code on the wall decorative. The server enforces
          this too -- hiding the button is presentation, not a rule. */}
      {!done && canRecord && (
        <button
          type="button"
          onClick={() => {
            const path = checkedIn ? 'check-out' : 'check-in';
            if (requireQr) setScanFor(path); else act(path);
          }}
          disabled={busy}
          className="w-full mt-3.5 rounded-xl font-grotesk font-bold text-[13px] transition-all active:scale-[.98]"
          style={{
            minHeight: 48,
            background: checkedIn ? 'transparent' : 'var(--cta-solid)',
            border: `1px solid ${checkedIn ? 'var(--line)' : 'var(--cta-edge)'}`,
            color: checkedIn ? 'var(--ink)' : 'var(--cta-ink)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Saving…' : requireQr
            ? (checkedIn ? 'Scan to check out' : 'Scan to check in')
            : (checkedIn ? 'Check out' : 'Check in')}
        </button>
      )}

      {!done && !canRecord && (
        <div className="mt-3 pt-3 text-[11.5px]" style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
          Attendance is recorded by trainers. You are seeing this gym's own view.
        </div>
      )}

      <QrScanner
        open={!!scanFor}
        onClose={() => setScanFor(null)}
        onScanned={(token) => act(scanFor, token)}
        title={scanFor === 'check-out' ? 'Scan the check-out code' : 'Scan the check-in code'}
        hint={scanFor === 'check-out'
          ? 'Scan the "Leaving" code on the gym display to record when you left.'
          : 'Scan the "Arriving" code on the gym display to start your day.'}
        placeholder="Paste the code from the gym display"
        actionLabel={scanFor === 'check-out' ? 'Check out' : 'Check in'}
      />

      {done && (
        <div className="mt-3 pt-3 text-[11.5px]" style={{ borderTop: '1px solid var(--line)', color: 'var(--mute)' }}>
          Your day is recorded. {formatDuration(a.workedMinutes) || ''}
        </div>
      )}
    </div>
  );
}

export { STATUS_TONE };
