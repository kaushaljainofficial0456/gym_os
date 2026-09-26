/**
 * GYM CROWD LIVE — the member's crowd screen.
 *
 * WHAT THIS REPLACES, and why every number here is fetched rather than
 * written down: the previous version of this file carried a hard-coded
 * 24-element array called TYPICAL_HOURLY, and derived from it the hourly
 * chart, the "most crowded" hour, the "least crowded" hour, the average
 * head-count and the advice on when to come. Two more figures -- "Peak
 * hours 5:00 PM - 7:00 PM" and "Quiet hours 10:00 PM - 6:00 AM" -- were
 * literal strings in the markup. Every gym using this product saw the same
 * invented day, including a recommendation to train at midnight, under a
 * footer that read "Live data from the gym access system".
 *
 * The backend had the real figures the entire time. This screen simply
 * never asked for them.
 *
 * SO THE RULE HERE IS: no number appears unless the server sent it.
 *
 *   * Typical hours need MIN_DAYS_FOR_TYPICAL days of real history. Under
 *     that the server returns `sufficient: false` and this screen says so
 *     rather than drawing a curve. An average over two days is not a
 *     typical day, and presenting it as one is the old bug with extra
 *     steps.
 *   * The crowd LABEL is not computed here. The thresholds are owner-
 *     configurable, so the server decides and this renders what it says --
 *     which is also why no other screen in the app bands a percentage.
 *   * "Live" is gated on `freshness.isLive`, never on the request having
 *     just returned.
 *   * No percentage without a configured capacity.
 *
 * PRIVACY: everything on this screen is a head-count per hour. No member,
 * no session, no device, no event. That is not incidental -- it is the
 * whole reason the member-facing endpoints return aggregates and never
 * rows.
 */
import { useEffect, useState } from 'react';
import { Modal } from './UI.jsx';
import InfoDot from './InfoDot.jsx';
import { api } from '../api.js';

