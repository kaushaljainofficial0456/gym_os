/**
 * TRAINER ATTENDANCE — the gym owner's operational view.
 *
 * READS TOP-DOWN THE WAY AN OWNER ACTUALLY LOOKS: the shape of the day
 * first (how many in, how many late, what needs a human), then the
 * people, then the queue of things to decide. An owner should not have to
 * read a table to learn that everyone turned up.
 *
 * WHAT IT REFUSES TO SAY. Trainers with no record are shown as exactly
 * what they are -- not checked in, no shift, on leave -- never blanket
 * "absent". The server decides that (see resolveDayStatus); this file
 * only renders the verdict. An attendance screen that guesses is worse
 * than one that admits it does not know, because the guess is what gets
 * quoted back to the person in a pay conversation.
 *
 * Nothing here is a trainer PERFORMANCE score. Attendance measures
 * presence and time; coaching quality is a different thing and is
 * deliberately not blended into a single number.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api.js';
import { ErrorState, PageSkeleton, Avatar, Toast } from '../../components/UI.jsx';
import { formatDuration, clockTime, STATUS_TONE } from '../../components/trainer/AttendanceCard.jsx';

/** Statuses the roster can return that have no attendance row behind them.
 *  Named so the UI can say the true thing rather than "absent". */
const DERIVED_TONE = {
  NOT_CHECKED_IN: { fg: 'var(--mute)', bg: 'transparent', label: 'Not in yet' },
  PENDING: { fg: 'var(--warn)', bg: 'rgb(var(--warn-rgb) / .10)', label: 'Not checked in' },
  NO_RECORD: { fg: 'var(--faint)', bg: 'transparent', label: 'No record' },
  SCHEDULED: { fg: 'var(--mute)', bg: 'transparent', label: 'Scheduled' },
};
const toneFor = (s) => STATUS_TONE[s] || DERIVED_TONE[s] || DERIVED_TONE.NO_RECORD;

const FILTERS = [
  ['all', 'All'],
  ['in', 'In'],
  ['late', 'Late'],
  ['out', 'Not in'],
  ['exception', 'Needs attention'],
];

const todayKey = () => new Date().toLocaleDateString('en-CA');

