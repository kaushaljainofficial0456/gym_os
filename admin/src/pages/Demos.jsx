/**
 * DEMO MANAGEMENT — the founder's whole demo workflow on one screen.
 *
 * Step 1  a prospect's request lands here as PENDING
 * Step 2  the founder reads it and presses Approve
 * Step 3  a link appears, once — Copy, then WhatsApp it to them
 * Step 4  the row goes live and shows a countdown, last activity, and
 *         what they have actually looked at
 * Step 5  Revoke, or Reset the tenant afterwards
 *
 * THE LINK IS SHOWN EXACTLY ONCE. Only its SHA-256 is stored (see
 * backend/src/services/demo/session.js), so there is nothing to come back
 * for later — losing it means pressing Re-issue, which mints a new one and
 * kills the old. That is deliberate: a console that could re-display a
 * live access token would be a credential store.
 */
import { useState } from 'react';
import { api } from '../api.js';
import { useFetch, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import StatCard from '../components/StatCard.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

const STATUS_TONE = {
  pending: 'warn', approved: 'mute', active: 'good',
  completed: 'good', expired: 'mute', rejected: 'bad', revoked: 'bad',
};

/** mm:ss from a millisecond span. */
function duration(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export default function Demos() {
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(null);
  // The one-time link, held in component state only. Never written to
  // storage, and gone the moment this page unmounts.
  const [issued, setIssued] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const list = useFetch(() => api(`/console/demos${filter ? `?status=${filter}` : ''}`), [filter]);
  const overview = useFetch(() => api('/console/demos/overview'), []);
  const detail = useFetch(
    () => (expanded ? api(`/console/demos/${expanded}`) : Promise.resolve(null)), [expanded]);

  const refresh = () => { list.reload({ silent: true }); overview.reload({ silent: true }); };

  const act = async (demoId, action, body, successMsg) => {
    setBusy(`${demoId}:${action}`);
    try {
      const res = await api(`/console/demos/${demoId}/${action}`, {
        method: 'POST', body: JSON.stringify(body || {}),
      });
      if (res.demoLink) setIssued({ demoId, link: res.demoLink, restarted: res.restarted, emailed: res.emailed });
      toast.success(successMsg);
      refresh();
      if (expanded === demoId) detail.reload({ silent: true });
    } catch (e) {
      toast.error(e.message || 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  const resetTenant = async () => {
    setBusy('tenant:reset');
    try {
      const res = await api('/console/demos/tenant/reset', { method: 'POST' });
      toast.success(`Demo data reset — ${res.counts.members} members, ${res.counts.workouts} workouts rebuilt`);
      overview.reload({ silent: true });
    } catch (e) {
      toast.error(e.message || 'Reset failed');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const copy = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Demo link copied — send it on WhatsApp');
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down
      // browser). The link is on screen and selectable either way, so this
      // says so rather than pretending the copy worked.
      toast.error('Could not copy automatically — select the link and copy it');
    }
  };

  const o = overview.data;
  const tenant = o?.tenant;

  return (
    <div>
      <div className="page-header">
        <h1>Demo Management</h1>
        <p>Approve a demo, send the link, and watch what the prospect actually does with it.</p>
      </div>

      {/* ---- the numbers ---- */}
      {overview.loading && <div className="card"><SkeletonRows rows={2} cols={5} /></div>}
      {o && (
        <>
          <div className="stat-grid">
            <StatCard icon="inbox" label="Total requests" value={o.totalRequests} />
            <StatCard icon="clock" label="Pending" value={o.pending}
              description={o.pending > 0 ? 'Waiting on you' : 'Nothing to review'} />
            <StatCard icon="bolt" label="Active now" value={o.activeNow}
              description={o.activeNow > 0 ? 'Someone is in the product' : 'No demo running'} />
            <StatCard icon="check" label="Completed" value={o.completed} />
            <StatCard icon="trend" label="Expired" value={o.expired} />
            {/* A string, not a number: StatCard renders non-numeric values
                as-is rather than animating a fake count -- and "0m 00s"
                with no demos yet would be a fabricated average. */}
            <StatCard icon="users" label="Avg. demo used"
              value={o.averageUsedMs ? duration(o.averageUsedMs) : 'No data yet'} />
          </div>

          {/* ---- conversion signals ---- */}
          {o.featureRanking.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2 style={{ fontSize: 13, marginBottom: 10 }}>Most-viewed features</h2>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {o.featureRanking.slice(0, 6).map((f, i) => (
                  <span key={f.type} className="badge mute">
                    {i + 1}. {f.label} · {f.views}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ---- the demo tenant itself ---- */}
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <h2 style={{ fontSize: 13, marginBottom: 4 }}>Demo tenant</h2>
                {tenant?.exists ? (
                  <p className="faint" style={{ fontSize: 12 }}>
                    {tenant.name} · {tenant.memberCount} members. Resetting restores the canonical seed.
                  </p>
                ) : (
                  <p className="faint" style={{ fontSize: 12 }}>
                    Not created yet. Run <code>npm run seed:demo</code> once before approving any demo.
                  </p>
                )}
              </div>
              {tenant?.exists && (
                <button
                  className="btn ghost"
                  disabled={busy === 'tenant:reset'}
                  onClick={() => setConfirm({
                    title: 'Reset demo data?',
                    description: `This rebuilds ${tenant.name} from the canonical seed. Anything a prospect changed is discarded. It is refused while a demo is running.`,
                    confirmLabel: 'Reset demo data',
                    onConfirm: resetTenant,
                  })}
                >
                  {busy === 'tenant:reset' ? 'Resetting…' : 'Reset demo data'}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ---- the one-time link ---- */}
      {issued && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--good, #2f855a)' }}>
          <h2 style={{ fontSize: 13, marginBottom: 6 }}>
            {issued.restarted ? 'New demo link issued' : 'Demo link ready'}
          </h2>
          <p className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
            Copy it now — this is the only time it is shown. If it is lost, use Re-issue,
            which replaces it and stops the old one working.
          </p>
          {/* Whether the prospect already has it. Said explicitly either
              way: "we emailed it" and "email is off, you need to send
              this" are different jobs for the founder, and guessing
              wrong means either a duplicate or a prospect left waiting. */}
          <p style={{ fontSize: 12, marginBottom: 10, color: issued.emailed?.ok ? 'inherit' : 'var(--warn, #b7791f)' }}>
            {issued.emailed?.ok
              ? 'Emailed to the prospect — send it on WhatsApp too if you like.'
              : 'Not emailed (email is not configured on this deployment) — send this link to them yourself.'}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <code style={{ flex: 1, minWidth: 260, wordBreak: 'break-all', fontSize: 12 }}>{issued.link}</code>
            <button className="btn" onClick={() => copy(issued.link)}>Copy demo link</button>
            <button className="btn ghost" onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      )}

      {/* ---- the queue ---- */}
      <div className="search-row" style={{ justifyContent: 'flex-start', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {[['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['completed', 'Completed'],
          ['expired', 'Expired'], ['rejected', 'Rejected'], ['revoked', 'Revoked']].map(([v, label]) => (
          <button key={v || 'all'} className={`btn ${filter === v ? '' : 'ghost'}`} onClick={() => setFilter(v)}>
            {label}
          </button>
        ))}
      </div>

      {list.loading && <div className="card"><SkeletonRows rows={5} cols={5} /></div>}
      {list.error && <div className="error-text">{list.error.message}</div>}
      {list.data && !list.data.demos.length && (
        <div className="card">
          <EmptyState
            icon="inbox"
            title={filter ? `No ${filter} demos` : 'No demo requests yet'}
            description="Requests submitted at /demo appear here for approval."
          />
        </div>
      )}

      {list.data?.demos.map((d) => (
        <DemoCard
          key={d.id}
          demo={d}
          busy={busy}
          expanded={expanded === d.id}
          detail={expanded === d.id ? detail.data : null}
          onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
          onAct={act}
          onConfirm={setConfirm}
        />
      ))}

      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger !== false}
          busy={!!busy}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function DemoCard({ demo: d, busy, expanded, detail, onToggle, onAct, onConfirm }) {
  const s = d.session;
  const live = s?.state === 'active';
  const isBusy = (action) => busy === `${d.id}:${action}`;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{d.ownerName}</strong>
            <span className="faint">·</span>
            <span>{d.gymName}</span>
            <span className={`badge ${STATUS_TONE[live ? 'active' : d.status] || 'mute'}`}>
              {(live ? 'ACTIVE' : d.status).toUpperCase()}
            </span>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            {d.phone} · {d.email}
            {d.city ? ` · ${d.city}` : ''}
            {d.memberCount != null ? ` · ${d.memberCount} members` : ''}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
            Requested {formatDateTime(d.requestedAt)}
            {d.reviewedByName ? ` · reviewed by ${d.reviewedByName}` : ''}
            {d.approvedAt ? ` · approved ${formatDateTime(d.approvedAt)}` : ''}
          </div>
          {d.message && (
            <p style={{ fontSize: 12, marginTop: 8, fontStyle: 'italic' }}>“{d.message}”</p>
          )}
          {d.rejectReason && (
            <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Rejected: {d.rejectReason}</p>
          )}
        </div>

        {/* ---- the live session's state ---- */}
        {s && (
          <div style={{ minWidth: 190, fontSize: 12 }}>
            <Row label="Started" value={formatDateTime(s.startedAt)} />
            <Row label="Expires" value={formatDateTime(s.expiresAt)} />
            <Row label="Last activity" value={formatDateTime(s.lastActivityAt)} />
            <Row
              label={live ? 'Time remaining' : 'Duration used'}
              value={live ? duration(s.remainingMs) : duration(s.usedMs)}
            />
          </div>
        )}
      </div>

      {/* ---- the founder's controls ---- */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {d.status === 'pending' && (
          <>
            <button className="btn" disabled={!!busy}
              onClick={() => onAct(d.id, 'approve', {}, `Demo approved for ${d.ownerName}`)}>
              {isBusy('approve') ? 'Approving…' : 'Approve demo'}
            </button>
            <button className="btn ghost" disabled={!!busy}
              onClick={() => onConfirm({
                title: `Reject ${d.ownerName}'s request?`,
                description: `${d.gymName} will not get a demo link. You can approve a fresh request from them later.`,
                confirmLabel: 'Reject',
                onConfirm: () => onAct(d.id, 'reject', {}, 'Request rejected'),
              })}>
              Reject
            </button>
          </>
        )}

        {d.status !== 'pending' && d.status !== 'rejected' && (
          <button className="btn ghost" disabled={!!busy}
            onClick={() => onAct(d.id, 'reissue', {},
              s?.startedAt ? 'New demo session created' : 'New demo link issued')}>
            {isBusy('reissue') ? 'Issuing…' : s?.startedAt ? 'Grant another demo' : 'Re-issue link'}
          </button>
        )}

        {s && ['approved', 'active'].includes(s.state) && (
          <button className="btn danger" disabled={!!busy}
            onClick={() => onConfirm({
              title: live ? `Revoke ${d.ownerName}'s running demo?` : 'Revoke this demo link?',
              description: live
                ? 'They will be locked out on their very next click and sent to the closing screen.'
                : 'The link stops working immediately.',
              confirmLabel: 'Revoke',
              onConfirm: () => onAct(d.id, 'revoke', {}, 'Demo revoked'),
            })}>
            {isBusy('revoke') ? 'Revoking…' : 'Revoke'}
          </button>
        )}

        <button className="btn ghost" onClick={onToggle} style={{ marginLeft: 'auto' }}>
          {expanded ? 'Hide activity' : 'View activity'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line, #2a2a2a)' }}>
          {!detail && <SkeletonRows rows={3} cols={2} />}
          {detail && (
            <>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, marginBottom: 12 }}>
                <span>Member view: <strong>{detail.memberViewUsed ? 'Yes' : 'No'}</strong></span>
                <span>Trainer view: <strong>{detail.trainerViewUsed ? 'Yes' : 'No'}</strong></span>
                <span>Sessions granted: <strong>{detail.sessionHistory.length}</strong></span>
              </div>

              <div style={{ fontSize: 12, marginBottom: 6 }}>Features visited</div>
              {detail.featuresVisited.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {detail.featuresVisited.map((f) => <span key={f} className="badge mute">{f}</span>)}
                </div>
              ) : (
                <p className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
                  Nothing yet — they have not opened the demo, or have not moved past the first screen.
                </p>
              )}

              <div style={{ fontSize: 12, marginBottom: 6 }}>Activity</div>
              {detail.events.length ? (
                <div className="table-scroll" style={{ maxHeight: 260 }}>
                  <table>
                    <thead><tr><th>When</th><th>Event</th></tr></thead>
                    <tbody>
                      {detail.events.slice().reverse().map((e, i) => (
                        <tr key={`${e.at}-${i}`}>
                          <td className="faint">{formatDateTime(e.at)}</td>
                          <td>{e.type.replace(/_/g, ' ')}{e.data?.cta ? ` — ${e.data.cta.replace(/_/g, ' ')}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="faint" style={{ fontSize: 12 }}>No activity recorded.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span className="faint">{label}</span>
      <span>{value}</span>
    </div>
  );
}
