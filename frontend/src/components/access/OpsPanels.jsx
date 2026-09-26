/**
 * The operational panels of Access Control: events, sync, health,
 * settings and the audit log.
 *
 * SYNC CENTER, and why it drives its own jobs. Jobs run in bounded chunks
 * because this deploys to serverless functions that end with their
 * response (see backend services/access/jobs.js). While this panel is
 * open it calls /continue on any job with more to do, so an owner who
 * starts an import and watches it sees it finish. Close the panel and
 * the job waits, safely, for the next scheduler tick or the next visit.
 * Progress is a count unless the job knows its total -- never a
 * percentage invented from nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Empty } from '../UI.jsx';
import InfoDot from '../InfoDot.jsx';
import { Pill, Label, Field, ErrorLine, Loading, When, JOB_STATUS, PROVIDER_STATE } from './shared.jsx';

/* ── events ───────────────────────────────────────────────────────── */

const EVENT_STATUS = {
  PROCESSED: { tone: 'good', label: 'Counted' },
  IGNORED_DUPLICATE: { tone: 'mute', label: 'Duplicate' },
  UNMATCHED: { tone: 'warn', label: 'Unrecognised' },
  REJECTED: { tone: 'bad', label: 'Rejected' },
  ERROR: { tone: 'bad', label: 'Error' },
  PENDING: { tone: 'mute', label: 'Pending' },
};

