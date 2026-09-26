/**
 * CONNECTIONS — connecting the gym's access systems, and the Custom API
 * builder.
 *
 * WHAT THIS PANEL REFUSES TO DO:
 *   * show a credential after it has been saved. A signing secret appears
 *     exactly once, at generation, and says so;
 *   * offer a vendor adapter that does not exist (the catalogue marks them);
 *   * call a connection "working" because it saved. Test Connection and
 *     Test Event report what actually happened, stage by stage;
 *   * render a control the connection cannot perform. Every action below
 *     is gated on that connection's own capabilities, which the server
 *     computes from its configuration -- a REST connection with no
 *     permission URL has no access-sync button because it cannot sync.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Modal, Empty, useConfirm } from '../UI.jsx';
import InfoDot from '../InfoDot.jsx';
import { Pill, Label, Field, ErrorLine, Loading, When, PROVIDER_STATE } from './shared.jsx';

const STATUS = {
  ACTIVE: { tone: 'good', label: 'Active' },
  CONFIGURED: { tone: 'warn', label: 'Not tested' },
  ERROR: { tone: 'bad', label: 'Not working' },
  DISABLED: { tone: 'mute', label: 'Disconnected' },
};

const CANONICAL = [
  ['externalUserId', 'Member access ID', 'e.g. employee_code, badge_id, person.id'],
  ['occurredAt', 'Event time', 'e.g. punch_time, timestamp'],
  ['eventType', 'Direction (entry / exit)', 'e.g. direction, in_out'],
  ['externalEventId', 'Event ID', 'optional — used to ignore repeats'],
  ['deviceIdentifier', 'Device ID', 'optional — e.g. device_serial'],
];

/* ── shown once ───────────────────────────────────────────────────── */

function SecretOnce({ value, webhookUrl, onDone }) {
  const [copied, setCopied] = useState('');
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { /* select and copy by hand */ }
  };
  const fullUrl = webhookUrl ? `${window.location.origin}${webhookUrl}` : null;
  return (
    <Modal open onClose={onDone} title="Copy this now">
      <div className="space-y-3">
        <p className="text-[13px]" style={{ color: 'var(--mute)' }}>
          This signing secret is shown once and cannot be retrieved afterwards. Put it into your
          access system now. If you lose it, rotate it — that issues a new one and stops the old one working.
        </p>
        {fullUrl && (
          <Field label="Webhook URL">
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 rounded-xl p-2.5 text-[11.5px] break-all"
                    style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)' }}>{fullUrl}</code>
              <button className="btn btn-sm shrink-0" onClick={() => copy(fullUrl, 'url')}>{copied === 'url' ? 'Copied' : 'Copy'}</button>
            </div>
          </Field>
        )}
        <Field label="Signing secret">
          <div className="flex gap-2">
            <code className="flex-1 min-w-0 rounded-xl p-2.5 text-[11.5px] break-all font-mono"
                  style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--ink)' }}>{value}</code>
            <button className="btn btn-sm shrink-0" onClick={() => copy(value, 'secret')}>{copied === 'secret' ? 'Copied' : 'Copy'}</button>
          </div>
        </Field>
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--faint)' }}>
          Sign each request with HMAC-SHA256 over <code>timestamp.body</code>, and send the result in
          <code> x-skos-signature</code> with the Unix time in <code>x-skos-timestamp</code>. Requests older
          than five minutes are refused.
        </p>
        <button className="btn btn-primary w-full" onClick={onDone}>I have saved it</button>
      </div>
    </Modal>
  );
}

/* ── the connect wizard ───────────────────────────────────────────── */