export default function GymAttendance() {
  const [date, setDate] = useState(todayKey());
  const [data, setData] = useState(null);
  const [corrections, setCorrections] = useState([]);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(null);
  const [qr, setQr] = useState(null);
  const [policyBusy, setPolicyBusy] = useState(false);

  const load = useCallback(async (d) => {
    try {
      const [roster, corr] = await Promise.all([
        api(`/attendance/roster?date=${d}`),
        api('/attendance/corrections'),
      ]);
      setData(roster);
      setCorrections(corr.corrections || []);
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load attendance');
      setData({ roster: [], summary: null });
    }
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const decide = async (id, decision) => {
    setBusy(id);
    try {
      await api(`/attendance/corrections/${id}/${decision}`, { method: 'POST', body: JSON.stringify({}) });
      setToast(decision === 'approve' ? 'Correction approved' : 'Correction rejected');
      await load(date);
    } catch (e) {
      setToast(e.message || 'Could not save that');
    }
    setBusy(null);
  };

  /* Turning scanning OFF weakens every number on this page, so it asks
     -- and says what it costs, in the owner's terms, not "are you
     sure?". Turning it back ON is not destructive and just happens. */
  const toggleRequireQr = async () => {
    const currentlyRequired = data.policy?.requireQr !== false;
    if (currentlyRequired) {
      const ok = window.confirm(
        'Allow self check-in?\n\nTrainers will be able to record attendance from anywhere, '
        + 'without scanning a code at the gym. Hours recorded this way are marked as self-reported.');
      if (!ok) return;
    }
    setPolicyBusy(true);
    try {
      await api('/attendance/policy', {
        method: 'PUT',
        body: JSON.stringify({ require_qr: !currentlyRequired }),
      });
      await load(date);
    } catch (e) {
      window.alert(e.message || 'Could not change the attendance policy');
    }
    setPolicyBusy(false);
  };

  const openQr = async () => {
    try {
      setQr(await api('/attendance/qr'));
    } catch (e) {
      setToast(e.message || 'Could not create a code');
    }
  };

  const shown = useMemo(() => {
    let list = data?.roster || [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => r.name.toLowerCase().includes(q));
    if (filter === 'in') list = list.filter((r) => ['PRESENT', 'LATE'].includes(r.status) && r.checkIn);
    if (filter === 'late') list = list.filter((r) => r.status === 'LATE');
    if (filter === 'out') list = list.filter((r) => !r.checkIn && !['LEAVE', 'OFF_DAY'].includes(r.status));
    if (filter === 'exception') {
      list = list.filter((r) => r.status === 'MISSING_CHECKOUT' || r.status === 'ABSENT'
        || r.status === 'PENDING' || r.correctionStatus === 'PENDING');
    }
    return list;
  }, [data, query, filter]);

  if (!data) return <PageSkeleton />;
  if (err && !data.roster.length) return <ErrorState message={err} onRetry={() => load(date)} />;

  const s = data.summary;
  const isToday = date === todayKey();

  return (
    <div className="pb-20">
      <header className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-black leading-tight" style={{ fontSize: 23, color: 'var(--ink)' }}>
            Trainer attendance
          </h1>
          <div className="text-[12px] mt-1" style={{ color: 'var(--mute)' }}>
            {/* Says which MODE the gym is in, because the same screen
                means different things with and without shifts. */}
            {data.policy?.mode === 'scheduled'
              ? `Shift-based · ${data.policy.graceMinutes} min grace`
              : 'Hours are recorded as worked — no fixed shifts'}
          </div>
          {/* Whether attendance here is evidence or self-report is the
              single most important thing about this screen's numbers, so
              it is stated next to them rather than buried in settings. */}
          <div className="text-[11px] mt-1" style={{ color: data.policy?.requireQr === false ? 'var(--warn)' : 'var(--mute)' }}>
            {data.policy?.requireQr === false
              ? 'Self check-in allowed — trainers can record hours without scanning'
              : 'Scan required — hours come from the gym codes'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            type="date"
            value={date}
            max={todayKey()}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Attendance date"
            className="input !py-1.5 !px-2 text-[12px]"
            style={{ minHeight: 40 }}
          />
          <button
            type="button"
            onClick={openQr}
            className="rounded-xl px-3 text-[12px] font-semibold"
            style={{ minHeight: 40, border: '1px solid var(--accent)', color: 'var(--accent)' }}
          >
            Show codes
          </button>
          {/* The toggle lives beside the codes because it is the same
              decision: whether this gym runs on scans at all. */}
          <button
            type="button"
            onClick={toggleRequireQr}
            disabled={policyBusy}
            className="rounded-xl px-3 text-[12px] font-semibold"
            style={{ minHeight: 40, border: '1px solid var(--line)', color: 'var(--mute)', opacity: policyBusy ? 0.6 : 1 }}
          >
            {data.policy?.requireQr === false ? 'Require scanning' : 'Allow self check-in'}
          </button>
        </div>
      </header>

      {/* The shape of the day, before any table. */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <Stat label="trainers" value={s.trainers} />
          <Stat label="checked in" value={s.present + s.late} tone="var(--good)" />
          <Stat label="late" value={s.late} tone={s.late ? 'var(--warn)' : undefined} />
          <Stat
            label="need attention"
            value={s.missingCheckout + s.absent + s.pendingCorrections}
            tone={(s.missingCheckout + s.absent + s.pendingCorrections) ? 'var(--bad)' : undefined}
          />
        </div>
      )}

      {/* The queue comes BEFORE the roster: it is the only part of this
          page that needs a decision rather than a glance. */}
      {corrections.length > 0 && (
        <section className="mb-4">
          <h2 className="t-micro mb-2">Corrections to review</h2>
          <div className="space-y-2">
            {corrections.map((c) => (
              <div key={c.id} className="card p-3.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-semibold text-[13px]" style={{ color: 'var(--ink)' }}>
                      {c.trainerName} · {c.date}
                    </div>
                    <div className="text-[11.5px] mt-1" style={{ color: 'var(--mute)' }}>
                      Asking for {clockTime(c.requestedCheckIn) || '—'}
                      {c.requestedCheckOut ? ` – ${clockTime(c.requestedCheckOut)}` : ''}
                      {c.currentCheckIn
                        ? ` · currently ${clockTime(c.currentCheckIn)}`
                        : ' · nothing currently recorded'}
                    </div>
                    {c.reason && (
                      <div className="text-[11.5px] mt-1 italic" style={{ color: 'var(--mute)' }}>“{c.reason}”</div>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      type="button" disabled={busy === c.id}
                      onClick={() => decide(c.id, 'reject')}
                      className="rounded-lg px-3 text-[11.5px] font-semibold"
                      style={{ minHeight: 38, border: '1px solid var(--line)', color: 'var(--mute)' }}
                    >Reject</button>
                    <button
                      type="button" disabled={busy === c.id}
                      onClick={() => decide(c.id, 'approve')}
                      className="rounded-lg px-3 text-[11.5px] font-semibold"
                      style={{ minHeight: 38, background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)' }}
                    >Approve</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex gap-2 mb-3 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search trainers"
          aria-label="Search trainers"
          className="input flex-1 text-[12.5px]"
          style={{ minHeight: 42, minWidth: 160 }}
        />
      </div>
      <div className="flex gap-1.5 mb-3 flex-wrap" role="tablist" aria-label="Filter attendance">
        {FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <button
              key={key} role="tab" aria-selected={on}
              onClick={() => setFilter(key)}
              className="rounded-lg px-3 text-[11.5px] font-semibold"
              style={{
                minHeight: 36,
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
              }}
            >{label}</button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div className="card p-6 text-center">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            {data.roster.length === 0 ? 'No trainers at this gym yet' : 'Nothing matches that filter'}
          </div>
          {data.roster.length === 0 && (
            <div className="text-[11.5px] mt-1.5" style={{ color: 'var(--mute)' }}>
              Add a trainer and their attendance will appear here.
            </div>
          )}
        </div>
      ) : (
        /* One row shape at every width. A data table squeezed into 375px
           is unreadable, and a card list on desktop wastes the screen --
           this is a row that stays legible at both because the columns
           collapse into the row's own second line instead of shrinking. */
        <div className="space-y-1.5">
          {shown.map((r) => {
            const tone = toneFor(r.status);
            return (
              <div key={r.trainerId} className="card p-3 flex items-center gap-3">
                <Avatar name={r.name} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>
                      {r.name}
                    </span>
                    <span
                      className="text-[9px] uppercase tracking-[.12em] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ background: tone.bg, color: tone.fg }}
                    >{tone.label}</span>
                    {r.correctionStatus === 'PENDING' && (
                      <span className="text-[9px] uppercase tracking-[.12em] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        Correction
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--mute)' }}>
                    {r.checkIn ? clockTime(r.checkIn) : '—'}
                    {r.checkOut ? ` – ${clockTime(r.checkOut)}` : r.checkIn ? ' – still in' : ''}
                    {r.scheduled && (
                      <span style={{ color: 'var(--faint)' }}> · rostered {r.scheduled.start}–{r.scheduled.end}</span>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <div className="text-[12.5px] font-bold" style={{ color: 'var(--ink)' }}>
                    {formatDuration(r.workedMinutes) || '—'}
                  </div>
                  {r.lateMinutes > 0 && (
                    <div className="text-[10px]" style={{ color: 'var(--warn)' }}>+{r.lateMinutes}m late</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isToday && (
        <div className="text-[11px] mt-3 text-center" style={{ color: 'var(--faint)' }}>
          Showing {date}. Switch back to today for live check-ins.
        </div>
      )}

      {qr && <QrDialog qr={qr} onClose={() => setQr(null)} onRefresh={openQr} />}
      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="card p-3">
      <div className="font-black tabular-nums leading-none" style={{ fontSize: 22, color: tone || 'var(--ink)' }}>
        {value}
      </div>
      <div className="text-[10.5px] mt-1.5" style={{ color: 'var(--mute)' }}>{label}</div>
    </div>
  );
}

/**
 * The code a gym puts on a screen by the door. It is short-lived by
 * design: a photograph of it stops working within the minute, which is
 * the whole reason it is not a permanent URL. The raw token is shown as
 * text too, because without a scanner build there has to be SOME way to
 * use it -- and it is useless once expired.
 */
function QrDialog({ qr, onClose, onRefresh }) {
  const [left, setLeft] = useState(qr.expiresIn);
  useEffect(() => { setLeft(qr.expiresIn); }, [qr]);
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  /* THESE CODES LIVE ON A WALL, SO THEY REFRESH THEMSELVES.
     The countdown ran to zero and then simply sat there expired until
     somebody noticed and pressed a button. On a gym display that means
     the codes are dead ninety seconds after the owner opens the screen,
     and every trainer who arrives after that cannot check in -- which
     would have pushed the gym straight back to allowing self check-in.
     Renewing a few seconds early avoids the gap where a trainer is
     mid-scan as the code turns over. */
  useEffect(() => {
    if (left > 5) return undefined;
    const t = setTimeout(() => { onRefresh?.(); }, 400);
    return () => clearTimeout(t);
  }, [left, onRefresh]);

  // `token` is the pre-two-code shape; falling back to it means an owner
  // on a stale bundle still sees a working check-in code.
  const inToken = qr.in || qr.token;
  const outToken = qr.out;
  const expired = left === 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,.6)' }}
      onClick={onClose}
      role="dialog" aria-modal="true" aria-label="Trainer attendance codes"
    >
      <div className="card p-5 w-full max-w-lg my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-grotesk font-bold text-[14px]" style={{ color: 'var(--ink)' }}>
            Trainer attendance codes
          </h2>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-lg px-2" style={{ minHeight: 36, color: 'var(--mute)' }}>Close</button>
        </div>

        {/* Two codes, because arriving and leaving are two different
            events. One code for both would let a single scan stand in for
            either, which is how a duration ends up resting on one
            observation and one assumption. */}
        <p className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>
          Put these on the gym display. Trainers scan <strong style={{ color: 'var(--ink)' }}>Arriving</strong> on
          the way in and <strong style={{ color: 'var(--ink)' }}>Leaving</strong> on the way out, so worked hours
          come from two real scans. Both expire in{' '}
          <strong className="tabular-nums" style={{ color: left <= 15 ? 'var(--bad)' : 'var(--ink)' }}>{left}s</strong>
          {' '}— a saved screenshot will not work tomorrow.
        </p>

        <div className="grid sm:grid-cols-2 gap-3">
          <CodePanel label="Arriving" sub="Scan to check in" token={inToken} tone="var(--m-body)" expired={expired} />
          {outToken
            ? <CodePanel label="Leaving" sub="Scan to check out" token={outToken} tone="var(--m-energy)" expired={expired} />
            : (
              <div className="rounded-xl grid place-items-center p-4 text-[11.5px] text-center"
                   style={{ border: '1px dashed var(--line)', color: 'var(--mute)' }}>
                The check-out code needs the updated server. Refresh this page after deploying.
              </div>
            )}
        </div>

        {expired && (
          <div className="text-[11px] mt-2.5 text-center font-semibold" style={{ color: 'var(--warn)' }}>
            Renewing…
          </div>
        )}

        <button
          type="button"
          onClick={onRefresh}
          className="w-full mt-3 rounded-xl text-[12px] font-semibold"
          style={{ minHeight: 42, border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          {expired ? 'Renewing…' : 'Refresh codes now'}
        </button>
      </div>
    </div>
  );
}

/** One labelled QR. Fixed black-on-white regardless of theme: a QR needs
 *  hard contrast to scan, and a themed foreground on a themed background
 *  is exactly how these end up unreadable by a phone camera. */
function CodePanel({ label, sub, token, tone, expired }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className="rounded-xl p-3" style={{ border: `1px solid ${tone}`, background: 'var(--bg)' }}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-grotesk text-[12.5px] font-bold" style={{ color: tone }}>{label}</span>
        <span className="text-[10px]" style={{ color: 'var(--mute)' }}>{sub}</span>
      </div>
      <div className="rounded-lg grid place-items-center p-3"
           style={{ background: '#FFFFFF', opacity: expired ? 0.3 : 1 }}>
        <QRCodeSVG value={token} size={168} level="M" bgColor="#FFFFFF" fgColor="#000000" />
      </div>
      {/* Kept for a broken camera or a code read out over the phone, but
          no longer the primary thing on screen -- it used to be the ONLY
          thing, which is why nobody scanned anything. */}
      <button type="button" onClick={() => setShowText((v) => !v)}
              className="text-[10.5px] mt-2 w-full text-left" style={{ color: 'var(--mute)' }}>
        {showText ? 'Hide text code' : "Can't scan? Show text code"}
      </button>
      {showText && (
        <div className="rounded-lg px-2 py-1.5 break-all text-[9px] font-mono mt-1.5"
             style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}>
          {token}
        </div>
      )}
    </div>
  );
}
