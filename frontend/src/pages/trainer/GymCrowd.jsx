/**
 * GYM CROWD LIVE — the owner's command centre.
 *
 * Two questions, answered in that order:
 *   1. What is happening in my building right now?
 *   2. Can I trust that number?
 *
 * That is why freshness, device health, alerts and the reconciliation
 * queue sit ON this screen rather than behind a settings tab. An occupancy
 * figure with no provenance is worse than no figure: it gets used.
 *
 * EVERY NUMBER IS LABELLED FOR WHAT IT IS (see backend analytics.js):
 * entries and exits are MEASURED door events; occupancy by hour is what
 * we RECORDED at the time (snapshots), never reconstructed afterwards;
 * comparisons are CALCULATED like-for-like -- entries so far today versus
 * entries by the same hour yesterday, never against a whole day.
 *
 * PRIVACY: aggregate by default. Names of the people inside appear only in
 * the operational view, which is opt-in per visit, and each look is
 * written to the access audit log on the server.
 *
 * POLLING, NOT SOCKETS: this codebase has no WebSocket or SSE, and
 * inventing one for a screen would be shared plumbing built for one
 * caller. The poll pauses when the tab is hidden and stops on unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { PageHeader, ErrorState, PageSkeleton, Empty, Modal } from '../../components/UI.jsx';
import InfoDot from '../../components/InfoDot.jsx';
import { AlertList } from '../../components/access/OpsPanels.jsx';
import { Field, ErrorLine, When, useToast } from '../../components/access/shared.jsx';

const TONE = {
  none: 'var(--faint)', info: 'var(--accent)', low: 'var(--good)',
  medium: 'var(--warn)', high: 'var(--gold)', critical: 'var(--bad)',
};
const REFRESH_MS = 20_000;
const SIDE_REFRESH_MS = 60_000;
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;

function useLivePoll(fn, ms) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const saved = useRef(fn);
  saved.current = fn;
  const run = useCallback(async () => {
    try { setState({ data: await saved.current(), error: null, loading: false }); }
    catch (e) { setState((s) => ({ data: s.data, error: e, loading: false })); }
  }, []);
  useEffect(() => {
    let timer = null;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === 'visible') await run();
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    tick();
    const onVisible = () => { if (document.visibilityState === 'visible') run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [run, ms]);
  return { ...state, refresh: run };
}

function Ring({ pct, tone, centre, sub, size = 168 }) {
  const stroke = 14;
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
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke}
                  strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - shown)}
                  style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%', transition: 'stroke-dashoffset .9s cubic-bezier(.22,.61,.36,1)' }} />
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <div className="font-black tabular-nums leading-none" style={{ fontSize: 40, color: 'var(--ink)' }}>{centre}</div>
        {sub && <div className="text-[10px] uppercase tracking-[.16em] mt-2" style={{ color: 'var(--faint)' }}>{sub}</div>}
      </div>
    </div>
  );
}

function Freshness({ freshness }) {
  if (!freshness) return null;
  const tone = freshness.isLive ? 'var(--good)' : freshness.state === 'stale' ? 'var(--bad)' : 'var(--warn)';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5" style={{ minHeight: 28, border: `1px solid ${tone}` }}>
      <span className="rounded-full" style={{ width: 6, height: 6, background: tone }} aria-hidden="true" />
      <span className="text-[10px] font-grotesk font-bold uppercase tracking-[.12em]" style={{ color: tone }}>{freshness.label}</span>
    </span>
  );
}

function Metric({ label, value, sub, tone, info }) {
  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-1">
        <div className="text-[9.5px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>{label}</div>
        {info && <InfoDot label={label} size={26}>{info}</InfoDot>}
      </div>
      <div className="font-black text-[22px] tabular-nums mt-1" style={{ color: tone || 'var(--ink)' }}>{value}</div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: 'var(--mute)' }}>{sub}</div>}
    </div>
  );
}

/**
 * Entries per hour, today as bars and yesterday as a line, both in the
 * gym's local hours. Separate series for separate facts: entries are
 * counted, and are not drawn on the same axis as occupancy.
 */
