/**
 * MY ATTENDANCE — a trainer's own hours.
 *
 * THE WHOLE BACK END FOR THIS ALREADY EXISTED and no screen reached it.
 * Check-in, check-out, shift schedules, late classification, missing
 * check-outs, a correction-request workflow with owner approval, and a
 * full audit trail — all built, all tested, all reachable only by an
 * owner, because /app/trainer/attendance was gated OwnerOnly and the
 * trainer's single point of contact with any of it was a check-in button
 * on the dashboard.
 *
 * So a trainer could record hours and then never see them. Not last
 * week's total, not whether Tuesday got marked late, and — the one that
 * actually costs someone money — no way to say "I was here at 6, the app
 * missed it" without finding the owner in person.
 *
 * WHAT A TRAINER CAN AND CANNOT DO IS THE POINT. They can see everything
 * of their own and ASK for a change; they cannot edit a record. A
 * self-service edit of your own hours is not attendance, it is a form.
 * Every correction goes to the owner as a request, exactly as the server
 * already enforces — this screen just stops that enforcement from being
 * invisible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import AttendanceCard, { formatDuration, clockTime, STATUS_TONE } from '../../components/trainer/AttendanceCard.jsx';
import { Card, Kicker, Sheet } from '../../components/UI.jsx';

const RANGES = [
  { key: 7, label: 'This week' },
  { key: 30, label: '30 days' },
  { key: 90, label: '90 days' },
];

const iso = (d) => d.toISOString().slice(0, 10);
const backDays = (n) => iso(new Date(Date.now() - n * 86400000));

function dayLabel(key) {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Minutes as "7h 20m". Hours alone lose the half-shifts; minutes alone
 *  are unreadable past a day. */
function hours(mins) {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function Stat({ label, value, sub }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-bold uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>{label}</div>
      <div className="mt-1 font-grotesk text-[20px] font-black leading-none tabular-nums" style={{ color: 'var(--ink)' }}>
        {value}
      </div>
      {sub && <div className="text-[9.5px] mt-1" style={{ color: 'var(--faint)' }}>{sub}</div>}
    </div>
  );
}

