// ============================================================
// AI COMMUNICATION -- ONE GYM (founder). Balances, caller numbers, the
// gym's WhatsApp sender, support adjustments, and its recent ledger and
// orders. Backed by /api/console/communication/gyms/:orgId and friends
// (backend/src/routes/consoleFollowups.js); every write is audited there.
//
// Caller numbers follow docs/FOLLOWUPS.md "One recognisable number": a
// gym calls from its own registered business line (or the platform's).
// A number is retired or flagged, never swapped in to get past a member
// who blocked the gym -- the engine keeps each member on one number and
// suppression is per gym across every number.
// ============================================================
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, moneyExact, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { SkeletonBlock } from '../components/Skeleton.jsx';
import { unitLabel, UsageReport } from './Communication.jsx';

const REASON_LABEL = { purchase: 'Purchase', trial: 'Free trial', adjustment: 'Adjustment', hold: 'Held for a call', release: 'Hold released', usage: 'Used', refund: 'Refunded' };
const ORDER_TONE = { SUCCESS: 'good', PENDING: 'warn', CREATED: 'warn', FAILED: 'bad', CANCELLED: 'mute' };
const OWNER_ACTION = {
  settings_updated: 'Changed settings', switched_on: 'Switched automations on', switched_off: 'Switched automations off',
  compliance_confirmed: 'Confirmed the compliance checklist', campaign_created: 'Created a campaign', campaign_updated: 'Edited a campaign',
  campaign_started: 'Started a campaign', campaign_paused: 'Paused a campaign', campaign_deleted: 'Deleted a campaign', number_updated: 'Relabelled a caller number',
};

/** "max_per_day: 2 → 3 · window_end: 19:30 → 20:00" -- the keys that changed. */
function ChangeSummary({ before, after }) {
  const keys = [...new Set([...Object.keys(after || {}), ...Object.keys(before || {})])].filter((k) => !['by', 'at', 'version'].includes(k)).slice(0, 8);
  const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));
  if (!keys.length) return <span>—</span>;
  return <span>{keys.map((k) => (before && k in before ? `${k}: ${show(before[k])} → ${show(after?.[k])}` : `${k}: ${show(after?.[k] ?? before?.[k])}`)).join(' · ')}</span>;
}