function HourlyChart({ today, yesterday, nowHour }) {
  const max = Math.max(1, ...today.map((h) => h.entries), ...yesterday.map((h) => h.entries));
  const W = 24 * 14;
  const H = 110;
  const y = (v) => H - (v / max) * (H - 8);
  const line = yesterday.map((h, i) => `${i === 0 ? 'M' : 'L'}${i * 14 + 7},${y(h.entries)}`).join(' ');
  const peak = today.reduce((b, h) => (h.entries > (b?.entries ?? -1) ? h : b), null);
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H + 16}`} width="100%" style={{ minWidth: 320, maxHeight: 180 }} role="img"
             aria-label={`Entries by hour today${peak?.entries ? `, busiest around ${hourLabel(peak.hour)} with ${peak.entries}` : ''}. Yesterday shown as a line.`}>
          {today.map((h, i) => (
            <rect key={i} x={i * 14 + 2} width={10} y={y(h.entries)} height={H - y(h.entries)} rx={2}
                  fill={i > nowHour ? 'var(--line)' : 'var(--accent)'} opacity={i === nowHour ? 1 : 0.8}>
              <title>{`${hourLabel(h.hour)}: ${h.entries} in, ${h.exits} out today; yesterday ${yesterday[i].entries} in`}</title>
            </rect>
          ))}
          <path d={line} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeOpacity="0.55" strokeDasharray="3 3" />
          {[0, 6, 12, 18, 23].map((h) => (
            <text key={h} x={h * 14 + 7} y={H + 12} fontSize="8" textAnchor="middle" fill="var(--faint)">{hourLabel(h)}</text>
          ))}
        </svg>
      </div>
      <div className="flex gap-4 mt-1 text-[10px]" style={{ color: 'var(--faint)' }}>
        <span className="flex items-center gap-1"><span style={{ width: 8, height: 8, background: 'var(--accent)', borderRadius: 2 }} /> Entries today</span>
        <span className="flex items-center gap-1"><span style={{ width: 12, height: 0, borderTop: '1.5px dashed var(--ink)', opacity: 0.55 }} /> Yesterday</span>
      </div>
    </div>
  );
}

/** Average arrivals per weekday × hour. On narrow screens it scrolls. */
function WeeklyHeat({ weekly }) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const max = Math.max(1, ...weekly.grid.flatMap((d) => d.hours.map((v) => v || 0)));
  return (
    <div className="overflow-x-auto">
      <table className="text-[9px]" style={{ borderCollapse: 'separate', borderSpacing: 2, minWidth: 520 }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal" style={{ color: 'var(--faint)' }}>{h % 3 === 0 ? hourLabel(h) : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {weekly.grid.map((d) => (
            <tr key={d.dow}>
              <th className="font-normal pr-1 text-left" style={{ color: 'var(--mute)' }}>{days[d.dow]}</th>
              {d.hours.map((v, h) => (
                <td key={h} title={v == null ? 'No data' : `${days[d.dow]} ${hourLabel(h)}: about ${v} arrivals`}
                    style={{ width: 16, height: 16, borderRadius: 3, background: v == null ? 'transparent' : `rgb(var(--accent-rgb) / ${0.08 + (v / max) * 0.85})`, border: v == null ? '1px dashed var(--line)' : 'none' }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CloseSessionSheet({ session, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/admin/access/sessions/${session.id}/close`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      onDone();
    } catch (e) { setError(e.message || 'Could not close the session.'); }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title={`Mark ${session.name} as left`}>
      <div className="space-y-3">
        <p className="text-[12px]" style={{ color: 'var(--mute)' }}>
          Their exit time is recorded as unknown — not as now — and the visit is marked estimated, so no report
          treats it as a measured duration.
        </p>
        <Field label="Reason" help="Recorded in the audit log.">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Seen leaving, forgot to scan out" />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <button className="btn btn-primary w-full" onClick={save} disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : 'Mark as left'}</button>
      </div>
    </Modal>
  );
}