export function EventsPanel() {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [events, setEvents] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);

  const load = useCallback(async (before = null) => {
    const q = new URLSearchParams({ limit: '50' });
    if (status) q.set('status', status);
    if (type) q.set('type', type);
    if (before) q.set('before', before);
    const r = await api(`/admin/access/events?${q}`);
    return r;
  }, [status, type]);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    load().then((r) => { if (!cancelled) { setEvents(r.events); setNext(r.nextBefore); setError(''); } })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load events.'); });
    return () => { cancelled = true; };
  }, [load]);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await load(next);
      setEvents((xs) => [...xs, ...r.events]);
      setNext(r.nextBefore);
    } catch (e) { setError(e.message); }
    setMore(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by outcome">
          <option value="">All outcomes</option>
          {Object.entries(EVENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          <option value="ENTRY">Entries</option>
          <option value="EXIT">Exits</option>
          <option value="DENIED">Denied</option>
          <option value="UNKNOWN">Unknown direction</option>
        </select>
      </div>
      <ErrorLine>{error}</ErrorLine>
      {!events ? <Loading /> : events.length === 0 ? (
        <Empty title="No events match" hint="Every scan from a connected access system appears here, including the ones that did not change occupancy — and why." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {events.map((e, i) => {
            const s = EVENT_STATUS[e.status] || EVENT_STATUS.PENDING;
            return (
              <div key={e.id} className="p-3 flex items-start gap-3" style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-grotesk" style={{ color: 'var(--ink)' }}>
                    <span className="font-semibold">{e.member || 'Unrecognised'}</span>
                    <span style={{ color: 'var(--mute)' }}> · {e.type.toLowerCase()}</span>
                    {e.source === 'demo' && <span style={{ color: 'var(--warn)' }}> · demo</span>}
                    {e.source === 'import' && <span style={{ color: 'var(--faint)' }}> · imported</span>}
                  </div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                    <When at={e.occurredAt} /> at the door
                    {e.receivedAt && Math.abs(Date.parse(e.receivedAt) - Date.parse(e.occurredAt)) > 120000 && <> · received <When at={e.receivedAt} /></>}
                    {e.device ? ` · ${e.device}` : ''}{e.branch ? ` · ${e.branch}` : ''}
                    {!e.member && e.externalUserId ? <> · ID <span className="font-mono">{e.externalUserId}</span></> : null}
                  </div>
                  {e.error && <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--bad)' }}>{e.error}</div>}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Pill tone={s.tone}>{s.label}</Pill>
                  {e.occupancyDelta !== 0 && (
                    <span className="text-[10px] tabular-nums" style={{ color: 'var(--mute)' }}>
                      {e.occupancyDelta > 0 ? '+1 inside' : '−1 inside'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {next && (
            <div className="p-3" style={{ borderTop: '1px solid var(--line)' }}>
              <button className="btn btn-sm w-full" onClick={loadMore} disabled={more}>{more ? 'Loading…' : 'Older events'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── sync center ──────────────────────────────────────────────────── */

const JOB_TYPE = {
  event_poll: 'Poll for new events',
  historical_import: 'Import history',
  member_sync: 'Member sync',
  permission_push: 'Access update',
  health_check: 'Health check',
};

export function SyncPanel({ onToast, canManage, refreshKey }) {
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const driving = useRef(false);

  const load = useCallback(async () => {
    try { setJobs((await api('/admin/access/jobs')).jobs); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  /* Keep unfinished jobs moving while the panel is open. One request at a
     time, a short pause between chunks, and it stops on unmount. */
  useEffect(() => {
    if (!canManage || !jobs) return undefined;
    const pending = jobs.find((j) => j.hasMore || j.status === 'PENDING');
    if (!pending || driving.current) return undefined;
    let cancelled = false;
    driving.current = true;
    const t = setTimeout(async () => {
      try { await api(`/admin/access/jobs/${pending.id}/continue`, { method: 'POST' }); } catch { /* shown on next load */ }
      driving.current = false;
      if (!cancelled) load();
    }, 700);
    return () => { cancelled = true; clearTimeout(t); driving.current = false; };
  }, [jobs, canManage, load]);

  const act = async (kind, job) => {
    setBusy(kind + job.id);
    try {
      await api(`/admin/access/jobs/${job.id}/${kind}`, { method: 'POST' });
      onToast(kind === 'cancel' ? 'Stopped. Anything already imported stays.' : 'Retrying from where it stopped.');
      await load();
    } catch (e) { onToast(e.message || 'That did not work.'); }
    setBusy('');
  };

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!jobs) return <Loading />;
  if (!jobs.length) {
    return <Empty title="Nothing has synced yet" hint="Polling, history imports and CSV uploads appear here with their progress. Start one from a connection." />;
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      {jobs.map((j, i) => {
        const s = JOB_STATUS[j.status] || JOB_STATUS.PENDING;
        const pct = j.total ? Math.min(100, Math.round((j.processed / j.total) * 100)) : null;
        return (
          <div key={j.id} className="p-3" style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12.5px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>
                  {JOB_TYPE[j.type] || j.type}{j.providerName ? ` · ${j.providerName}` : ''}
                </div>
                <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                  Started <When at={j.startedAt || j.createdAt} />
                  {j.completedAt && <> · ended <When at={j.completedAt} /></>}
                  {j.retries > 0 && ` · retried ${j.retries}×`}
                </div>
              </div>
              <Pill tone={s.tone}>{s.label}</Pill>
            </div>
            {/* A bar only when the total is genuinely known. */}
            {pct != null && j.status !== 'SUCCEEDED' && (
              <div className="h-1.5 rounded-full mt-2 overflow-hidden" style={{ background: 'var(--line)' }}
                   role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
              </div>
            )}
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--mute)' }}>
              {j.processed}{j.total ? ` of ${j.total}` : ''} read
              {j.result && ` · ${j.result.accepted || 0} recorded, ${j.result.duplicates || 0} already had, ${j.result.unmatched || 0} unrecognised, ${j.result.rejected || 0} unreadable`}
            </div>
            {j.error && <div className="text-[11px] mt-1" style={{ color: 'var(--bad)' }}>{j.error}</div>}
            {canManage && (j.status === 'FAILED' || j.hasMore || j.status === 'PENDING') && (
              <div className="flex gap-1.5 mt-2">
                {j.status === 'FAILED' && <button className="btn btn-sm" onClick={() => act('retry', j)} disabled={!!busy}>Retry</button>}
                {(j.hasMore || j.status === 'PENDING') && <button className="btn btn-sm" onClick={() => act('cancel', j)} disabled={!!busy}>Stop</button>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── health ───────────────────────────────────────────────────────── */

const SEV = { critical: 'bad', warning: 'warn', info: 'info' };

export function AlertList({ alerts, onAcknowledge }) {
  if (!alerts?.length) {
    return <div className="text-[12px]" style={{ color: 'var(--good)' }}>Nothing needs attention.</div>;
  }
  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <div key={a.id} className="rounded-xl p-3" style={{ border: `1px solid var(--${SEV[a.severity] === 'bad' ? 'bad' : SEV[a.severity] === 'warn' ? 'warn' : 'line'})`, background: 'var(--bg2)' }}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12.5px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{a.title}</div>
              {a.detail && <div className="text-[11.5px] mt-0.5 leading-snug" style={{ color: 'var(--mute)' }}>{a.detail}</div>}
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--faint)' }}>
                Since <When at={a.firstSeenAt} />
                {a.status === 'ACKNOWLEDGED' && <> · acknowledged by {a.acknowledgedBy || 'someone'}</>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Pill tone={SEV[a.severity] || 'mute'}>{a.severity}</Pill>
              {a.status === 'OPEN' && onAcknowledge && (
                <button className="btn btn-sm" onClick={() => onAcknowledge(a)}>Acknowledge</button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HealthPanel({ onToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [h, a] = await Promise.all([api('/admin/access/health'), api('/admin/access/alerts')]);
      setData({ ...h, alerts: a.alerts });
      setError('');
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const ack = async (a) => {
    try { await api(`/admin/access/alerts/${a.id}/acknowledge`, { method: 'POST' }); onToast('Acknowledged. It resolves on its own once the cause is fixed.'); load(); }
    catch (e) { onToast(e.message); }
  };

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!data) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="card p-4">
        <Label right={
          <InfoDot label="alerts" title="How alerts work" size={26} align="end">
            Each alert is worked out from what is true right now — a quiet device, failed signatures, people
            still marked inside. When the cause is fixed it resolves by itself. Acknowledging means
            &ldquo;I know&rdquo;, not &ldquo;it&rsquo;s fixed&rdquo;.
          </InfoDot>
        }>Needs attention</Label>
        <AlertList alerts={data.alerts} onAcknowledge={ack} />
      </div>
      <div className="card p-4">
        <Label>Connections</Label>
        {data.providers.length === 0 ? <div className="text-[12px]" style={{ color: 'var(--mute)' }}>No connections.</div> : (
          <div className="space-y-2">
            {data.providers.map((p) => {
              const s = PROVIDER_STATE[p.state] || PROVIDER_STATE.healthy;
              return (
                <div key={p.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{p.name}</div>
                    <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>
                      Last event <When at={p.lastEventAt} fallback="never" />
                      {p.reasons?.length ? ` · ${p.reasons.join(' ')}` : ''}
                    </div>
                  </div>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="card p-4">
        <Label>Devices</Label>
        {data.devices.length === 0 ? <div className="text-[12px]" style={{ color: 'var(--mute)' }}>No devices.</div> : (
          <div className="space-y-1.5">
            {data.devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 text-[12px]">
                <span style={{ color: 'var(--ink)' }}>{d.name}</span>
                <span style={{ color: d.online ? 'var(--good)' : 'var(--mute)' }}>
                  {d.status === 'DISABLED' ? 'Disabled' : d.online ? 'Online' : d.lastSeenAt ? <>Last seen <When at={d.lastSeenAt} /></> : 'Never seen'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── settings ─────────────────────────────────────────────────────── */

export function SettingsPanel({ onToast, canEdit }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/admin/access/settings').then((r) => { setS(r.settings); setSaved(r.settings); }).catch((e) => setError(e.message));
  }, []);

  if (error && !s) return <ErrorLine>{error}</ErrorLine>;
  if (!s) return <Loading />;

  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));
  const flag = (k) => (e) => set(k, e.target.checked ? 1 : 0);
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { ...s };
      if (body.crowd_capacity === '') body.crowd_capacity = null;
      for (const k of ['crowd_open_time', 'crowd_close_time']) if (!body[k]) body[k] = null;
      const r = await api('/admin/access/settings', { method: 'PUT', body: JSON.stringify(body) });
      setS(r.settings); setSaved(r.settings);
      onToast('Settings saved.');
    } catch (e) { setError(e.message || 'Could not save.'); }
    setBusy(false);
  };

  const Toggle = ({ k, label, help }) => (
    <label className="flex items-start gap-3 py-1.5" style={{ minHeight: 36 }}>
      <input type="checkbox" className="mt-1" checked={!!s[k]} onChange={flag(k)} disabled={!canEdit} />
      <span>
        <span className="block text-[12.5px]" style={{ color: 'var(--ink)' }}>{label}</span>
        {help && <span className="block text-[11px] leading-snug" style={{ color: 'var(--faint)' }}>{help}</span>}
      </span>
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="card p-4 space-y-3">
        <Label>Crowd</Label>
        <Toggle k="crowd_enabled" label="Track how busy the gym is" help="Off stops the crowd everywhere — members, trainers and this dashboard." />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Capacity" help="People the gym holds. Leave blank and no percentage is shown anywhere — only the head-count.">
            <input className="input" type="number" min="1" value={s.crowd_capacity ?? ''} onChange={num('crowd_capacity')} disabled={!canEdit} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Opens"><input className="input" type="time" value={s.crowd_open_time || ''} onChange={(e) => set('crowd_open_time', e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Closes"><input className="input" type="time" value={s.crowd_close_time || ''} onChange={(e) => set('crowd_close_time', e.target.value)} disabled={!canEdit} /></Field>
          </div>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
          Leave hours blank for a 24-hour gym. Set both or neither; members see &ldquo;Gym closed&rdquo; outside them.
        </div>
        <div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>Crowd levels (% of capacity)</span>
            <InfoDot label="crowd levels" title="What these mean" size={26}>
              Up to Quiet is quiet; up to Moderately busy is moderate; up to Busy is busy; above that is very busy,
              and over 100% is at capacity. They must rise in that order.
            </InfoDot>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-1">
            <Field label="Quiet up to"><input className="input" type="number" min="1" max="99" value={s.crowd_threshold_quiet} onChange={num('crowd_threshold_quiet')} disabled={!canEdit} /></Field>
            <Field label="Moderate up to"><input className="input" type="number" min="1" max="99" value={s.crowd_threshold_moderate} onChange={num('crowd_threshold_moderate')} disabled={!canEdit} /></Field>
            <Field label="Busy up to"><input className="input" type="number" min="1" max="99" value={s.crowd_threshold_busy} onChange={num('crowd_threshold_busy')} disabled={!canEdit} /></Field>
          </div>
        </div>
      </div>

      <div className="card p-4 space-y-1">
        <Label>Who sees it</Label>
        <Toggle k="crowd_client_visible" label="Members see the crowd card" />
        <Toggle k="crowd_show_exact_count" label="Members see the exact number of people"
                help="Off shows how busy it is without the head-count. Enforced on the server — the number is not sent to their phone at all." />
        <Toggle k="crowd_trainer_visible" label="Trainers see the crowd and which of their clients are in" />
      </div>

      <div className="card p-4 space-y-3">
        <Label>Access</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Close forgotten sessions after (hours)" help="People who never scanned out stop counting after this. Their exit time is recorded as unknown, not guessed.">
            <input className="input" type="number" min="1" max="72" value={s.access_auto_close_hours} onChange={num('access_auto_close_hours')} disabled={!canEdit} />
          </Field>
          <Field label="Grace after a membership ends (days)" help="Door access continues this long after the end date before it should be removed.">
            <input className="input" type="number" min="0" max="60" value={s.access_grace_days} onChange={num('access_grace_days')} disabled={!canEdit} />
          </Field>
        </div>
        <Toggle k="access_sync_enabled" label="Update door access automatically when memberships change"
                help="Only works with connections that accept access updates. Off: SK OS shows who should be removed and leaves it to you." />
      </div>

      <ErrorLine>{error}</ErrorLine>
      {canEdit ? (
        <button className="btn btn-primary w-full" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}</button>
      ) : (
        <div className="text-[11.5px]" style={{ color: 'var(--faint)' }}>Only the gym owner can change these.</div>
      )}
    </div>
  );
}

/* ── audit ────────────────────────────────────────────────────────── */

export function AuditPanel() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/admin/access/audit?limit=100').then((a) => setEntries(a.entries || [])).catch((e) => setError(e.message));
  }, []);
  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!entries) return <Loading />;
  if (!entries.length) return <Empty title="Nothing recorded yet" hint="Connections, device changes, mappings, overrides, corrections and settings changes all appear here." />;
  return (
    <div className="card" style={{ padding: 0 }}>
      {entries.map((a, i) => (
        <div key={a.id} className="p-3" style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12.5px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>
              {a.action.replace(/^access\./, '').replace(/[._]/g, ' ')}
            </span>
            <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--faint)' }}><When at={a.at} /></span>
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: a.result === 'FAILED' ? 'var(--bad)' : 'var(--mute)' }}>
            {a.actor}{a.actorRole ? ` · ${a.actorRole.toLowerCase()}` : ''}{a.reason ? ` · ${a.reason}` : ''}{a.result === 'FAILED' ? ' · failed' : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