export default function CommunicationGym() {
  const { orgId } = useParams();
  const toast = useToast();
  const gym = useFetch(() => api(`/console/communication/gyms/${orgId}`), [orgId]);
  const pricing = useFetch(() => api('/console/communication/pricing'));
  const book = pricing.data?.book;

  const [num, setNum] = useState({ number: '', label: '', number_type: '', agent_phone_id: '', is_primary: false });
  const [wa, setWa] = useState(null);
  const [adj, setAdj] = useState({ unit: '', delta: '', reason: '' });
  const [confirm, setConfirm] = useState(null);   // { kind, ... }
  const [busy, setBusy] = useState(false);

  if (gym.loading) return <div className="card"><SkeletonBlock height={360} /></div>;
  if (gym.error) return <div className="error-text">{gym.error.message}</div>;
  const d = gym.data;
  const sender = wa ?? (d.settings?.whatsapp_from || '');
  const units = Object.keys(d.wallet || {});

  const run = async (fn, okText) => {
    setBusy(true);
    try { await fn(); toast.success(okText); setConfirm(null); gym.reload({ silent: true }); return true; }
    catch (e) { toast.error(e.message || 'Could not save'); return false; }
    finally { setBusy(false); }
  };

  const assign = async (e) => {
    e.preventDefault();
    const body = { number: num.number.trim(), is_primary: num.is_primary };
    for (const k of ['label', 'number_type', 'agent_phone_id']) if (num[k].trim()) body[k] = num[k].trim();
    const ok = await run(() => api(`/console/communication/gyms/${orgId}/numbers`, { method: 'POST', body: JSON.stringify(body) }), `${body.number} assigned to ${d.gym.name}`);
    if (ok) setNum({ number: '', label: '', number_type: '', agent_phone_id: '', is_primary: false });
  };

  const updateNumber = (n, patch, okText) => run(() => api(`/console/communication/numbers/${n.id}`, { method: 'PUT', body: JSON.stringify(patch) }), okText);

  const saveSender = () => run(() => api(`/console/communication/gyms/${orgId}/whatsapp`, { method: 'PUT', body: JSON.stringify({ whatsapp_from: sender.trim() || null }) }), sender.trim() ? 'WhatsApp sender saved' : 'WhatsApp sender cleared: the platform sender is used');

  const adjust = async () => {
    const ok = await run(() => api(`/console/communication/gyms/${orgId}/adjust`, { method: 'POST', body: JSON.stringify({ unit: adj.unit, delta: Number(adj.delta), reason: adj.reason.trim() }) }),
      `${Number(adj.delta) > 0 ? 'Added' : 'Removed'} ${Math.abs(Number(adj.delta))} ${unitLabel(adj.unit, book)}`);
    if (ok) setAdj({ unit: '', delta: '', reason: '' });
  };
  const adjValid = adj.unit && Number.isInteger(Number(adj.delta)) && Number(adj.delta) !== 0 && adj.reason.trim().length >= 5;

  return (
    <div>
      <div className="page-header page-header-row">
        <div>
          <p className="faint" style={{ margin: '0 0 4px' }}><Link to="/communication">AI Communication</Link> / Gym</p>
          <h1>{d.gym.name}</h1>
          <p>
            {d.settings ? <span className={`badge ${Number(d.settings.enabled) ? 'good' : 'mute'}`}>{Number(d.settings.enabled) ? 'Automations on' : 'Automations off'}</span> : <span className="badge mute">Not set up by the owner yet</span>}
            {d.lines.lines > 0 && <span className="faint" style={{ marginLeft: 10 }}>{d.lines.lines} paid caller line{d.lines.lines === 1 ? '' : 's'} until {formatDateTime(d.lines.until).slice(0, 10)}</span>}
          </p>
        </div>
        <div className="actions"><Link className="btn ghost" to={`/gyms/${orgId}`}>Gym record</Link></div>
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Balances</h2>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Product</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {units.map((u) => (
                  <tr key={u}><td>{unitLabel(u, book)}</td><td className="num">{Number(d.wallet[u]).toLocaleString('en-IN')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>Adjust a balance</h2>
          <p className="faint" style={{ marginTop: -8 }}>Support credit, goodwill, or a correction. Free units carry no value, so they are never counted as revenue. Recorded in the ledger and the audit log with your reason.</p>
          <div className="form-grid-2" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor="adj-unit">Product</label>
              <select id="adj-unit" className="input" value={adj.unit} onChange={(e) => setAdj({ ...adj, unit: e.target.value })}>
                <option value="">Choose…</option>
                {units.map((u) => <option key={u} value={u}>{unitLabel(u, book)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="adj-delta">Units (negative to remove)</label>
              <input id="adj-delta" className="input" type="number" step="1" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} placeholder="e.g. 20" />
            </div>
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="adj-reason">Reason</label>
            <input id="adj-reason" className="input" maxLength={200} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="e.g. Calls failed during the 9 Nov Exotel outage" />
          </div>
          <button className="btn" disabled={!adjValid || busy} onClick={() => setConfirm({ kind: 'adjust' })}>Adjust</button>
        </div>
      </div>

      <div className="card">
        <h2>Caller numbers</h2>
        <p className="faint" style={{ marginTop: -8 }}>The registered business lines this gym calls from. Each member always hears from the same one. Retire a number the gym no longer uses, or flag one the operator reports a fault on; it stops being used and its members move to another of the gym's lines on their next call. Never add or swap a number to reach a member who blocked or ignored the gym: a member who stopped calls is suppressed on every number.</p>
        {d.numbers.length === 0 && <p className="faint">No number assigned. {d.lines.lines > 0 ? 'The gym has paid for a line: assign one below.' : 'The gym calls from the platform line, if one is set.'}</p>}
        {d.numbers.length > 0 && (
          <div className="table-scroll" style={{ marginBottom: 14 }}>
            <table>
              <thead><tr><th>Number</th><th>Label</th><th>Type</th><th>ElevenLabs id</th><th>State</th><th /></tr></thead>
              <tbody>
                {d.numbers.map((n) => (
                  <tr key={n.id}>
                    <td><span className="code-chip">{n.number}</span>{Number(n.is_primary) ? <span className="badge good" style={{ marginLeft: 6 }}>Primary</span> : null}</td>
                    <td className="faint">{n.label || '—'}</td>
                    <td className="faint">{n.number_type || '—'}</td>
                    <td className="faint">{n.agent_phone_id || '—'}</td>
                    <td>
                      <span className={`badge ${n.status === 'retired' ? 'mute' : n.health === 'flagged' ? 'bad' : 'good'}`}>{n.status === 'retired' ? 'Retired' : n.health === 'flagged' ? 'Flagged' : 'Active'}</span>
                    </td>
                    <td>
                      {n.status === 'active' && (
                        <div className="row-actions">
                          {n.health === 'flagged'
                            ? <button className="btn ghost sm" disabled={busy} onClick={() => updateNumber(n, { health: 'ok' }, `${n.number} cleared`)}>Clear flag</button>
                            : <button className="btn ghost sm" disabled={busy} onClick={() => setConfirm({ kind: 'flag', n })}>Flag</button>}
                          <button className="btn ghost sm" disabled={busy} onClick={() => setConfirm({ kind: 'retire', n })}>Retire</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form onSubmit={assign}>
          <div className="form-grid-4" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor="n-number">Number</label>
              <input id="n-number" className="input" required value={num.number} onChange={(e) => setNum({ ...num, number: e.target.value })} placeholder="+91 80 4718 xxxx" />
            </div>
            <div className="field">
              <label htmlFor="n-label">Label</label>
              <input id="n-label" className="input" maxLength={40} value={num.label} onChange={(e) => setNum({ ...num, label: e.target.value })} placeholder="e.g. Indiranagar desk" />
            </div>
            <div className="field">
              <label htmlFor="n-type">Series / type</label>
              <input id="n-type" className="input" maxLength={30} value={num.number_type} onChange={(e) => setNum({ ...num, number_type: e.target.value })} placeholder="e.g. 140-series" />
            </div>
            <div className="field">
              <label htmlFor="n-agent">ElevenLabs phone id</label>
              <input id="n-agent" className="input" maxLength={80} value={num.agent_phone_id} onChange={(e) => setNum({ ...num, agent_phone_id: e.target.value })} placeholder="For AI conversations" />
            </div>
          </div>
          <div className="form-actions">
            <label className="switch" htmlFor="n-primary">
              <input id="n-primary" type="checkbox" aria-label="Primary line" checked={num.is_primary} onChange={(e) => setNum({ ...num, is_primary: e.target.checked })} />
              <span className="track" />
            </label>
            <span>Primary line</span>
            <button className="btn" type="submit" disabled={busy || num.number.trim().length < 6} style={{ marginLeft: 'auto' }}>Assign number</button>
          </div>
          <div className="notice info">Use a registered commercial series (as Exotel advises for automated calls). Under TRAI's 2024-25 directions, ordinary 10-digit mobile numbers must not be used for business robocalls.</div>
        </form>
      </div>

      <div className="card">
        <h2>WhatsApp sender</h2>
        <p className="faint" style={{ marginTop: -8 }}>The gym's own approved WhatsApp Business number. Leave empty to send from the platform's sender (EXOTEL_WHATSAPP_FROM).</p>
        <div className="inline-row">
          <input className="input" aria-label="WhatsApp sender number" value={sender} onChange={(e) => setWa(e.target.value)} placeholder="+91…" />
          <button className="btn" disabled={busy || sender === (d.settings?.whatsapp_from || '')} onClick={saveSender}>Save</button>
        </div>
      </div>

      <div className="card">
        <h2>Ledger</h2>
        <p className="faint" style={{ marginTop: -8 }}>The latest 100 movements. Value is what the gym paid for those units; cost is the platform's estimate from the price book version shown.</p>
        {d.ledger.length === 0 ? <p className="faint">Nothing yet.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Product</th><th>Movement</th><th className="num">Units</th><th className="num">Value</th><th className="num">Cost</th><th>Price book</th><th>Note</th></tr></thead>
              <tbody>
                {d.ledger.map((l, i) => (
                  <tr key={i}>
                    <td className="faint">{formatDateTime(l.created_at)}</td>
                    <td>{unitLabel(l.unit, book)}</td>
                    <td>{REASON_LABEL[l.reason] || l.reason}</td>
                    <td className="num" style={{ color: Number(l.delta) < 0 ? 'var(--bad)' : undefined }}>{Number(l.delta) > 0 ? '+' : ''}{Number(l.delta)}</td>
                    <td className="num">{moneyExact(l.charge_inr)}</td>
                    <td className="num">{l.cost_estimate == null ? '—' : moneyExact(l.cost_estimate)}</td>
                    <td className="faint">{l.pricing_version == null ? '—' : `v${l.pricing_version}`}</td>
                    <td className="faint">{l.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Orders</h2>
        {d.orders.length === 0 ? <p className="faint">No purchases yet.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Pack</th><th className="num">Qty</th><th className="num">Amount</th><th className="num">Tax</th><th>Price book</th><th>Status</th><th>Invoice</th></tr></thead>
              <tbody>
                {d.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="faint">{formatDateTime(o.created_at)}</td>
                    <td>{o.pack_id}</td>
                    <td className="num">{o.quantity}</td>
                    <td className="num">{moneyExact(o.amount)}</td>
                    <td className="num">{moneyExact(o.tax_amount)}</td>
                    <td className="faint">v{o.pricing_version}</td>
                    <td><span className={`badge ${ORDER_TONE[o.status] || 'mute'}`}>{o.status}</span></td>
                    <td className="faint">{o.invoice_number || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.usage && (
        <div style={{ marginBottom: 16 }}>
          <h2>This month by calling mode</h2>
          <UsageReport report={d.usage} showGyms={false} />
        </div>
      )}

      <div className="card">
        <h2>Owner changes</h2>
        <p className="faint" style={{ marginTop: -8 }}>Settings, the compliance checklist, campaigns and number labels, as changed by the gym. Consent changes are in each member's consent history.</p>
        {!(d.owner_changes || []).length ? <p className="faint">No changes recorded yet.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Changed</th></tr></thead>
              <tbody>
                {d.owner_changes.map((c, i) => (
                  <tr key={i}>
                    <td className="faint">{formatDateTime(c.created_at)}</td>
                    <td>{c.actor_name || '—'}<div className="faint">{c.actor_role || ''}</div></td>
                    <td>{OWNER_ACTION[c.action] || c.action}</td>
                    <td className="faint" style={{ maxWidth: 420 }}><ChangeSummary before={c.before} after={c.after} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        danger={confirm?.kind !== 'adjust' || Number(adj.delta) < 0}
        title={confirm?.kind === 'adjust' ? `${Number(adj.delta) > 0 ? 'Add' : 'Remove'} ${Math.abs(Number(adj.delta))} ${unitLabel(adj.unit, book)}?`
          : confirm?.kind === 'retire' ? `Retire ${confirm.n.number}?` : `Flag ${confirm?.n?.number}?`}
        description={confirm?.kind === 'adjust' ? `For ${d.gym.name}. Reason recorded: “${adj.reason.trim()}”.`
          : confirm?.kind === 'retire' ? 'The gym stops calling from it. Its members are moved to another of the gym’s lines on their next call. This cannot be undone here; assign it again if needed.'
            : 'For a fault the operator reports on this line. It stops being used until you clear the flag, and its members move to another of the gym’s lines on their next call.'}
        confirmLabel={confirm?.kind === 'adjust' ? 'Confirm adjustment' : confirm?.kind === 'retire' ? 'Retire number' : 'Flag number'}
        busy={busy}
        onConfirm={() => (confirm.kind === 'adjust' ? adjust()
          : confirm.kind === 'retire' ? updateNumber(confirm.n, { status: 'retired' }, `${confirm.n.number} retired`)
            : updateNumber(confirm.n, { health: 'flagged' }, `${confirm.n.number} flagged`))}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