export default function GymCrowd() {
  const live = useLivePoll(() => api('/admin/access/live'), REFRESH_MS);
  /* Alerts, analytics and the event feed on their own slower poll. Loading
     them once on mount was wrong in a way that only shows on a screen left
     open: an alert raised at 10:04 stayed invisible until the owner
     reloaded, on the one screen whose job is to say something needs
     attention. They also run a beat behind /live deliberately -- the alert
     evaluation happens inside the tick that /live triggers. */
  const side = useLivePoll(async () => {
    const [a, al, e] = await Promise.all([
      api('/admin/access/analytics').catch(() => null),
      api('/admin/access/alerts').catch(() => null),
      api('/admin/access/events?limit=15').catch(() => null),
    ]);
    return { analytics: a, alerts: al?.alerts || [], events: e?.events || [] };
  }, SIDE_REFRESH_MS);
  const analytics = side.data?.analytics || null;
  const alerts = side.data?.alerts || null;
  const events = side.data?.events || null;
  const [view, setView] = useState('aggregate');
  const [sessions, setSessions] = useState(null);
  const [closing, setClosing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  const loadSessions = useCallback(async () => {
    try { setSessions((await api('/admin/access/sessions')).sessions); } catch (e) { showToast(e.message); setView('aggregate'); }
  }, [showToast]);
  useEffect(() => { if (view === 'detail') loadSessions(); }, [view, loadSessions]);

  const d = live.data;
  const crowd = d?.crowd;
  const tone = TONE[crowd?.severity] || 'var(--accent)';
  /* The gym's hour, not the browser's: the bars are bucketed in the gym's
     timezone, and an owner checking in from abroad should still see the
     right hours greyed out as not-yet-happened. */
  const nowHour = useMemo(() => {
    try {
      return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: analytics?.timezone || undefined })
        .format(new Date())) % 24;
    } catch { return new Date().getHours(); }
  }, [analytics, d]);

  const refreshAll = () => { live.refresh(); side.refresh(); if (view === 'detail') loadSessions(); };

  const runReconcile = async () => {
    setBusy(true);
    try {
      const r = await api('/admin/access/reconciliation/run', { method: 'POST', body: JSON.stringify({ maxHours: 12 }) });
      showToast(r.closed === 0 ? 'Nothing needed closing.' : `Closed ${r.closed} session${r.closed === 1 ? '' : 's'} left open.`);
      refreshAll();
    } catch (e) { showToast(e.message || 'Could not run reconciliation.'); }
    setBusy(false);
  };

  const ack = async (a) => {
    try { await api(`/admin/access/alerts/${a.id}/acknowledge`, { method: 'POST' }); side.refresh(); }
    catch (e) { showToast(e.message); }
  };

  if (live.loading && !d) return <PageSkeleton variant="dashboard" label="Loading live occupancy" />;
  if (live.error && !d) return <ErrorState error={live.error} onRetry={live.refresh} />;

  const unresolved = (d?.unresolved?.unmatched || 0) + (d?.unresolved?.rejected || 0) + (d?.unresolved?.staleSessions || 0);
  const cmp = analytics?.comparison;

  return (
    <div className="space-y-4">
      <PageHeader title="Gym Crowd Live" sub="Who is inside right now, and whether the number can be trusted"
                  right={<Freshness freshness={d?.freshness} />} />

      {/* ── now ── */}
      <div className="card p-5">
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <Ring pct={crowd?.occupancyPercentage} tone={tone}
                centre={crowd?.occupancyPercentage != null ? `${crowd.occupancyPercentage}%` : (d?.inside ?? '—')}
                sub={crowd?.occupancyPercentage != null ? 'Occupied' : 'Inside'} />
          <div className="flex-1 min-w-0 w-full">
            <div className="font-grotesk font-bold text-xl" style={{ color: tone }}>{crowd?.label || '—'}</div>
            <div className="text-[13px] mt-1" style={{ color: 'var(--mute)' }}>{crowd?.description}</div>
            {d?.simulatedInside > 0 && (
              <div className="text-[11.5px] mt-1" style={{ color: 'var(--warn)' }}>
                Plus {d.simulatedInside} simulated {d.simulatedInside === 1 ? 'person' : 'people'} from the demo connection — not counted, never shown to members.
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
              <Metric label="Inside" value={d?.inside ?? '—'} />
              <Metric label="Entries today" value={d?.entriesToday ?? 0}
                      sub={cmp?.pctChange != null ? `${cmp.pctChange >= 0 ? '+' : ''}${cmp.pctChange}% vs yesterday by now` : null}
                      info="Counted from door events. The comparison is with yesterday up to the same hour, not with all of yesterday." />
              <Metric label="Exits today" value={d?.exitsToday ?? 0} />
              <Metric label="Capacity" value={d?.capacity || 'Not set'}
                      info={d?.capacity ? 'Set in Access control → Settings. The percentage is measured against it.' : 'No capacity is set, so no percentage is shown anywhere — only the head-count.'} />
            </div>
          </div>
        </div>
      </div>

      {/* ── needs attention ── */}
      {alerts && alerts.length > 0 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk mb-2.5" style={{ color: 'var(--faint)' }}>Needs attention</div>
          <AlertList alerts={alerts} onAcknowledge={ack} />
        </div>
      )}

      {/* ── can I trust it ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="flex items-center gap-1 mb-2.5">
            <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Device health</div>
            <InfoDot label="device health" title="What online means" size={26}>
              A device is online because it sent something in the last 30 minutes, not because it is configured.
            </InfoDot>
          </div>
          {d?.devices?.total ? (
            <>
              <div className="font-black text-[22px] tabular-nums" style={{ color: d.devices.online === d.devices.total ? 'var(--good)' : 'var(--warn)' }}>
                {d.devices.online} of {d.devices.total}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
                {d.devices.online === d.devices.total ? 'All devices reporting' : 'Some devices have gone quiet'}
              </div>
            </>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--mute)' }}>
              {/* Underlined, not just tinted: a link inside a sentence that
                  is only distinguished by colour fails WCAG 1.4.1, and in
                  the light theme the accent against muted body text is
                  genuinely hard to pick out. */}
              No devices yet. <Link to="/app/trainer/access?tab=devices"
                                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Add one</Link>.
            </div>
          )}
        </div>

        <div className="card p-4">
          <div className="flex items-center gap-1 mb-2.5">
            <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Unresolved</div>
            <InfoDot label="unresolved events" title="What ends up here" size={26}>
              Scans we could not attribute to anyone, events we could not read, and people still marked inside long
              after they left. None of these break the count — they explain it.
            </InfoDot>
          </div>
          <div className="font-black text-[22px] tabular-nums" style={{ color: unresolved ? 'var(--warn)' : 'var(--good)' }}>{unresolved}</div>
          {unresolved > 0 && (
            <div className="text-[11px] mt-1 space-y-0.5" style={{ color: 'var(--mute)' }}>
              {d.unresolved.unmatched > 0 && <div>{d.unresolved.unmatched} unrecognised scan{d.unresolved.unmatched === 1 ? '' : 's'}</div>}
              {d.unresolved.staleSessions > 0 && <div>{d.unresolved.staleSessions} still marked inside</div>}
              {d.unresolved.rejected > 0 && <div>{d.unresolved.rejected} unreadable event{d.unresolved.rejected === 1 ? '' : 's'}</div>}
            </div>
          )}
          {d?.unresolved?.staleSessions > 0 && (
            <button className="btn btn-sm w-full mt-3" onClick={runReconcile} disabled={busy}>{busy ? 'Closing…' : 'Close sessions left open'}</button>
          )}
        </div>

        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk mb-2.5" style={{ color: 'var(--faint)' }}>Today so far</div>
          <div className="space-y-1 text-[12px]" style={{ color: 'var(--mute)' }}>
            {/* A recorded peak of zero is not a peak. "0 inside around 2a"
                dresses up "nobody has been in yet" as a finding. */}
            <div>Busiest: <span style={{ color: 'var(--ink)' }}>{analytics?.peakToday?.occupancy
              ? `${analytics.peakToday.occupancy} inside around ${hourLabel(analytics.peakToday.hour)}`
              : 'nobody in yet today'}</span></div>
            <div>Average visit: <span style={{ color: 'var(--ink)' }}>{analytics?.avgVisitMin != null ? `${analytics.avgVisitMin} min` : '—'}</span>
              {analytics?.visitsMeasured ? <span> ({analytics.visitsMeasured} measured)</span> : null}</div>
            <div>Last event: <span style={{ color: 'var(--ink)' }}><When at={d?.freshness?.lastEventAt} fallback="none today" /></span></div>
          </div>
        </div>
      </div>

      {/* ── hourly ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-1">
            <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Arrivals by hour</div>
            <InfoDot label="arrivals by hour" title="How this is counted" size={26}>
              Each bar counts entries in that hour, in your gym&rsquo;s local time. The dashed line is yesterday.
              Future hours are greyed out — they have not happened.
            </InfoDot>
          </div>
          <button className="btn btn-sm" onClick={refreshAll}>Refresh</button>
        </div>
        {!analytics ? <div className="h-28" /> : analytics.source === 'none' ? (
          <Empty title="No arrivals recorded yet" hint="Once people scan in, their arrivals appear here hour by hour." />
        ) : (
          <HourlyChart today={analytics.today} yesterday={analytics.yesterday} nowHour={nowHour} />
        )}
      </div>

      {analytics?.weekly && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk mb-2.5" style={{ color: 'var(--faint)' }}>Typical week</div>
          {analytics.weekly.sufficient ? <WeeklyHeat weekly={analytics.weekly} /> : (
            <div className="text-[12px]" style={{ color: 'var(--mute)' }}>
              The weekly pattern appears after {analytics.weekly.daysRequired} days of arrivals. There are {analytics.weekly.daysWithData} so far.
            </div>
          )}
        </div>
      )}

      {/* ── branches ── */}
      {d?.branches?.length > 1 && (
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk mb-3" style={{ color: 'var(--faint)' }}>By branch</div>
          <div className="space-y-2.5">
            {[...d.branches].sort((a, b) => b.occupancy - a.occupancy).map((b) => {
              const max = Math.max(1, d.capacity || 0, ...d.branches.map((x) => x.occupancy));
              return (
                <div key={b.id}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-grotesk font-semibold truncate" style={{ color: 'var(--ink)' }}>{b.name}</span>
                    <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--mute)' }}>{b.occupancy} inside</span>
                  </div>
                  <div className="h-2 rounded-full mt-1 overflow-hidden" style={{ background: 'var(--line)' }}>
                    <div style={{ width: `${(b.occupancy / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── who is inside ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>People inside</div>
            <InfoDot label="people inside" title="Why names are opt-in" size={26}>
              Who was in the building, and when, is personal information. Names are shown only when you ask, and
              each time you do it is recorded in the access audit log.
            </InfoDot>
          </div>
          <div className="flex gap-1" role="radiogroup" aria-label="People inside view">
            {[['aggregate', 'Count'], ['detail', 'Names']].map(([k, l]) => (
              <button key={k} role="radio" aria-checked={view === k} onClick={() => setView(k)} className={`tab ${view === k ? 'tab-active' : ''}`}>{l}</button>
            ))}
          </div>
        </div>
        {view === 'aggregate' ? (
          <div className="text-[13px]" style={{ color: 'var(--mute)' }}>
            <span className="font-black text-[20px] tabular-nums" style={{ color: 'var(--ink)' }}>{d?.inside ?? 0}</span> inside now.
          </div>
        ) : !sessions ? <div className="text-[12px]" style={{ color: 'var(--faint)' }}>Loading…</div> : sessions.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--mute)' }}>Nobody is marked inside.</div>
        ) : (
          <div>
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 py-2" style={{ borderTop: '1px solid var(--line)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-grotesk truncate" style={{ color: 'var(--ink)' }}>
                    {s.name}{s.demo && <span style={{ color: 'var(--warn)' }}> · demo</span>}
                  </div>
                  <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
                    In since <When at={s.enteredAt} /> · {s.minutesInside >= 60 ? `${Math.floor(s.minutesInside / 60)}h ${s.minutesInside % 60}m` : `${s.minutesInside}m`}
                    {s.branch ? ` · ${s.branch}` : ''}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => setClosing(s)}>Mark as left</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── activity ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Recent activity</div>
          <Link to="/app/trainer/access?tab=events" className="text-[11px]" style={{ color: 'var(--accent)' }}>All events</Link>
        </div>
        {events == null ? <div className="py-6 text-center text-[12px]" style={{ color: 'var(--faint)' }} role="status">Loading…</div>
          : events.length === 0 ? <Empty title="No door events yet" hint="Once an access device is connected, every entry and exit appears here." />
            : events.map((e) => {
              const c = e.status === 'PROCESSED' ? 'var(--good)' : e.status === 'IGNORED_DUPLICATE' ? 'var(--faint)' : e.status === 'UNMATCHED' ? 'var(--warn)' : 'var(--bad)';
              return (
                <div key={e.id} className="flex items-center gap-2.5 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
                  <span className="rounded-full shrink-0" style={{ width: 7, height: 7, background: c }} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-grotesk truncate" style={{ color: 'var(--ink)' }}>
                      {e.member || 'Unrecognised'}<span style={{ color: 'var(--mute)' }}> · {e.type.toLowerCase()}</span>
                    </div>
                    <div className="text-[10px] truncate" style={{ color: 'var(--faint)' }}>
                      <When at={e.occurredAt} />{e.device ? ` · ${e.device}` : ''}{e.source === 'demo' ? ' · demo' : ''}
                      {e.status !== 'PROCESSED' ? ` · ${e.status.toLowerCase().replace(/_/g, ' ')}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
      </div>

      {closing && (
        <CloseSessionSheet session={closing} onClose={() => setClosing(null)}
                           onDone={() => { setClosing(null); showToast('Marked as left.'); refreshAll(); }} />
      )}
      {toast}
    </div>
  );
}