export default function MyAttendance() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');

  // The day a correction is being requested for, or null.
  const [fixing, setFixing] = useState(null);
  const [form, setForm] = useState({ check_in: '', check_out: '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api(`/attendance/me/history?start=${backDays(days - 1)}&end=${iso(new Date())}`));
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load your attendance');
    }
    setLoading(false);
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!toast) return undefined; const h = setTimeout(() => setToast(''), 2600); return () => clearTimeout(h); }, [toast]);

  const summary = data?.summary;
  const rows = useMemo(() => data?.days || [], [data]);

  /** 24-hour HH:MM, which is the ONLY thing <input type="time"> accepts.
   *  Pre-filling with a localized clock string ("7:30 PM") looks right in
   *  code and fails silently: the browser refuses the value and renders an
   *  empty field, while React state still holds the bad string and happily
   *  submits it. */
  const timeValue = (isoStr) => {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const openFix = (d) => {
    setFixing(d);
    setForm({
      check_in: timeValue(d.checkIn),
      check_out: timeValue(d.checkOut),
      reason: '',
    });
    setFormErr('');
  };

  const submitFix = async () => {
    if (!form.reason.trim()) { setFormErr('Say what happened — the owner sees this, not the app.'); return; }
    setSaving(true); setFormErr('');
    try {
      await api('/attendance/me/corrections', {
        method: 'POST',
        body: JSON.stringify({
          date: fixing.date,
          check_in: form.check_in || undefined,
          check_out: form.check_out || undefined,
          reason: form.reason.trim(),
        }),
      });
      setFixing(null);
      setToast('Correction sent to your gym owner');
      await load();
    } catch (e) {
      setFormErr(e.message || "Couldn't send that request. Try again.");
    }
    setSaving(false);
  };

  return (
    <div className="space-y-5 anim-fadeUp">
      <div>
        <h1 className="font-grotesk text-[22px] font-black tracking-[-.02em]" style={{ color: 'var(--ink)' }}>
          My attendance
        </h1>
        <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
          Your own hours. Corrections go to your gym owner for approval.
        </p>
      </div>

      {/* Today's check-in/out lives at the top, because that is the action;
          everything below it is the record. */}
      <AttendanceCard onChanged={load} />

      <div className="flex gap-1.5">
        {RANGES.map((r) => {
          const on = days === r.key;
          return (
            <button key={r.key} onClick={() => setDays(r.key)} aria-pressed={on}
              className="rounded-full px-3 text-[11.5px] font-semibold transition-colors"
              style={{
                minHeight: 36,
                background: on ? 'var(--cta-solid)' : 'transparent',
                color: on ? 'var(--cta-ink)' : 'var(--mute)',
                border: `1px solid ${on ? 'var(--cta-edge)' : 'var(--line)'}`,
              }}>{r.label}</button>
          );
        })}
      </div>

      {loading && (
        <Card className="p-5"><div className="skeleton h-4 w-1/3" /><div className="skeleton h-3 w-2/3 mt-3" /><div className="skeleton h-3 w-1/2 mt-2" /></Card>
      )}

      {!loading && err && (
        <Card className="p-5">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>Couldn&apos;t load your attendance</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>{err}</div>
          <button onClick={load} className="mt-3 rounded-full px-4 text-[11.5px] font-semibold"
                  style={{ minHeight: 40, border: '1px solid var(--line)', color: 'var(--ink)' }}>Try again</button>
        </Card>
      )}

      {!loading && !err && summary && (
        <Card className="p-4">
          <Kicker>Summary</Kicker>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
            <Stat label="Days recorded" value={summary.recorded} sub={`${summary.present} present`} />
            <Stat label="Total hours" value={hours(summary.totalMinutes)} />
            {/* An "average" off one day is not an average -- the server
                returns null until there are two, and this says so rather
                than printing a single day's figure as a typical one. */}
            <Stat label="Average day" value={summary.averageMinutes == null ? '—' : hours(summary.averageMinutes)}
                  sub={summary.averageMinutes == null ? 'needs 2+ days' : undefined} />
            <Stat label="Late" value={summary.late} sub={summary.missingCheckout ? `${summary.missingCheckout} no check-out` : undefined} />
          </div>
        </Card>
      )}

      {!loading && !err && (
        <Card className="!p-0 overflow-hidden">
          <div className="px-4 pt-4 pb-2"><Kicker>Your days</Kicker></div>

          {!rows.length ? (
            <div className="px-4 pb-6 pt-2 text-center">
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>Nothing recorded in this range</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>
                Your days appear here once you check in.
              </div>
            </div>
          ) : (
            <div style={{ borderTop: '1px solid var(--line)' }}>
              {rows.map((d) => {
                const tone = STATUS_TONE[d.status] || { fg: 'var(--mute)', bg: 'transparent', label: d.status };
                const pending = d.correctionStatus === 'PENDING';
                return (
                  <div key={d.id || d.date} className="px-4 py-3 flex items-center gap-3 flex-wrap"
                       style={{ borderBottom: '1px solid var(--line)' }}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>{dayLabel(d.date)}</span>
                        {/* The status word, not just a colour. */}
                        <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[.06em]"
                              style={{ background: tone.bg, color: tone.fg }}>{tone.label}</span>
                        {pending && (
                          <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[.06em]"
                                style={{ background: 'rgb(var(--warn-rgb) / .12)', color: 'var(--warn)' }}>
                            Correction pending
                          </span>
                        )}
                        {d.correctionStatus === 'REJECTED' && (
                          <span className="rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[.06em]"
                                style={{ background: 'rgb(var(--bad-rgb) / .12)', color: 'var(--bad)' }}>
                            Correction declined
                          </span>
                        )}
                      </div>
                      <div className="text-[10.5px] mt-1 tabular-nums" style={{ color: 'var(--mute)' }}>
                        {d.checkIn ? clockTime(d.checkIn) : '—'} → {d.checkOut ? clockTime(d.checkOut) : '—'}
                        {d.workedMinutes != null && ` · ${formatDuration(d.workedMinutes)}`}
                        {d.lateMinutes > 0 && ` · ${d.lateMinutes} min late`}
                      </div>
                      {d.correctionReason && (
                        <div className="text-[10px] mt-0.5 italic" style={{ color: 'var(--faint)' }}>
                          “{d.correctionReason}”
                        </div>
                      )}
                    </div>

                    {/* Asking, never editing -- the server refuses a direct
                        write and this button reflects that honestly. */}
                    <button
                      onClick={() => openFix(d)}
                      disabled={pending}
                      className="rounded-full px-3 text-[11px] font-semibold shrink-0 disabled:opacity-40"
                      style={{ minHeight: 38, border: '1px solid var(--line)', color: 'var(--mute)' }}
                    >
                      {pending ? 'Awaiting owner' : 'Request fix'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <Sheet
        open={!!fixing}
        onClose={() => setFixing(null)}
        title="Request a correction"
        sub={fixing ? dayLabel(fixing.date) : ''}
        footer={(
          <button className="btn-primary btn-block" onClick={submitFix} disabled={saving} style={{ minHeight: 48 }}>
            {saving ? 'Sending…' : 'Send to owner'}
          </button>
        )}
      >
        <div className="space-y-4">
          <p className="text-[11.5px] leading-snug" style={{ color: 'var(--mute)' }}>
            This does not change your hours. Your gym owner sees the request and either
            approves it or turns it down.
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Check in</span>
              <input type="time" className="input mt-1 w-full" value={form.check_in} aria-label="Corrected check-in time"
                     onChange={(e) => setForm((f) => ({ ...f, check_in: e.target.value }))} style={{ minHeight: 44 }} />
            </label>
            <label className="block">
              <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>Check out</span>
              <input type="time" className="input mt-1 w-full" value={form.check_out} aria-label="Corrected check-out time"
                     onChange={(e) => setForm((f) => ({ ...f, check_out: e.target.value }))} style={{ minHeight: 44 }} />
            </label>
          </div>

          <label className="block">
            <span className="text-[9.5px] uppercase tracking-[.08em]" style={{ color: 'var(--faint)' }}>What happened</span>
            <textarea className="input mt-1 w-full" rows={3} value={form.reason}
                      aria-label="Reason for the correction"
                      placeholder="Phone was dead — I opened up at 6:00 as usual."
                      onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                      style={{ minHeight: 80, resize: 'vertical' }} />
          </label>

          {formErr && (
            <div role="alert" className="rounded-xl px-3 py-2 text-[11.5px]"
                 style={{ background: 'rgb(var(--bad-rgb) / .10)', border: '1px solid rgb(var(--bad-rgb) / .35)', color: 'var(--bad)' }}>
              {formErr}
            </div>
          )}
        </div>
      </Sheet>

      {toast && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-[12px] font-semibold z-[70]"
             style={{ bottom: 'max(20px, env(safe-area-inset-bottom))', background: 'var(--ink)', color: 'var(--bg)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