const hourLabel = (h) => {
  const n = Number(h);
  if (!Number.isFinite(n)) return '';
  const am = n < 12;
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve} ${am ? 'AM' : 'PM'}`;
};
const windowLabel = (w) => (w ? `${hourLabel(w.startHour)} – ${hourLabel(w.endHour)}` : null);

/* Severity -> token. The SERVER chooses the severity; this map only turns
   it into a colour, so a threshold change never needs a frontend edit. */
const TONE = {
  none: 'var(--faint)',
  info: 'var(--accent)',
  low: 'var(--good)',
  medium: 'var(--warn)',
  high: 'var(--gold)',
  critical: 'var(--bad)',
};

function Ring({ pct, tone, centre, sub }) {
  const size = 148;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(Math.max(0, Math.min(1, (pct ?? 0) / 100))));
    return () => cancelAnimationFrame(t);
  }, [pct]);

  return (
    <div className="relative grid place-items-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {pct != null && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke}
            strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - shown)}
            style={{
              transform: 'rotate(-90deg)', transformOrigin: '50% 50%',
              transition: 'stroke-dashoffset 1s cubic-bezier(.22,.61,.36,1)',
            }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center px-3">
        <div className="font-black tabular-nums leading-none" style={{ fontSize: 34, color: 'var(--ink)' }}>
          {centre}
        </div>
        {sub && (
          <div className="text-[10px] uppercase tracking-[.16em] mt-2" style={{ color: 'var(--faint)' }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

/** Freshness pill. The ONLY place this screen is allowed to say "Live". */
function FreshnessPill({ freshness }) {
  if (!freshness) return null;
  const live = freshness.isLive;
  const tone = live ? 'var(--good)' : freshness.state === 'stale' ? 'var(--bad)' : 'var(--warn)';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
          style={{ background: 'rgb(var(--panel-rgb) / .7)', border: `1px solid ${tone}` }}>
      <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: tone }} />
      <span className="text-[10px] font-grotesk font-semibold uppercase tracking-[.12em]" style={{ color: tone }}>
        {freshness.label}
      </span>
    </span>
  );
}

/** One hour column. `compare` draws today over the typical curve. */
function HourBars({ data, compare, max, tone }) {
  return (
    <div className="flex items-end gap-[2px] overflow-x-auto pb-1" role="img"
         aria-label={`Crowd by hour. Busiest around ${hourLabel(
           data.reduce((best, d, i) => (d.count > data[best].count ? i : best), 0))}.`}>
      {data.map((d, i) => {
        const h = max > 0 ? (d.count / max) * 100 : 0;
        const ch = compare && max > 0 ? (compare[i].count / max) * 100 : null;
        return (
          <div key={d.hour} className="flex flex-col items-center gap-1 flex-1 min-w-[11px]">
            <div className="w-full h-24 flex items-end relative">
              <div className="w-full rounded-t-[3px]"
                   style={{ height: `${Math.max(h, d.count > 0 ? 3 : 1)}%`, background: tone, opacity: 0.85 }} />
              {ch != null && (
                /* Today, drawn as a line over the typical bar rather than a
                   second bar: two bars per hour at phone width is 48 bars. */
                <div className="absolute left-0 right-0" aria-hidden="true"
                     style={{ bottom: `${Math.max(ch, 0)}%`, height: 2, background: 'var(--ink)', opacity: ch > 0 ? 0.75 : 0 }} />
              )}
            </div>
            {i % 3 === 0 && (
              <span className="text-[7px] font-grotesk leading-none" style={{ color: 'var(--faint)' }}>
                {String(d.hour).padStart(2, '0')}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, sub, info }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg2)', border: '1px solid var(--line)' }}>
      <div className="flex items-center gap-1">
        <div className="font-grotesk text-[9.5px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>{label}</div>
        {info && <InfoDot label={label} size={26}>{info}</InfoDot>}
      </div>
      <div className="font-grotesk font-bold text-[15px] mt-1" style={{ color: 'var(--ink)' }}>{value}</div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: 'var(--mute)' }}>{sub}</div>}
    </div>
  );
}

function Notice({ children }) {
  return (
    <div className="rounded-xl p-4 text-center" style={{ background: 'var(--bg2)', border: '1px dashed var(--line)' }}>
      <div className="text-[12px] leading-snug" style={{ color: 'var(--mute)' }}>{children}</div>
    </div>
  );
}

export default function GymCrowdDetail({ open, onClose, crowd }) {
  const [history, setHistory] = useState(null);
  const [state, setState] = useState('idle');   // idle | loading | ready | error
  /* Branches. A gym with one site never sees a picker. Picking a branch
     re-asks the server for that branch's figure -- the server checks the
     branch belongs to this member's gym -- rather than slicing anything
     here. '' is the whole gym, which is what the Home card showed. */
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  const [branchCrowd, setBranchCrowd] = useState(null);
  const [branchState, setBranchState] = useState('idle');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    api('/me/crowd/branches')
      .then((r) => { if (!cancelled) setBranches(r?.branches || []); })
      .catch(() => { if (!cancelled) setBranches([]); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || !branchId) { setBranchCrowd(null); setBranchState('idle'); return undefined; }
    let cancelled = false;
    setBranchState('loading');
    api(`/me/crowd?branchId=${encodeURIComponent(branchId)}`)
      .then((r) => { if (!cancelled) { setBranchCrowd(r); setBranchState('ready'); } })
      .catch(() => { if (!cancelled) setBranchState('error'); });
    return () => { cancelled = true; };
  }, [open, branchId]);

  /* Fetched when the screen opens, not with the Home card: this replays up
     to 28 days of events and the card that links here re-polls for the
     live figure. */
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setState('loading');
    api('/me/crowd/history')
      .then((h) => { if (!cancelled) { setHistory(h); setState('ready'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [open]);

  if (!crowd) return null;

  // The figure on screen: the chosen branch's, or the whole gym's.
  const live = branchId && branchCrowd?.enabled ? branchCrowd : crowd;
  const status = live.crowd || null;
  const closed = status?.status === 'closed';
  const tone = TONE[status?.severity] || 'var(--accent)';
  const pct = status?.occupancyPercentage ?? null;
  const count = status?.occupancyCount ?? null;

  /* A gym that hides its head-count gets the same curve rescaled to a
     percentage of capacity (see the /me/crowd/history route). The SHAPE is
     the point of this screen, so it survives the privacy setting -- but it
     must not then be captioned "people", which is how a privacy feature
     turns into a wrong number. */
  const unit = history?.unit === 'percent' ? 'percent' : 'people';
  const amount = (n) => (n == null ? '—' : unit === 'percent' ? `${n}% full` : `about ${n} people`);
  const typical = history?.sufficient ? history.typicalByHour : null;
  const today = history?.todayByHour || null;
  const chartMax = typical
    ? Math.max(1, ...typical.map((d) => d.count), ...(today || []).map((d) => d.count))
    : today ? Math.max(1, ...today.map((d) => d.count)) : 1;

  return (
    <Modal open={open} onClose={onClose} title="Gym Crowd Live" wide>
      <div className="space-y-4">
        {branches.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" role="radiogroup" aria-label="Branch">
            {[{ id: '', name: 'Whole gym' }, ...branches].map((b) => (
              <button key={b.id || 'all'} role="radio" aria-checked={branchId === b.id}
                      onClick={() => setBranchId(b.id)}
                      className={`tab shrink-0 ${branchId === b.id ? 'tab-active' : ''}`}>
                {b.name}
              </button>
            ))}
          </div>
        )}
        {branchState === 'error' && (
          <Notice>That branch&rsquo;s figure could not be loaded. Showing the whole gym.</Notice>
        )}

        {/* ── now ── */}
        <div className="flex flex-col items-center text-center gap-3 pb-1" aria-busy={branchState === 'loading'}
             style={{ opacity: branchState === 'loading' ? 0.55 : 1, transition: 'opacity .2s' }}>
          <Ring
            pct={closed ? null : pct}
            tone={tone}
            centre={closed ? 'Closed' : pct != null ? `${pct}%` : (count != null ? count : '—')}
            sub={closed ? null : pct != null ? 'Occupied' : (count != null ? 'Inside' : null)}
          />
          <div>
            <div className="font-grotesk font-bold text-lg" style={{ color: tone }}>{status?.label || '—'}</div>
            <div className="text-[12px] mt-1 max-w-[34ch]" style={{ color: 'var(--mute)' }}>
              {status?.description}
            </div>
            {closed && live.hours?.open && (
              <div className="text-[12px] mt-1.5" style={{ color: 'var(--ink)' }}>
                Opening hours {live.hours.open} – {live.hours.close}
              </div>
            )}
            {!closed && status?.recommendation && (
              <div className="text-[12px] mt-1.5 max-w-[34ch]" style={{ color: 'var(--ink)' }}>
                {status.recommendation}
              </div>
            )}
          </div>
          {!closed && <FreshnessPill freshness={live.freshness} />}
        </div>

        {/* ── today's numbers, all measured ── */}
        <div className="grid grid-cols-2 gap-2">
          {/* Absent entirely when the gym hides head-counts -- the server
              sends null rather than a number, and "— people" is not a
              statistic. The busiest HOUR is still safe to show. */}
          <Stat
            label={live.peak != null ? 'Peak today' : 'Busiest today'}
            value={live.peak != null
              ? `${live.peak} people`
              : (live.peakHour != null ? `around ${hourLabel(live.peakHour)}` : '—')}
            sub={live.peak != null && live.peakHour != null ? `around ${hourLabel(live.peakHour)}` : null}
            info="The most people inside at any one time today, counted from entry and exit scans."
          />
          <Stat
            label="Capacity"
            value={status?.capacity ? `${status.capacity}` : 'Not set'}
            sub={status?.capacity ? 'people' : 'no percentage shown'}
            info={status?.capacity
              ? 'Set by your gym. The percentage above is measured against it.'
              : 'Your gym has not told us how many people it holds, so no percentage is shown — only the head-count.'}
          />
        </div>

        {/* ── typical hours ── */}
        <div>
          {branchId && (
            /* History is kept for the gym as a whole, not per branch. Saying
               so beats letting a member read one branch's figure against the
               whole gym's curve and draw a conclusion from the gap. */
            <div className="text-[10.5px] mb-2" style={{ color: 'var(--faint)' }}>Trends below are for the whole gym.</div>
          )}
          <div className="flex items-center gap-1 mb-2">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>
              When it&rsquo;s usually busy
            </div>
            <InfoDot label="typical busy hours" title="Where this comes from" size={28}>
              The average busiest point of each hour across your gym&rsquo;s last few weeks of
              entry and exit scans. Today is left out of the average — a day that is only
              half over would drag every evening hour down.
            </InfoDot>
          </div>

          {state === 'loading' && (
            <div className="h-28 rounded-xl" style={{ background: 'var(--bg2)' }} aria-busy="true" role="status" />
          )}

          {state === 'error' && (
            <Notice>Crowd history could not be loaded. The live figure above is unaffected.</Notice>
          )}

          {state === 'ready' && history?.enabled === false && (
            <Notice>Live crowd tracking is not switched on for this gym.</Notice>
          )}

          {state === 'ready' && history?.enabled !== false && !history?.sufficient && (
            /* The honest version of what the hard-coded array used to hide. */
            <Notice>
              {history?.reason === 'counts_hidden_no_capacity'
                ? 'Your gym does not publish crowd numbers, and has not set a capacity to show them against.'
                : <>Crowd trends appear once there are {history?.daysRequired ?? 7} days of attendance
                    data. Your gym has {history?.daysOfHistory ?? 0} so far.</>}
            </Notice>
          )}

          {state === 'ready' && typical && (
            <>
              <HourBars data={typical} compare={today} max={chartMax} tone={tone} />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[9px]" style={{ color: 'var(--faint)' }}>Hour of day</span>
                <span className="flex items-center gap-3 text-[9px]" style={{ color: 'var(--faint)' }}>
                  <span className="flex items-center gap-1">
                    <span style={{ width: 8, height: 8, background: tone, borderRadius: 2 }} /> Typical
                  </span>
                  <span className="flex items-center gap-1">
                    <span style={{ width: 10, height: 2, background: 'var(--ink)' }} /> Today
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <Stat label="Usually busiest" value={windowLabel(history.busiestHours) || '—'}
                      sub={history.busiestHours ? amount(history.busiestHours.average) : null} />
                <Stat label="Usually quietest" value={windowLabel(history.quietestHours) || '—'}
                      sub={history.quietestHours ? amount(history.quietestHours.average) : 'not enough range yet'} />
              </div>
              <div className="text-[10px] mt-2 text-center" style={{ color: 'var(--faint)' }}>
                Based on {history.daysOfHistory} days of your gym&rsquo;s attendance.
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