function ConnectSheet({ catalogue, branches, onClose, onConnected }) {
  const [picked, setPicked] = useState(null);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [fields, setFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const usable = catalogue.filter((p) => p.implemented);
  const unbuilt = catalogue.filter((p) => !p.implemented);

  const connect = async () => {
    setSaving(true); setError('');
    try {
      const secrets = {};
      const config = {};
      for (const f of picked.requiredFields || []) {
        if (f.generated) continue;
        const v = (fields[f.key] || '').trim();
        if (!v) { setError(`${f.label} is required.`); setSaving(false); return; }
        if (f.secret) secrets[f.key] = v;
        else if (f.key === 'base_url') config.baseUrl = v;
        else config[f.key] = v;
      }
      const res = await api('/admin/access/providers', {
        method: 'POST',
        body: JSON.stringify({
          providerKey: picked.key, displayName: name.trim() || picked.name,
          branchId: branchId || null, config, secrets,
        }),
      });
      onConnected(res);
    } catch (e) {
      setError(e.message || 'Could not connect.');
    }
    setSaving(false);
  };

  return (
    <Modal open onClose={onClose} title={picked ? `Connect ${picked.name}` : 'Connect an access system'} wide>
      {!picked ? (
        <div className="space-y-4">
          <div className="space-y-2">
            {usable.map((p) => (
              <button key={p.key} onClick={() => { setPicked(p); setName(p.name); }}
                      className="w-full text-left rounded-xl p-3"
                      style={{ border: '1px solid var(--line)', background: 'var(--bg2)', minHeight: 44 }}>
                <div className="font-grotesk font-bold text-[13px]" style={{ color: 'var(--ink)' }}>{p.name}</div>
                <div className="text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--mute)' }}>{p.description}</div>
              </button>
            ))}
          </div>
          {unbuilt.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-2">
                <div className="text-[10px] uppercase tracking-[.14em] font-grotesk" style={{ color: 'var(--faint)' }}>
                  Recognised, not yet built
                </div>
                <InfoDot label="unbuilt providers" title="Why these are greyed out" size={26}>
                  A vendor-specific adapter needs that vendor&rsquo;s API documentation, real credentials and a
                  device to test against. Rather than offer a button backed by a guess, SK OS says so — most of
                  these panels can send webhooks or expose an HTTP endpoint, which works today.
                </InfoDot>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {unbuilt.map((p) => <span key={p.key} className="chip" style={{ opacity: 0.55 }}>{p.name}</span>)}
              </div>
            </div>
          )}
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--faint)' }}>
            SK OS never stores fingerprints, face scans or any biometric template. Matching stays inside your
            access hardware; SK OS receives only a member reference, a direction and a time. Take legal advice
            before enabling biometric access in production.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Name this connection">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main entrance" />
          </Field>
          {branches.length > 0 && (
            <Field label="Branch" help="Events from this connection count toward this branch unless a device says otherwise.">
              <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Whole gym</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          {(picked.requiredFields || []).filter((f) => !f.generated).map((f) => (
            <Field key={f.key} label={f.label} help={f.help}>
              <input className="input" type={f.secret ? 'password' : 'text'} autoComplete="off"
                     value={fields[f.key] || ''} onChange={(e) => setFields((s) => ({ ...s, [f.key]: e.target.value }))} />
            </Field>
          ))}
          {picked.capabilities?.supportsWebhooks && (
            <div className="rounded-xl p-3 text-[11px] leading-snug"
                 style={{ background: 'var(--bg2)', border: '1px solid var(--line)', color: 'var(--mute)' }}>
              A signing secret is generated for you and shown once. SK OS rejects anything unsigned, wrongly
              signed, or older than five minutes.
            </div>
          )}
          <ErrorLine>{error}</ErrorLine>
          <div className="flex gap-2">
            <button className="btn flex-1" onClick={() => setPicked(null)}>Back</button>
            <button className="btn btn-primary flex-1" onClick={connect} disabled={saving}>{saving ? 'Connecting…' : 'Connect'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ── Custom API builder: field map + JSON preview ─────────────────── */

const SAMPLE = `{
  "employee_code": "GYM-0042",
  "punch_time": "2026-09-19T07:05:00+05:30",
  "direction": "in",
  "device_serial": "ZK-FRONT-1",
  "transaction_id": "88123"
}`;

function ConfigureSheet({ provider, onClose, onSaved }) {
  const cfg = provider.config || {};
  const [map, setMap] = useState(cfg.fieldMap || {});
  const [urls, setUrls] = useState({
    baseUrl: cfg.baseUrl || '', permissionUrl: cfg.permissionUrl || '', eventsPath: cfg.eventsPath || '',
    sinceParam: cfg.sinceParam || '', pollIntervalSec: cfg.pollIntervalSec || '',
  });
  const [sample, setSample] = useState(SAMPLE);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const isRest = provider.providerKey === 'generic_rest';

  const cleanMap = () => Object.fromEntries(Object.entries(map).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]));

  const runPreview = async () => {
    setBusy('preview'); setError(''); setPreview(null);
    let parsed;
    try { parsed = JSON.parse(sample); } catch { setError('The sample is not valid JSON.'); setBusy(''); return; }
    try {
      const res = await api(`/admin/access/providers/${provider.id}/preview-mapping`, {
        method: 'POST', body: JSON.stringify({ sample: parsed, fieldMap: cleanMap() }),
      });
      setPreview(res.results);
    } catch (e) { setError(e.message || 'Preview failed.'); }
    setBusy('');
  };

  const save = async () => {
    setBusy('save'); setError('');
    try {
      const config = { fieldMap: cleanMap() };
      if (isRest) {
        for (const k of ['baseUrl', 'permissionUrl', 'eventsPath', 'sinceParam']) config[k] = urls[k].trim() || null;
        config.pollIntervalSec = urls.pollIntervalSec ? Number(urls.pollIntervalSec) : null;
      }
      const res = await api(`/admin/access/providers/${provider.id}`, { method: 'PATCH', body: JSON.stringify({ config }) });
      onSaved(res.provider);
    } catch (e) { setError(e.message || 'Could not save.'); }
    setBusy('');
  };

  return (
    <Modal open onClose={onClose} title={`Configure ${provider.name}`} wide>
      <div className="space-y-4">
        {isRest && (
          <div className="space-y-3">
            <Label>Endpoints</Label>
            <Field label="Events endpoint URL" help="SK OS calls this with GET. Private and internal addresses are refused, and redirects are not followed.">
              <input className="input" value={urls.baseUrl} onChange={(e) => setUrls((u) => ({ ...u, baseUrl: e.target.value }))} placeholder="https://panel.example.com/api/events" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Field label="Path to event list" help="Blank to auto-detect">
                <input className="input" value={urls.eventsPath} onChange={(e) => setUrls((u) => ({ ...u, eventsPath: e.target.value }))} placeholder="data.records" />
              </Field>
              <Field label="'Since' parameter" help="Default: since">
                <input className="input" value={urls.sinceParam} onChange={(e) => setUrls((u) => ({ ...u, sinceParam: e.target.value }))} placeholder="since" />
              </Field>
              <Field label="Poll every (seconds)" help="Minimum 60">
                <input className="input" type="number" min="60" value={urls.pollIntervalSec} onChange={(e) => setUrls((u) => ({ ...u, pollIntervalSec: e.target.value }))} placeholder="300" />
              </Field>
            </div>
            <Field label="Access permission endpoint (optional)"
                   help='When set, SK OS POSTs {"external_user_id": "…", "access": "allow" | "deny"} here when a membership lapses or renews. Leave blank if your system cannot accept it.'>
              <input className="input" value={urls.permissionUrl} onChange={(e) => setUrls((u) => ({ ...u, permissionUrl: e.target.value }))} placeholder="https://panel.example.com/api/access" />
            </Field>
          </div>
        )}

        <div>
          <Label right={
            <InfoDot label="field mapping" title="What this does" size={26} align="end">
              Tell SK OS where each piece of information lives in your system&rsquo;s JSON. A dotted path reaches
              into nested objects. Leave a field blank and SK OS tries common names. Nothing here can run code —
              it is a list of field names.
            </InfoDot>
          }>Field mapping</Label>
          <div className="space-y-2">
            {CANONICAL.map(([key, label, hint]) => (
              <div key={key} className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-1 sm:gap-2 items-center">
                <span className="text-[12px]" style={{ color: 'var(--ink)' }}>{label}</span>
                <input className="input" value={map[key] || ''} placeholder={hint}
                       onChange={(e) => setMap((m) => ({ ...m, [key]: e.target.value }))} aria-label={label} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <Label>Sample from your system</Label>
          <textarea className="input font-mono text-[11.5px]" rows={7} value={sample}
                    onChange={(e) => setSample(e.target.value)} spellCheck={false} aria-label="Sample JSON" />
          <button className="btn btn-sm mt-2" onClick={runPreview} disabled={!!busy}>
            {busy === 'preview' ? 'Checking…' : 'Preview what SK OS reads'}
          </button>
          {preview && (
            <div className="mt-2 space-y-1.5" aria-live="polite">
              {preview.map((r) => (
                <div key={r.index} className="rounded-xl p-2.5 text-[11.5px]"
                     style={{ border: `1px solid ${r.ok ? 'var(--good)' : 'var(--warn)'}`, background: 'var(--bg2)' }}>
                  {r.normalized ? (
                    <div className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-0.5" style={{ color: 'var(--ink)' }}>
                      <span style={{ color: 'var(--faint)' }}>Member ID</span><span className="font-mono">{r.normalized.externalUserId}</span>
                      <span style={{ color: 'var(--faint)' }}>Time</span><span className="font-mono">{r.normalized.occurredAt}</span>
                      <span style={{ color: 'var(--faint)' }}>Direction</span><span className="font-mono">{r.normalized.eventType ?? '—'}</span>
                      <span style={{ color: 'var(--faint)' }}>Event ID</span><span className="font-mono">{r.normalized.externalEventId ?? '—'}</span>
                      <span style={{ color: 'var(--faint)' }}>Device</span><span className="font-mono">{r.normalized.deviceIdentifier ?? '—'}</span>
                    </div>
                  ) : <div style={{ color: 'var(--warn)' }}>{r.problem}</div>}
                  {r.problems?.map((p) => <div key={p} className="mt-1" style={{ color: 'var(--warn)' }}>{p}</div>)}
                </div>
              ))}
              <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>Preview only — nothing was recorded.</div>
            </div>
          )}
        </div>

        <ErrorLine>{error}</ErrorLine>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary flex-1" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save configuration'}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── test event, import, csv, webhook details, demo ──────────────── */

function StagesSheet({ title, result, onClose }) {
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-2">
        {result.stages.map((s) => (
          <div key={s.stage} className="flex items-start gap-2.5 rounded-xl p-2.5" style={{ border: '1px solid var(--line)' }}>
            <Pill tone={s.ok ? 'good' : 'bad'}>{s.ok ? 'Pass' : 'Fail'}</Pill>
            <div className="min-w-0">
              <div className="text-[12px] font-grotesk font-semibold capitalize" style={{ color: 'var(--ink)' }}>{s.stage}</div>
              <div className="text-[11.5px]" style={{ color: 'var(--mute)' }}>{s.detail}</div>
            </div>
          </div>
        ))}
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          A test event is signed with this connection&rsquo;s own secret and run through the same checks as a real
          one, then discarded. It never counts toward occupancy.
        </p>
        <button className="btn w-full" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function ImportSheet({ provider, onClose, onStarted }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true); setError('');
    try {
      const res = await api(`/admin/access/providers/${provider.id}/import`, {
        method: 'POST',
        body: JSON.stringify({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() }),
      });
      onStarted(res.job);
    } catch (e) { setError(e.message || 'Could not start the import.'); }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title="Import history">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="From"><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input className="input" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
          Runs in the background in small pieces; follow it in Sync. Events already imported are recognised and skipped.
        </p>
        <ErrorLine>{error}</ErrorLine>
        <button className="btn btn-primary w-full" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start import'}</button>
      </div>
    </Modal>
  );
}

function CsvSheet({ provider, onClose, onStarted }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onFile = async (file) => {
    setError('');
    if (!file) return;
    if (file.size > 3_000_000) { setError('That file is over 3 MB. Split it and import the parts.'); return; }
    setFileName(file.name);
    setText(await file.text());
  };
  const start = async () => {
    setBusy(true); setError('');
    try {
      const res = await api(`/admin/access/providers/${provider.id}/import-csv`, { method: 'POST', body: JSON.stringify({ csv: text }) });
      onStarted(res.job, res.truncated);
    } catch (e) { setError(e.message || 'Could not import the file.'); }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title="Import a CSV file">
      <div className="space-y-3">
        <p className="text-[12px]" style={{ color: 'var(--mute)' }}>
          The first row must be column names. Map them in Configure first — for example
          <code> employee_code</code> → member access ID, <code>punch_time</code> → event time.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} aria-label="CSV file" />
        {fileName && <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{fileName} · {text.split(/\r?\n/).filter(Boolean).length - 1} data rows</div>}
        <ErrorLine>{error}</ErrorLine>
        <button className="btn btn-primary w-full" onClick={start} disabled={busy || !text}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
    </Modal>
  );
}

function WebhookSheet({ provider, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/admin/access/providers/${provider.id}/webhook`).then(setData).catch((e) => setError(e.message));
  }, [provider.id]);
  return (
    <Modal open onClose={onClose} title="Webhook">
      {error ? <ErrorLine>{error}</ErrorLine> : !data ? <Loading /> : (
        <div className="space-y-3 text-[12px]">
          <Field label="Endpoint">
            <code className="block rounded-xl p-2.5 break-all text-[11.5px]" style={{ background: 'var(--bg2)', border: '1px solid var(--line)' }}>
              {window.location.origin}{data.url}
            </code>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <div className="card p-3"><Label>Received (24h)</Label><div className="font-black text-[18px]">{data.last24h.received}</div></div>
            <div className="card p-3"><Label>Processed</Label><div className="font-black text-[18px]">{data.last24h.processed}</div></div>
            <div className="card p-3"><Label>Rejected signatures</Label><div className="font-black text-[18px]" style={{ color: data.last24h.rejectedSignatures ? 'var(--warn)' : 'var(--ink)' }}>{data.last24h.rejectedSignatures}</div></div>
            <div className="card p-3"><Label>Last received</Label><div className="font-grotesk font-bold"><When at={data.last24h.lastReceivedAt} fallback="Never" /></div></div>
          </div>
          <div style={{ color: 'var(--mute)' }}>
            Signing: {data.signing.algorithm} over <code>{data.signing.signedString}</code>, headers
            <code> {data.signing.headers.join(', ')}</code>, {data.signing.maxSkewSeconds}s window.
            Secret {data.secret ? <span className="font-mono">{data.secret.masked}</span> : 'not set'}.
          </div>
          {data.recentRejections.length > 0 && (
            <div>
              <Label>Recent rejections</Label>
              {data.recentRejections.map((r, i) => (
                <div key={i} className="flex justify-between gap-2 py-1" style={{ borderBottom: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--warn)' }}>{r.reason}</span><span style={{ color: 'var(--faint)' }}><When at={r.at} /></span>
                </div>
              ))}
            </div>
          )}
          <button className="btn w-full" onClick={onClose}>Close</button>
        </div>
      )}
    </Modal>
  );
}

function DemoSimulator({ provider, onEvent }) {
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState('');
  const [last, setLast] = useState('');
  const send = async (eventType) => {
    if (!who.trim()) { setLast('Enter the access ID of a mapped member first.'); return; }
    setBusy(eventType);
    try {
      const r = await api(`/admin/access/demo/${provider.id}/event`, {
        method: 'POST', body: JSON.stringify({ externalUserId: who.trim(), eventType }),
      });
      setLast({
        entered: 'Entered — counted as simulated, never shown to members.',
        exited: 'Exited.',
        duplicate_entry: 'Already inside — ignored, exactly as a real double scan would be.',
        duplicate_exit: 'Nobody to let out — ignored.',
        denied: 'Denied — recorded, does not count.',
        unmatched: 'That access ID is not mapped to anyone. Map it in Members.',
      }[r.outcome] || r.outcome);
      onEvent?.();
    } catch (e) { setLast(e.message || 'Failed.'); }
    setBusy('');
  };
  return (
    <div className="mt-3 rounded-xl p-3" style={{ border: '1px dashed var(--warn)', background: 'var(--bg2)' }}>
      <div className="text-[10px] uppercase tracking-[.14em] font-grotesk mb-2" style={{ color: 'var(--warn)' }}>
        Demo data — not connected to a real device
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1 min-w-[140px]" placeholder="Mapped access ID" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Demo access ID" />
        <button className="btn btn-sm" onClick={() => send('ENTRY')} disabled={!!busy}>Entry</button>
        <button className="btn btn-sm" onClick={() => send('EXIT')} disabled={!!busy}>Exit</button>
        <button className="btn btn-sm" onClick={() => send('DENIED')} disabled={!!busy}>Denied</button>
      </div>
      {last && <div className="text-[11px] mt-2" style={{ color: 'var(--mute)' }} aria-live="polite">{last}</div>}
    </div>
  );
}

/* ── one connection ───────────────────────────────────────────────── */

function ProviderCard({ p, health, busy, onAction }) {
  const s = STATUS[p.status] || STATUS.CONFIGURED;
  const caps = p.capabilities || {};
  const h = health ? PROVIDER_STATE[health.state] : null;
  const live = p.status !== 'DISABLED';
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-grotesk font-bold text-[14px] truncate" style={{ color: 'var(--ink)' }}>{p.name}</div>
          <div className="text-[11px]" style={{ color: 'var(--mute)' }}>{p.providerKey.replace(/_/g, ' ')}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Pill tone={s.tone}>{s.label}</Pill>
          {h && live && health.state !== 'healthy' && <Pill tone={h.tone} title={health.reasons.join(' ')}>{h.label}</Pill>}
        </div>
      </div>

      <div className="text-[11px] mt-2.5" style={{ color: p.lastTestOk === false ? 'var(--warn)' : 'var(--mute)' }}>
        {p.lastTestedAt ? (p.lastTestOk ? 'Last test passed.' : `Last test failed: ${p.lastTestError}`) : 'Never tested.'}
      </div>
      <div className="text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>
        Last event: <When at={p.lastEventAt} fallback="none yet" />
        {caps.supportsPolling && <> · Last poll: <When at={p.lastPolledAt} fallback="never" /></>}
      </div>
      {health?.reasons?.length > 0 && health.state !== 'healthy' && (
        <ul className="mt-1.5 text-[11px] space-y-0.5" style={{ color: 'var(--warn)' }}>
          {health.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}

      {p.secrets?.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {p.secrets.map((x) => (
            <span key={x.kind} className="chip text-[10px]" title="Never shown again after saving">
              {x.kind.replace(/_/g, ' ')}: <span className="font-mono">{x.masked}</span>
            </span>
          ))}
        </div>
      )}

      {live && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {caps.supportsTestConnection && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('test', p)}>Test connection</button>}
          {caps.supportsWebhooks && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('test-event', p)}>Send test event</button>}
          {caps.supportsWebhooks && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('webhook', p)}>Webhook</button>}
          {p.providerKey !== 'demo' && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('configure', p)}>Configure</button>}
          {caps.supportsPolling && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('sync', p)}>Sync now</button>}
          {caps.supportsHistoricalImport && p.providerKey === 'generic_rest' && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('import', p)}>Import history</button>}
          {p.providerKey === 'csv_import' && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('csv', p)}>Upload CSV</button>}
          {caps.supportsWebhooks && <button className="btn btn-sm" disabled={busy} onClick={() => onAction('rotate', p)}>Rotate secret</button>}
          <button className="btn btn-sm" disabled={busy} onClick={() => onAction('disconnect', p)}>Disconnect</button>
        </div>
      )}
      {live && p.providerKey === 'demo' && <DemoSimulator provider={p} onEvent={() => onAction('refresh')} />}
    </div>
  );
}

export default function ConnectionsPanel({ onToast, onJob }) {
  const [catalogue, setCatalogue] = useState([]);
  const [providers, setProviders] = useState(null);
  const [health, setHealth] = useState({});
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null);   // { kind, provider, data }
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [cat, prov, hl] = await Promise.all([
        api('/admin/access/providers/catalogue'),
        api('/admin/access/providers'),
        api('/admin/access/health').catch(() => ({ providers: [] })),
      ]);
      setCatalogue(cat.providers || []);
      setProviders(prov.providers || []);
      setHealth(Object.fromEntries((hl.providers || []).map((x) => [x.id, x])));
      setError('');
    } catch (e) { setError(e.message || 'Could not load connections.'); }
  }, []);
  useEffect(() => {
    load();
    api('/admin/branches').then((b) => setBranches(b.branches || [])).catch(() => setBranches([]));
  }, [load]);

  const act = async (kind, p) => {
    if (kind === 'refresh') return load();
    if (['configure', 'import', 'csv', 'webhook'].includes(kind)) return setSheet({ kind, provider: p });
    setBusy(true);
    try {
      if (kind === 'test') {
        const r = await api(`/admin/access/providers/${p.id}/test`, { method: 'POST' });
        onToast(r.message);
      } else if (kind === 'test-event') {
        const r = await api(`/admin/access/providers/${p.id}/test-event`, { method: 'POST', body: '{}' });
        setSheet({ kind: 'stages', provider: p, data: r });
      } else if (kind === 'sync') {
        const r = await api(`/admin/access/providers/${p.id}/sync`, { method: 'POST' });
        onToast(r.job.status === 'FAILED' ? `Sync failed: ${r.job.error}` : `Sync ${r.job.status === 'SUCCEEDED' ? 'finished' : 'started'}: ${r.job.processed} events read.`);
        onJob?.(r.job);
      } else if (kind === 'rotate') {
        if (!(await confirm({
          title: 'Rotate the signing secret?',
          body: 'Your access system will be refused until you give it the new secret. Anything it sends in between is rejected, not lost on its side.',
          confirmLabel: 'Rotate secret',
        }))) { setBusy(false); return; }
        const r = await api(`/admin/access/providers/${p.id}/rotate-secret`, { method: 'POST', body: JSON.stringify({ kind: 'webhook_secret' }) });
        setSheet({ kind: 'secret', provider: p, data: { value: r.shownOnce, webhookUrl: `/api/access/hook/${p.id}` } });
      } else if (kind === 'disconnect') {
        if (!(await confirm({
          title: `Disconnect ${p.name}?`,
          body: 'Events from it will be refused and its stored credentials deleted. Its event history stays — past attendance is not removed.',
          confirmLabel: 'Disconnect',
        }))) { setBusy(false); return; }
        const r = await api(`/admin/access/providers/${p.id}`, { method: 'DELETE' });
        onToast(r.note || 'Disconnected.');
      }
      await load();
    } catch (e) { onToast(e.message || 'That did not work.'); }
    setBusy(false);
  };

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!providers) return <Loading />;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button className="btn btn-primary btn-sm" onClick={() => setSheet({ kind: 'connect' })}>Connect an access system</button>
      </div>
      {providers.length === 0 ? (
        <Empty
          title="No access system connected"
          hint="Connect your door controller, turnstile or attendance software and SK OS starts tracking who is inside. Try the Demo connection first to see how it behaves."
          action={<button className="btn btn-primary" onClick={() => setSheet({ kind: 'connect' })}>Connect one</button>}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {providers.map((p) => <ProviderCard key={p.id} p={p} health={health[p.id]} busy={busy} onAction={act} />)}
        </div>
      )}

      {sheet?.kind === 'connect' && (
        <ConnectSheet catalogue={catalogue} branches={branches} onClose={() => setSheet(null)}
          onConnected={(res) => {
            if (res.signingSecretShownOnce) {
              setSheet({ kind: 'secret', data: { value: res.signingSecretShownOnce, webhookUrl: res.webhookUrl } });
            } else { setSheet(null); onToast('Connected. Test it before relying on it.'); }
            load();
          }} />
      )}
      {sheet?.kind === 'secret' && <SecretOnce value={sheet.data.value} webhookUrl={sheet.data.webhookUrl} onDone={() => setSheet(null)} />}
      {sheet?.kind === 'configure' && (
        <ConfigureSheet provider={sheet.provider} onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); onToast('Configuration saved.'); load(); }} />
      )}
      {sheet?.kind === 'stages' && <StagesSheet title="Test event" result={sheet.data} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'import' && (
        <ImportSheet provider={sheet.provider} onClose={() => setSheet(null)}
          onStarted={(job) => { setSheet(null); onToast('Import started — follow it in Sync.'); onJob?.(job); }} />
      )}
      {sheet?.kind === 'csv' && (
        <CsvSheet provider={sheet.provider} onClose={() => setSheet(null)}
          onStarted={(job, truncated) => {
            setSheet(null);
            onToast(truncated ? 'Import started. The file was over 20,000 rows; only the first 20,000 were taken.' : 'Import started — follow it in Sync.');
            onJob?.(job);
          }} />
      )}
      {sheet?.kind === 'webhook' && <WebhookSheet provider={sheet.provider} onClose={() => setSheet(null)} />}
      {confirmDialog}
    </div>
  );
}
