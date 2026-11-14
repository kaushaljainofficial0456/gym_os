// ============================================================
// AI COMMUNICATION -- the founder's side of the follow-ups add-on
// (docs/FOLLOWUPS.md). Three tabs over /api/console/communication
// (backend/src/routes/consoleFollowups.js):
//
//   Gyms        per gym: balances, unearned value, usage revenue, provider
//               cost and contribution; opens one gym (numbers, sender,
//               adjustments, ledger)
//   Price book  the versioned price book: real provider costs, margin, tax,
//               quality tiers and packs, with every pack's cost and markup
//               recomputed as you type. Saving writes a NEW version;
//               orders keep the version they were sold at.
//   Setup       which providers this server has, the webhook URLs to paste
//               into Exotel / ElevenLabs / the scheduler, and the platform
//               switch that pauses outbound contact everywhere.
//
// Every write goes through the console router's SUPER_ADMIN gate and is
// audited there; nothing on this page computes a balance or a charge of
// its own -- the pack economics below are a live PREVIEW of the server's
// formula, and the saved book is always re-evaluated by the server.
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useFetch, moneyExact, formatDateTime } from '../utils.js';
import { useToast } from '../components/Toast.jsx';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { SkeletonRows, SkeletonCards, SkeletonBlock } from '../components/Skeleton.jsx';

const TABS = [
  { id: 'gyms', label: 'Gyms' },
  { id: 'ops', label: 'Operations' },
  { id: 'pricing', label: 'Price book' },
  { id: 'setup', label: 'Setup' },
];

export const MODE_TONE = { live: 'good', test: 'warn', off: 'bad' };
export const MODE_LABEL = { live: 'Live', test: 'Test mode (simulated)', off: 'Off (nothing is sent)' };

/** "voice:premium" -> "Premium voice", using the price book's own tier names. */
export function unitLabel(unit, book) {
  const [product, tier] = String(unit).split(':');
  if (product === 'sms') return 'SMS';
  if (product === 'whatsapp') return 'WhatsApp';
  const t = (book?.tiers?.[product] || []).find((x) => x.id === tier);
  const name = t?.name || (tier ? tier[0].toUpperCase() + tier.slice(1) : '');
  return product === 'voice' ? `${name} voice` : product === 'agent' ? `${name} AI conversation` : unit;
}

export default function Communication() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'gyms';
  const setup = useFetch(() => api('/console/communication/setup'));
  const mode = setup.data?.status?.mode;

  return (
    <div>
      <div className="page-header page-header-row">
        <div>
          <h1>AI Communication</h1>
          <p>Automated follow-up calls, AI conversations, SMS and WhatsApp that gyms buy as an add-on. Set the real provider costs here, watch each gym's usage and margin, and assign caller numbers.</p>
        </div>
        <div className="actions">
          {mode && <span className={`badge ${MODE_TONE[mode] || 'mute'}`} title="How this server sends calls and messages">{MODE_LABEL[mode] || mode}</span>}
        </div>
      </div>

      <div className="seg" role="tablist" aria-label="AI Communication sections" style={{ marginBottom: 18 }}>
        {TABS.map((t) => (
          <label key={t.id}>
            <input type="radio" name="comm-tab" role="tab" aria-selected={tab === t.id} checked={tab === t.id}
              onChange={() => setParams(t.id === 'gyms' ? {} : { tab: t.id }, { replace: true })} />
            <span>{t.label}</span>
          </label>
        ))}
      </div>

      {tab === 'gyms' && <GymsTab />}
      {tab === 'ops' && <OperationsTab />}
      {tab === 'pricing' && <PriceBookTab />}
      {tab === 'setup' && <SetupTab setup={setup} />}
    </div>
  );
}

/* ═════════════════════════ Operations ═════════════════════════ */

const ALERT_TONE = { critical: 'bad', warning: 'warn', info: 'mute' };
const STATUS_ORDER = ['queued', 'dialing', 'answered', 'completed', 'sent', 'delivered', 'read', 'no_answer', 'busy', 'failed', 'skipped'];
const CHANNEL_LABEL = { call: 'Voice calls', agent: 'AI conversations', sms: 'SMS', whatsapp: 'WhatsApp' };

function OperationsTab() {
  const health = useFetch(() => api('/console/communication/health'));
  // Refresh every minute while the tab is open; silent, so nothing flickers.
  useEffect(() => { const t = setInterval(() => health.reload({ silent: true }), 60_000); return () => clearInterval(t); }, [health.reload]);
  if (health.loading) return <><SkeletonCards count={4} /><div className="card"><SkeletonRows rows={4} cols={4} /></div></>;
  if (health.error) return <div className="error-text">{health.error.message}</div>;
  const h = health.data;
  const d = h.last_24h;
  const channelRows = Object.entries(d.channels);
  return (
    <div>
      <div className="card">
        <div className="page-header-row" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Alerts</h2>
          <button className="btn ghost sm" onClick={() => health.reload()}>Refresh</button>
        </div>
        {h.alerts.length === 0
          ? <p className="faint" style={{ margin: '10px 0 0' }}>Nothing needs attention. Checked {formatDateTime(h.at)}.</p>
          : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
              {h.alerts.map((a) => (
                <li key={a.code} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                  <span className={`badge ${ALERT_TONE[a.level] || 'mute'}`} style={{ marginRight: 8 }}>{a.level}</span>
                  <b>{a.text}</b>
                  <div className="faint" style={{ marginTop: 4 }}>{a.action}</div>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className="kpi-grid">
        <StatCard label="Queued now" value={h.queue.queued} description={h.queue.oldest_minutes != null ? `Oldest waiting ${h.queue.oldest_minutes} min` : 'Nothing waiting'} />
        <StatCard label="Not reported back" value={h.queue.stuck} description="Calls silent for over 30 min (reconciled every tick)" />
        <StatCard label="Awaiting a duration" value={h.queue.awaiting_duration} description="Answered calls the provider has not timed yet" />
        <StatCard label="Scheduler" value={h.scheduler.minutes_ago == null ? 'Never ran' : `${h.scheduler.minutes_ago} min ago`} description={`${h.scheduler.gyms_on} gym${h.scheduler.gyms_on === 1 ? '' : 's'} switched on`} />
      </div>

      <div className="kpi-grid">
        <StatCard label="Calls, last 24 h" value={d.calls.placed} description={`${d.calls.completed} connected · ${d.calls.failed} failed`} />
        <StatCard label="Messages, last 24 h" value={d.messages.sent} description={`${d.messages.delivered} delivered · ${d.messages.failed} failed (refunded)`} />
        <StatCard label="Usage revenue, 24 h" value={d.revenue} format={moneyExact} description={`Provider cost ${moneyExact(d.cost)}`} />
        <StatCard label="Margin, 24 h" value={d.margin} format={moneyExact} description={d.cost_per_contact != null ? `${moneyExact(d.cost_per_contact)} cost per contact` : 'No contacts yet'} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Last 24 hours by channel</h2>
          {channelRows.length === 0 ? <p className="faint" style={{ margin: 0 }}>No contacts in the last 24 hours.</p> : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Channel</th><th>Outcomes</th></tr></thead>
                <tbody>
                  {channelRows.map(([ch, counts]) => (
                    <tr key={ch}>
                      <td>{CHANNEL_LABEL[ch] || ch}</td>
                      <td className="faint">{STATUS_ORDER.filter((st) => counts[st]).map((st) => `${st.replace('_', ' ')} ${counts[st]}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {h.queue.avg_wait_seconds != null && <p className="faint" style={{ margin: '10px 0 0' }}>Average time from queued to placed: {h.queue.avg_wait_seconds} s.</p>}
        </div>
        <div className="card">
          <h2>Why contacts did not go out</h2>
          {d.failures.length === 0 ? <p className="faint" style={{ margin: 0 }}>No failures or skips in the last 24 hours.</p> : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Reason</th><th className="num">Count</th></tr></thead>
                <tbody>{d.failures.map((f) => <tr key={f.reason}><td>{f.reason}</td><td className="num">{f.count}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {h.discrepancies.length > 0 && (
        <div className="card">
          <h2>Balances that do not match the ledger</h2>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Gym</th><th>Product</th><th className="num">Balance</th><th className="num">Ledger total</th><th className="num">Difference</th></tr></thead>
              <tbody>
                {h.discrepancies.map((x) => (
                  <tr key={`${x.org_id}${x.unit}`}>
                    <td><Link to={`/communication/gyms/${x.org_id}`}>{x.org_id}</Link></td><td>{unitLabel(x.unit)}</td>
                    <td className="num">{x.balance}</td><td className="num">{x.ledger}</td><td className="num" style={{ color: 'var(--bad)' }}>{x.diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════ Gyms ═════════════════════════ */

const WINDOWS = [{ days: 30, label: 'Last 30 days' }, { days: 90, label: 'Last 90 days' }, { days: 365, label: 'Last 12 months' }];

function GymsTab() {
  const nav = useNavigate();
  const [days, setDays] = useState(30);
  // Rounded to the hour so the request key is stable across re-renders.
  const since = useMemo(() => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - days * 86_400_000).toISOString(), [days]);
  const list = useFetch(() => api(`/console/communication/gyms?since=${encodeURIComponent(since)}`), [since]);
  const pricing = useFetch(() => api('/console/communication/pricing'));
  const book = pricing.data?.book;
  const t = list.data?.totals;

  return (
    <div>
      <div className="filter-bar">
        <div className="field">
          <label htmlFor="comm-window">Period</label>
          <select id="comm-window" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((w) => <option key={w.days} value={w.days}>{w.label}</option>)}
          </select>
        </div>
        <FindGym onPick={(g) => nav(`/communication/gyms/${g.id}`)} />
      </div>

      {list.loading && <SkeletonCards count={5} />}
      {list.error && <div className="error-text">{list.error.message}</div>}
      {t && (
        <div className="kpi-grid">
          <StatCard icon="payments" label="Packs sold" value={t.sales_gross} format={moneyExact} description={`Incl. ${moneyExact(t.sales_tax)} tax`} />
          <StatCard icon="trend" label="Usage revenue" value={t.usage_revenue} format={moneyExact} description="Recognised as calls and messages are used, at the value gyms paid" />
          <StatCard label="Provider cost" value={t.provider_cost} format={moneyExact} description="Estimated from the price book in force" />
          <StatCard label="Contribution" value={t.contribution} format={moneyExact} description={t.usage_revenue > 0 ? `${Math.round((t.contribution / t.usage_revenue) * 100)}% of usage revenue` : 'Revenue minus provider cost'} />
          <StatCard label="Unearned balance" value={t.unearned} format={moneyExact} description="Paid for, not used yet (deferred)" />
        </div>
      )}

      {list.loading && <div className="card"><SkeletonRows rows={5} cols={8} /></div>}
      {list.data && !list.data.gyms.length && (
        <div className="card">
          <EmptyState icon="phone" title="No gym has set up AI Communication yet"
            description="A gym appears here once its owner opens the AI Communication tab, buys a pack, or you assign it a caller number. Use “Open a gym” above to assign a number first." />
        </div>
      )}
      {list.data && list.data.gyms.length > 0 && (
        <div className="card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Gym</th><th>Status</th><th>Balances</th><th className="num">Unearned</th>
                  <th className="num">Usage revenue</th><th className="num">Provider cost</th><th className="num">Contribution</th><th>Caller lines</th>
                </tr>
              </thead>
              <tbody>
                {list.data.gyms.map((g) => (
                  <tr key={g.id}>
                    <td><Link to={`/communication/gyms/${g.id}`}>{g.name}</Link></td>
                    <td><span className={`badge ${g.enabled ? 'good' : 'mute'}`}>{g.enabled ? 'On' : 'Off'}</span></td>
                    <td className="faint"><Balances balances={g.balances} book={book} /></td>
                    <td className="num">{moneyExact(g.unearned)}</td>
                    <td className="num">{moneyExact(g.usage_revenue)}</td>
                    <td className="num">{moneyExact(g.provider_cost)}</td>
                    <td className="num" style={{ color: g.contribution < 0 ? 'var(--bad)' : undefined }}>{moneyExact(g.contribution)}</td>
                    <td className="faint">
                      {g.numbers_active} number{g.numbers_active === 1 ? '' : 's'}
                      {g.lines_paid > 0 && <div>{g.lines_paid} paid until {formatDateTime(g.lines_until).slice(0, 10)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Only the balances a gym actually holds, as "Premium voice 120 · SMS 900". */
export function Balances({ balances, book }) {
  const held = Object.entries(balances || {}).filter(([, n]) => Number(n) > 0);
  if (!held.length) return <span>None</span>;
  return <span>{held.map(([u, n]) => `${unitLabel(u, book)} ${Number(n).toLocaleString('en-IN')}`).join(' · ')}</span>;
}

/** Search every gym on the platform, not just those already using the add-on. */
function FindGym({ onPick }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api(`/console/gyms?search=${encodeURIComponent(q.trim())}`)
        .then((d) => { if (alive) setResults((d.gyms || d.rows || []).slice(0, 8)); })
        .catch(() => { if (alive) setResults([]); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="field" style={{ position: 'relative', minWidth: 240 }}>
      <label htmlFor="comm-find">Open a gym</label>
      <input id="comm-find" className="input" placeholder="Search by gym name…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {results.length > 0 && (
        <div className="card" role="listbox" style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, marginTop: 4, padding: 6 }}>
          {results.map((g) => (
            <button key={g.id} type="button" role="option" aria-selected="false" className="btn ghost sm" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 2 }} onClick={() => onPick(g)}>
              {g.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═════════════════════════ Price book ═════════════════════════ */

// A live preview of backend/src/services/followups/wallet.js's unitCosts /
// taxed / evaluatePack, so every pack's cost and markup move as costs are
// typed. The server recomputes all of this from the saved book; if the two
// ever disagree, the server's numbers (shown after saving) are the truth.
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
const r2 = (v) => Math.round(v * 100) / 100;

function unitCosts(book) {
  const c = book.costs || {};
  const infra = 1 + num(c.infra_pct) / 100;
  const out = {
    sms: r2(num(c.sms_per_segment) * infra),
    whatsapp: r2((num(c.whatsapp_per_msg) + num(c.whatsapp_platform_fee)) * infra),
    line_month: r2(num(c.line_per_month) * infra),
  };
  for (const t of book.tiers?.voice || []) out[`voice:${t.id}`] = r2((num(c.telephony_per_min) + num(t.tts_per_1k_chars) * num(c.message_chars_per_min) / 1000) * infra);
  for (const t of book.tiers?.agent || []) out[`agent:${t.id}`] = r2((num(t.agent_per_min) + num(c.telephony_per_min)) * infra);
  return out;
}

function evaluatePack(pack, book) {
  const u = unitCosts(book);
  let cost = 0;
  for (const [unit, n] of Object.entries(pack.units || {})) cost += num(n) * num(u[unit]);
  if (pack.plan === 'lines') cost += num(pack.lines, 1) * u.line_month * (num(pack.days, 30) / 30);
  cost = r2(cost);
  const rate = num(book.tax?.rate_pct, 18) / 100;
  const price = num(pack.price);
  const net = book.tax?.inclusive !== false ? r2(price / (1 + rate)) : r2(price);
  const floor = r2(cost * (1 + num(book.margin_pct, 25) / 100));
  return { cost, net, floor, profit: r2(net - cost), markup_pct: cost > 0 ? Math.round(((net - cost) / cost) * 1000) / 10 : 0, healthy: net >= floor };
}

const COST_FIELDS = [
  { key: 'telephony_per_min', label: 'Call minute (telephony)', hint: 'Exotel, per connected minute', unit: '₹ / min' },
  { key: 'message_chars_per_min', label: 'Characters spoken per minute', hint: 'Turns the per-1,000-character voice price into a per-minute one', unit: 'chars' },
  { key: 'sms_per_segment', label: 'SMS segment', hint: 'DLT SMS, all-in', unit: '₹ / segment' },
  { key: 'whatsapp_per_msg', label: 'WhatsApp message (Meta)', hint: 'Marketing category, India', unit: '₹ / message' },
  { key: 'whatsapp_platform_fee', label: 'WhatsApp provider fee', hint: "The provider's own fee per message", unit: '₹ / message' },
  { key: 'line_per_month', label: 'Caller line rental', hint: 'One number, per month', unit: '₹ / month' },
  { key: 'infra_pct', label: 'Infrastructure share', hint: 'Servers, storage and support, on top of provider cost', unit: '%' },
];

const PLAN_LABEL = { voice: 'Voice calls', agent: 'AI conversations', sms: 'SMS', whatsapp: 'WhatsApp', lines: 'Caller lines' };

/** "Premium voice, 300 minutes": pack names repeat across tiers, so always say which. */
function packLabel(p, book) {
  const unit = Object.keys(p.units || {})[0];
  const what = p.plan === 'lines' ? 'Caller line' : unit ? unitLabel(unit, book) : PLAN_LABEL[p.plan];
  return `${what}, ${p.name || p.id}`;
}
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Every unit a pack can contain, from the tiers being edited. */
function unitOptions(book) {
  return [
    ...(book.tiers?.voice || []).map((t) => ({ key: `voice:${t.id}`, label: `${t.name || t.id} voice calls (minutes)` })),
    ...(book.tiers?.agent || []).map((t) => ({ key: `agent:${t.id}`, label: `${t.name || t.id} AI conversations (minutes)` })),
    { key: 'sms', label: 'SMS (segments)' },
    { key: 'whatsapp', label: 'WhatsApp (messages)' },
  ];
}

function PriceBookTab() {
  const toast = useToast();
  const pricing = useFetch(() => api('/console/communication/pricing'));
  const versions = useFetch(() => api('/console/communication/pricing/versions'));
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);      // ids that exist in the saved book (read-only ids)
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pricing.data?.book) return;
    const { version, ...book } = pricing.data.book;
    setDraft(clone(book));
    setSaved({
      version,
      voice: new Set((book.tiers?.voice || []).map((t) => t.id)),
      agent: new Set((book.tiers?.agent || []).map((t) => t.id)),
      packs: new Set((book.packs || []).map((p) => p.id)),
      json: JSON.stringify(book),
    });
  }, [pricing.data]);

  if (pricing.error) return <div className="error-text">{pricing.error.message}</div>;
  if (pricing.loading || !draft || !saved) return <div className="card"><SkeletonBlock height={320} /></div>;

  const dirty = JSON.stringify(draft) !== saved.json;
  const costs = unitCosts(draft);
  const live = pricing.data.tiers_live || {};
  const isLive = (product, id) => (live[product] || []).find((t) => t.id === id)?.available;
  const economics = draft.packs.map((p) => evaluatePack(p, draft));
  const unhealthy = draft.packs.filter((p, i) => p.active !== false && !economics[i].healthy);

  const set = (fn) => setDraft((d) => { const n = clone(d); fn(n); return n; });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/console/communication/pricing', { method: 'PUT', body: JSON.stringify(draft) });
      toast.success(`Price book saved as version ${saved.version + 1}`);
      setConfirm(false);
      pricing.reload({ silent: true });
      versions.reload({ silent: true });
    } catch (e) {
      setError(e.message || 'Could not save the price book');
      setConfirm(false);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card">
        <div className="page-header-row" style={{ alignItems: 'center', marginBottom: 6 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Version {saved.version || 'defaults'}</h2>
            <p className="faint" style={{ margin: 0 }}>
              {saved.version ? 'The price book in force. Saving creates a new version; every order keeps the version it was sold at.'
                : 'Still the built-in estimates from public 2026 price lists. Replace them with the real per-unit costs from your Exotel, ElevenLabs, Sarvam and Meta invoices before selling.'}
            </p>
          </div>
          <div className="form-actions">
            <button className="btn ghost" disabled={!dirty || busy} onClick={() => { setDraft(JSON.parse(saved.json)); setError(''); }}>Discard changes</button>
            <button className="btn" disabled={!dirty || busy} onClick={() => setConfirm(true)}>Save as version {saved.version + 1}</button>
          </div>
        </div>
        {error && <div className="error-box" style={{ marginTop: 10, marginBottom: 0 }}>{error}</div>}
        {unhealthy.length > 0 && (
          <div className="notice">
            {unhealthy.length} active pack{unhealthy.length === 1 ? ' is' : 's are'} priced below cost plus the {draft.margin_pct}% margin: {unhealthy.map((p) => packLabel(p, draft)).join('; ')}.
          </div>
        )}
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Provider costs</h2>
          <p className="faint" style={{ marginTop: -8 }}>What one unit really costs the platform. Each tier's own engine cost is set under its tier.</p>
          {COST_FIELDS.map((f) => (
            <div className="field" key={f.key} style={{ marginBottom: 12 }}>
              <label htmlFor={`cost-${f.key}`}>{f.label} <span className="faint">({f.unit})</span></label>
              <input id={`cost-${f.key}`} className="input" type="number" min="0" step="any" value={draft.costs[f.key] ?? ''}
                onChange={(e) => set((d) => { d.costs[f.key] = e.target.value === '' ? '' : Number(e.target.value); })} />
              <div className="field-hint">{f.hint}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>Margin and tax</h2>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="pb-margin">Minimum margin over cost (%)</label>
            <input id="pb-margin" className="input" type="number" min="0" max="500" value={draft.margin_pct}
              onChange={(e) => set((d) => { d.margin_pct = e.target.value === '' ? '' : Number(e.target.value); })} />
            <div className="field-hint">A pack whose pre-tax price is below cost plus this margin is flagged.</div>
          </div>
          <div className="form-grid-2" style={{ marginBottom: 12 }}>
            <div className="field">
              <label htmlFor="pb-tax">{draft.tax.label || 'Tax'} rate (%)</label>
              <input id="pb-tax" className="input" type="number" min="0" max="50" value={draft.tax.rate_pct}
                onChange={(e) => set((d) => { d.tax.rate_pct = e.target.value === '' ? '' : Number(e.target.value); })} />
            </div>
            <div className="field">
              <label htmlFor="pb-taxlabel">Tax label</label>
              <input id="pb-taxlabel" className="input" maxLength={12} value={draft.tax.label}
                onChange={(e) => set((d) => { d.tax.label = e.target.value; })} />
            </div>
          </div>
          <div className="toggle-row">
            <label className="switch" htmlFor="pb-inclusive">
              <input id="pb-inclusive" type="checkbox" aria-label="Prices include tax" checked={draft.tax.inclusive !== false}
                onChange={(e) => set((d) => { d.tax.inclusive = e.target.checked; })} />
              <span className="track" />
            </label>
            <div>
              <div className="t">Prices include tax</div>
              <div className="d">On: the pack price is what the gym pays. Off: tax is added at checkout.</div>
            </div>
          </div>

          <h2 style={{ marginTop: 18 }}>Cost per unit</h2>
          <dl className="kv">
            {Object.entries(costs).map(([k, v]) => (
              <FragmentRow key={k} label={k === 'line_month' ? 'Caller line, per month' : unitLabel(k, draft) + (k.includes(':') ? ', per minute' : k === 'sms' ? ', per segment' : ', per message')} value={moneyExact(v)} />
            ))}
          </dl>
        </div>
      </div>

      {['voice', 'agent'].map((product) => (
        <div className="card" key={product}>
          <div className="page-header-row" style={{ alignItems: 'center' }}>
            <div>
              <h2 style={{ marginBottom: 4 }}>{product === 'voice' ? 'Voice call tiers' : 'AI conversation tiers'}</h2>
              <p className="faint" style={{ margin: 0 }}>
                {product === 'voice' ? 'An AI voice reads the gym’s message. Each tier is one speech engine with its own cost per 1,000 characters.'
                  : 'Two-way AI phone conversations. Each tier is one agent provider with its own cost per minute.'}
                {' '}A tier whose provider is not set up on this server shows gyms “Coming soon”.
              </p>
            </div>
            <button className="btn ghost sm" disabled={(draft.tiers[product] || []).length >= 6}
              onClick={() => set((d) => { d.tiers[product].push(product === 'voice' ? { id: '', name: '', tagline: '', provider: 'http', tts_per_1k_chars: 0, active: true } : { id: '', name: '', tagline: '', provider: 'http', agent_per_min: 0, active: true }); })}>
              Add tier
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Id</th><th>Name</th><th>Tagline gyms see</th><th>Provider</th><th className="num">{product === 'voice' ? '₹ / 1,000 chars' : '₹ / min'}</th><th className="num">Unit cost</th><th>On this server</th><th>Active</th><th /></tr>
              </thead>
              <tbody>
                {draft.tiers[product].map((t, i) => {
                  const isNew = !saved[product].has(t.id) || !t.id;
                  const costKey = product === 'voice' ? 'tts_per_1k_chars' : 'agent_per_min';
                  return (
                    <tr key={i}>
                      <td>
                        {isNew
                          ? <input className="input" aria-label="Tier id" style={{ width: 110 }} value={t.id} placeholder="e.g. hindi" onChange={(e) => set((d) => { d.tiers[product][i].id = slug(e.target.value); })} />
                          : <span className="code-chip">{t.id}</span>}
                      </td>
                      <td><input className="input" aria-label="Tier name" style={{ width: 110 }} maxLength={24} value={t.name} onChange={(e) => set((d) => { d.tiers[product][i].name = e.target.value; })} /></td>
                      <td><input className="input" aria-label="Tagline" style={{ minWidth: 220 }} maxLength={120} value={t.tagline} onChange={(e) => set((d) => { d.tiers[product][i].tagline = e.target.value; })} /></td>
                      <td>
                        <select className="input" aria-label="Provider" value={t.provider} onChange={(e) => set((d) => { d.tiers[product][i].provider = e.target.value; })}>
                          <option value="elevenlabs">ElevenLabs</option>
                          {product === 'voice' && <option value="sarvam">Sarvam</option>}
                          <option value="http">Your own model (HTTP)</option>
                        </select>
                      </td>
                      <td className="num"><input className="input" aria-label="Engine cost" type="number" min="0" step="any" style={{ width: 90 }} value={t[costKey]} onChange={(e) => set((d) => { d.tiers[product][i][costKey] = e.target.value === '' ? '' : Number(e.target.value); })} /></td>
                      <td className="num">{t.id ? moneyExact(costs[`${product}:${t.id}`]) : '—'}</td>
                      <td>{isNew ? <span className="faint">After saving</span> : <span className={`badge ${isLive(product, t.id) ? 'good' : 'mute'}`}>{isLive(product, t.id) ? 'Available' : 'Coming soon'}</span>}</td>
                      <td>
                        <label className="switch">
                          <input type="checkbox" aria-label={`${t.name || t.id} tier active`} checked={t.active !== false} onChange={(e) => set((d) => { d.tiers[product][i].active = e.target.checked; })} />
                          <span className="track" />
                        </label>
                      </td>
                      <td>{isNew && <button className="btn ghost sm" onClick={() => set((d) => { d.tiers[product].splice(i, 1); })}>Remove</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ margin: '10px 0 0' }}>Saved tiers are switched off rather than deleted: gyms may still hold minutes in them.</p>
        </div>
      ))}

      <div className="card">
        <div className="page-header-row" style={{ alignItems: 'center' }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Packs</h2>
            <p className="faint" style={{ margin: 0 }}>What gyms can buy. Cost, pre-tax price and markup update as you type; a pack below cost plus margin is flagged.</p>
          </div>
          <button className="btn ghost sm" disabled={draft.packs.length >= 60}
            onClick={() => set((d) => { d.packs.push({ id: '', plan: 'sms', name: '', units: { sms: 1000 }, price: 0, active: true }); })}>
            Add pack
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Id</th><th>Name</th><th>Contains</th><th className="num">Price</th><th className="num">Cost</th><th className="num">Pre-tax</th><th className="num">Markup</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {draft.packs.map((p, i) => {
                const e = economics[i];
                const isNew = !saved.packs.has(p.id) || !p.id;
                const [unit, count] = Object.entries(p.units || {})[0] || ['', 0];
                const extra = Object.keys(p.units || {}).length - 1;
                return (
                  <tr key={i}>
                    <td>
                      {isNew
                        ? <input className="input" aria-label="Pack id" style={{ width: 130 }} value={p.id} placeholder="e.g. sms_10000" onChange={(ev) => set((d) => { d.packs[i].id = slug(ev.target.value); })} />
                        : <span className="code-chip">{p.id}</span>}
                    </td>
                    <td><input className="input" aria-label="Pack name" style={{ width: 140 }} maxLength={60} value={p.name} onChange={(ev) => set((d) => { d.packs[i].name = ev.target.value; })} /></td>
                    <td>
                      {p.plan === 'lines' ? (
                        <div className="inline-row" style={{ minWidth: 260 }}>
                          <input className="input" aria-label="Lines" type="number" min="1" max="20" style={{ width: 64 }} value={p.lines} onChange={(ev) => set((d) => { d.packs[i].lines = Number(ev.target.value); })} />
                          <span className="faint">line ×</span>
                          <input className="input" aria-label="Days" type="number" min="1" max="366" style={{ width: 70 }} value={p.days} onChange={(ev) => set((d) => { d.packs[i].days = Number(ev.target.value); })} />
                          <span className="faint">days</span>
                        </div>
                      ) : (
                        <div className="inline-row" style={{ minWidth: 320 }}>
                          <input className="input" aria-label="Units" type="number" min="1" style={{ width: 90 }} value={count}
                            onChange={(ev) => set((d) => { d.packs[i].units[unit] = ev.target.value === '' ? '' : Number(ev.target.value); })} />
                          <select className="input" aria-label="Product" value={unit}
                            onChange={(ev) => set((d) => {
                              const next = ev.target.value;
                              const n = d.packs[i].units[unit];
                              delete d.packs[i].units[unit];
                              d.packs[i].units = { [next]: n, ...d.packs[i].units };
                              d.packs[i].plan = next.split(':')[0];
                              if (next.includes(':')) d.packs[i].tier = next.split(':')[1]; else delete d.packs[i].tier;
                            })}>
                            {unitOptions(draft).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                          {extra > 0 && <span className="faint">+{extra} more</span>}
                        </div>
                      )}
                      <div className="faint" style={{ marginTop: 2 }}>{PLAN_LABEL[p.plan]}</div>
                    </td>
                    <td className="num"><input className="input" aria-label="Price" type="number" min="1" step="1" style={{ width: 96 }} value={p.price} onChange={(ev) => set((d) => { d.packs[i].price = ev.target.value === '' ? '' : Number(ev.target.value); })} /></td>
                    <td className="num">{moneyExact(e.cost)}</td>
                    <td className="num">{moneyExact(e.net)}</td>
                    <td className="num">
                      <span className={`badge ${p.active === false ? 'mute' : e.healthy ? 'good' : 'bad'}`} title={`Floor (cost + margin): ${moneyExact(e.floor)} · profit ${moneyExact(e.profit)}`}>
                        {e.cost > 0 ? `${e.markup_pct}%` : '—'}
                      </span>
                    </td>
                    <td>
                      <label className="switch">
                        <input type="checkbox" aria-label={`${packLabel(p, draft)} on sale`} checked={p.active !== false} onChange={(ev) => set((d) => { d.packs[i].active = ev.target.checked; })} />
                        <span className="track" />
                      </label>
                    </td>
                    <td><button className="btn ghost sm" onClick={() => set((d) => { d.packs.splice(i, 1); })} aria-label={`Remove ${p.name || 'pack'}`}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ margin: '10px 0 0' }}>Removing a pack only takes it off sale; orders already placed keep the pack and price they were sold with.</p>
      </div>

      <div className="card">
        <h2>Trial capacity</h2>
        <p className="faint" style={{ marginTop: -8 }}>Granted once per gym, free, so owners can place test calls before buying.</p>
        <div className="form-grid-4">
          {unitOptions(draft).map((o) => (
            <div className="field" key={o.key}>
              <label htmlFor={`trial-${o.key}`}>{unitLabel(o.key, draft)}</label>
              <input id={`trial-${o.key}`} className="input" type="number" min="0" max="50" value={draft.trial?.[o.key] ?? 0}
                onChange={(e) => set((d) => { d.trial = { ...(d.trial || {}), [o.key]: Number(e.target.value) || 0 }; })} />
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>History</h2>
        {versions.loading && <SkeletonRows rows={3} cols={3} />}
        {versions.data && !versions.data.versions.length && <p className="faint" style={{ margin: 0 }}>No version saved yet. Gyms are buying at the built-in defaults.</p>}
        {versions.data && versions.data.versions.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Version</th><th>Saved</th><th>By</th></tr></thead>
              <tbody>
                {versions.data.versions.map((v) => (
                  <tr key={v.version}>
                    <td>{v.version}{v.version === saved.version && <span className="badge good" style={{ marginLeft: 8 }}>In force</span>}</td>
                    <td className="faint">{formatDateTime(v.created_at)}</td>
                    <td className="faint">{v.created_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        danger={false}
        title={`Save price book version ${saved.version + 1}?`}
        description={`New purchases are priced from it immediately and AI Communication usage is costed against it. Orders already placed keep the version they were sold at.${unhealthy.length ? ` ${unhealthy.length} active pack${unhealthy.length === 1 ? ' is' : 's are'} below cost plus margin.` : ''}`}
        confirmLabel="Save version"
        busy={busy}
        onConfirm={save}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

function FragmentRow({ label, value }) {
  return (<><dt>{label}</dt><dd className="mono-num">{value}</dd></>);
}

/* ═════════════════════════ Setup ═════════════════════════ */

const CHANNELS = [
  { id: 'call', label: 'voice calls' },
  { id: 'agent', label: 'AI conversations' },
  { id: 'sms', label: 'SMS' },
  { id: 'whatsapp', label: 'WhatsApp' },
];

const WEBHOOKS = [
  { key: 'exotel_gather', label: 'Exotel flow: Programmable Gather', hint: 'App Bazaar flow, first step' },
  { key: 'exotel_keypress', label: 'Exotel flow: Passthru', hint: 'App Bazaar flow, after the Gather' },
  { key: 'exotel_whatsapp', label: 'Exotel WhatsApp callbacks', hint: 'Delivery statuses and member replies. Signed: copy it whole.' },
  { key: 'elevenlabs_post_call', label: 'ElevenLabs post-call webhook', hint: 'Agents → Settings → Post-call webhook' },
  { key: 'your_agent_server_results', label: 'Your own agent server results', hint: 'Only with FOLLOWUP_AGENT_HTTP_URL; signed with FOLLOWUP_HTTP_TOKEN' },
  { key: 'cron', label: 'Scheduler (every 5 minutes)', hint: 'GET with Authorization: Bearer <CRON_SECRET>' },
];

function SetupTab({ setup }) {
  const toast = useToast();
  const platform = useFetch(() => api('/console/communication/platform'));
  const [draft, setDraft] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (platform.data) setDraft({ paused: platform.data.paused, paused_channels: platform.data.paused_channels }); }, [platform.data]);

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Could not copy. Select the text instead.'); }
  };

  const saveSwitch = async () => {
    setBusy(true);
    try {
      await api('/console/communication/platform', { method: 'PUT', body: JSON.stringify(draft) });
      toast.success(draft.paused ? 'All automated contact is paused' : draft.paused_channels.length ? 'Channel switches saved' : 'Automated contact is running');
      setConfirm(false);
      platform.reload({ silent: true });
    } catch (e) { toast.error(e.message || 'Could not save'); } finally { setBusy(false); }
  };

  if (setup.loading) return <div className="card"><SkeletonBlock height={260} /></div>;
  if (setup.error) return <div className="error-text">{setup.error.message}</div>;
  const s = setup.data.status;
  const cap = setup.data.capabilities;
  const changed = draft && platform.data && (draft.paused !== platform.data.paused || [...draft.paused_channels].sort().join() !== [...platform.data.paused_channels].sort().join());

  return (
    <div>
      <div className="two-col">
        <div className="card">
          <h2>This server</h2>
          <dl className="kv">
            <dt>Mode</dt><dd><span className={`badge ${MODE_TONE[s.mode] || 'mute'}`}>{MODE_LABEL[s.mode] || s.mode}</span></dd>
            <dt>Calls and messages</dt><dd>{cap.telephony === 'exotel' ? 'Exotel' : 'Simulated (test mode)'}</dd>
            <dt>Speech engines</dt><dd>{cap.speech.length ? cap.speech.map((p) => p.label).join(', ') : 'None configured'}</dd>
            <dt>AI conversations</dt><dd>{cap.conversation === 'test' ? 'Simulated (test mode)' : cap.conversation ? (cap.conversation === 'http' ? 'Your own agent server' : 'ElevenLabs Agents') : 'Not set up'}{s.mode === 'live' && !s.agentCalls && cap.conversation ? ' · needs its result webhook secret' : ''}</dd>
            <dt>Platform caller line</dt><dd>{s.platformLine ? 'Set (EXOTEL_CALLER_ID)' : 'Not set: every gym needs its own number'}</dd>
            <dt>“Hear it” previews</dt><dd>{s.voicePreviews ? 'Available' : 'Need a speech engine'}</dd>
          </dl>
          {s.missing.length > 0 && (
            <div className="notice">
              {s.mode === 'off' ? 'Nothing is sent from production until these are set:' : 'To go live, set:'} {s.missing.join(' · ')}. See docs/FOLLOWUPS.md, “Going live”.
            </div>
          )}
        </div>

        <div className="card">
          <h2>Platform switch</h2>
          <p className="faint" style={{ marginTop: -8 }}>Stops automated contact for every gym at once. Nothing is placed while it is on; gyms keep their balances, campaigns and settings, and their Overview tells them Barbell has paused sending.</p>
          {!draft && <SkeletonBlock height={120} />}
          {draft && (
            <>
              <div className="toggle-row">
                <label className="switch" htmlFor="plat-paused">
                  <input id="plat-paused" type="checkbox" aria-label="Pause all automated contact" checked={draft.paused} onChange={(e) => setDraft({ ...draft, paused: e.target.checked })} />
                  <span className="track" />
                </label>
                <div>
                  <div className="t">Pause all automated contact</div>
                  <div className="d">For an incident, a provider outage or a compliance hold. Calls already queued wait; any not placed within the gym's hours that day are dropped, never sent late.</div>
                </div>
              </div>
              {CHANNELS.map((c) => (
                <div className="toggle-row" key={c.id}>
                  <label className="switch" htmlFor={`plat-${c.id}`}>
                    <input id={`plat-${c.id}`} type="checkbox" aria-label={`Pause ${c.label} only`} disabled={draft.paused} checked={draft.paused_channels.includes(c.id)}
                      onChange={(e) => setDraft({ ...draft, paused_channels: e.target.checked ? [...draft.paused_channels, c.id] : draft.paused_channels.filter((x) => x !== c.id) })} />
                    <span className="track" />
                  </label>
                  <div><div className="t">Pause {c.label} only</div><div className="d">Anything already queued on this channel is dropped.</div></div>
                </div>
              ))}
              <div className="form-actions" style={{ marginTop: 12 }}>
                <button className="btn" disabled={!changed || busy} onClick={() => (draft.paused && !platform.data.paused ? setConfirm(true) : saveSwitch())}>Save</button>
                {(platform.data.paused || platform.data.paused_channels.length > 0) && <span className="badge bad">{platform.data.paused ? 'Everything paused' : `Paused: ${platform.data.paused_channels.join(', ')}`}</span>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>URLs to paste into providers</h2>
        <p className="faint" style={{ marginTop: -8 }}>Built from PUBLIC_BASE_URL. They must be public https addresses for live calls.</p>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Where</th><th>URL</th><th /></tr></thead>
            <tbody>
              {WEBHOOKS.map((w) => (
                <tr key={w.key}>
                  <td style={{ minWidth: 200 }}>{w.label}<div className="faint">{w.hint}</div></td>
                  <td><code style={{ wordBreak: 'break-all', fontSize: 12.5 }}>{setup.data.webhooks[w.key]}</code></td>
                  <td><button className="btn ghost sm" onClick={() => copy(setup.data.webhooks[w.key])} aria-label={`Copy ${w.label} URL`}>Copy</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        title="Pause all automated contact?"
        description="Every gym's automated calls, AI conversations, SMS and WhatsApp stop until you turn this off. Owners see that it is paused by the platform."
        confirmLabel="Pause everything"
        busy={busy}
        onConfirm={saveSwitch}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
