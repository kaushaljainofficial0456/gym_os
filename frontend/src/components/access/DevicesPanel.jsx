/**
 * DEVICES — each reader, gate and turnstile, and which door it is.
 *
 * A device matters to SK OS for two reasons: it tells us which BRANCH an
 * event happened at, and a one-way reader tells us what an event MEANS
 * when the payload does not say. Both are set here.
 *
 * "Online" is never stored. It is derived on the server from when the
 * device last spoke, so a panel that was unplugged an hour ago shows
 * offline here even though nothing about its configuration changed.
 *
 * Removal shows its consequences first -- how many past events point at
 * this device, and whether it is the gym's only one -- because removing
 * the only door is how live occupancy quietly stops updating.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Modal, Empty } from '../UI.jsx';
import { Pill, Field, ErrorLine, Loading, When } from './shared.jsx';

const TYPES = [
  ['turnstile', 'Turnstile / gate'], ['rfid', 'RFID / card reader'], ['qr', 'QR scanner'],
  ['fingerprint', 'Fingerprint reader'], ['face', 'Face recognition'], ['manual', 'Front desk'], ['other', 'Other'],
];
const DIRECTIONS = [
  ['both', 'Both ways — the device says which'], ['entry', 'Entry only'], ['exit', 'Exit only'],
];

function DeviceForm({ initial, providers, branches, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [f, setF] = useState({
    name: initial?.name || '',
    deviceIdentifier: initial?.identifier || '',
    deviceType: initial?.type || 'turnstile',
    direction: initial?.direction || 'both',
    branchId: initial?.branchId || '',
    providerId: '',
    status: initial?.status || 'ACTIVE',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (!f.name.trim()) throw new Error('Give the device a name people will recognise, like "Front turnstile".');
      if (!editing && !f.deviceIdentifier.trim()) throw new Error('The device ID is how SK OS recognises its events. Copy it from your access system.');
      const body = {
        name: f.name.trim(), deviceType: f.deviceType, direction: f.direction, branchId: f.branchId || null,
        ...(editing ? { status: f.status } : { deviceIdentifier: f.deviceIdentifier.trim(), providerId: f.providerId || null }),
      };
      await api(editing ? `/admin/access/devices/${initial.id}` : '/admin/access/devices', {
        method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body),
      });
      onSaved(editing ? 'Device updated.' : 'Device added.');
    } catch (e) { setError(e.message || 'Could not save the device.'); }
    setBusy(false);
  };

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${initial.name}` : 'Add a device'}>
      <div className="space-y-3">
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} placeholder="Front turnstile" /></Field>
        <Field label="Device ID" help={editing ? 'Fixed once added — events are matched on it.' : 'Exactly as your access system reports it, e.g. a serial number.'}>
          <input className="input font-mono" value={f.deviceIdentifier} onChange={set('deviceIdentifier')} disabled={editing} placeholder="ZK-FRONT-1" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Field label="Type">
            <select className="input" value={f.deviceType} onChange={set('deviceType')}>
              {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Direction" help="A one-way reader lets SK OS know what its events mean.">
            <select className="input" value={f.direction} onChange={set('direction')}>
              {DIRECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
        {branches.length > 0 && (
          <Field label="Branch" help="Every event from this device counts toward this branch.">
            <select className="input" value={f.branchId} onChange={set('branchId')}>
              <option value="">Whole gym</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        {!editing && providers.length > 0 && (
          <Field label="Connection">
            <select className="input" value={f.providerId} onChange={set('providerId')}>
              <option value="">None</option>
              {providers.filter((p) => p.status !== 'DISABLED').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {editing && (
          <Field label="Status" help="A disabled device's events are still recorded; disable it while it is being serviced.">
            <select className="input" value={f.status} onChange={set('status')}>
              <option value="ACTIVE">Active</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </Field>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary flex-1" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

function RemoveSheet({ device, onClose, onRemoved }) {
  const [impact, setImpact] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/admin/access/devices/${device.id}/impact`).then(setImpact).catch((e) => setError(e.message));
  }, [device.id]);
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/admin/access/devices/${device.id}`, { method: 'DELETE' });
      onRemoved(`${device.name} removed.`);
    } catch (e) { setError(e.message || 'Could not remove it.'); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Remove ${device.name}?`}>
      <div className="space-y-3">
        {!impact && !error && <Loading label="Checking what this affects…" />}
        {impact && (
          <ul className="space-y-1.5 text-[12.5px] list-disc pl-5" style={{ color: 'var(--mute)' }}>
            {impact.consequences.map((c) => <li key={c}>{c}</li>)}
          </ul>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={onClose}>Keep it</button>
          <button className="btn btn-danger flex-1" onClick={remove} disabled={busy || !impact}>{busy ? 'Removing…' : 'Remove device'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function DevicesPanel({ onToast, canManage }) {
  const [devices, setDevices] = useState(null);
  const [providers, setProviders] = useState([]);
  const [branches, setBranches] = useState([]);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([api('/admin/access/devices'), api('/admin/access/providers')]);
      setDevices(d.devices || []);
      setProviders(p.providers || []);
      setError('');
    } catch (e) { setError(e.message || 'Could not load devices.'); }
  }, []);
  useEffect(() => {
    load();
    api('/admin/branches').then((b) => setBranches(b.branches || [])).catch(() => setBranches([]));
  }, [load]);

  const done = (msg) => { setSheet(null); onToast(msg); load(); };

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!devices) return <Loading />;

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <button className="btn btn-primary btn-sm" onClick={() => setSheet({ kind: 'add' })}>Add a device</button>
        </div>
      )}
      {devices.length === 0 ? (
        <Empty title="No devices yet"
               hint="Add each reader, turnstile or gate so SK OS knows which door — and which branch — an event came from." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {devices.map((d, i) => (
            <div key={d.id} className="flex items-center gap-3 p-3" style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-grotesk font-semibold" style={{ color: 'var(--ink)' }}>{d.name}</span>
                  {d.status === 'DISABLED'
                    ? <Pill tone="mute">Disabled</Pill>
                    : <Pill tone={d.online ? 'good' : d.lastSeenAt ? 'warn' : 'mute'}>{d.online ? 'Online' : d.lastSeenAt ? 'Quiet' : 'Never seen'}</Pill>}
                </div>
                <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                  {TYPES.find(([v]) => v === d.type)?.[1] || d.type} · {d.direction === 'both' ? 'both ways' : `${d.direction} only`}
                  {' · '}<span className="font-mono">{d.identifier}</span>
                  {d.branch ? ` · ${d.branch}` : ''}
                  {' · last event '}<When at={d.lastEventAt} fallback="never" />
                </div>
              </div>
              {canManage && (
                <div className="flex gap-1.5 shrink-0">
                  <button className="btn btn-sm" onClick={() => setSheet({ kind: 'edit', device: d })}>Edit</button>
                  <button className="btn btn-sm" onClick={() => setSheet({ kind: 'remove', device: d })}>Remove</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {(sheet?.kind === 'add' || sheet?.kind === 'edit') && (
        <DeviceForm initial={sheet.device} providers={providers} branches={branches}
                    onClose={() => setSheet(null)} onSaved={done} />
      )}
      {sheet?.kind === 'remove' && <RemoveSheet device={sheet.device} onClose={() => setSheet(null)} onRemoved={done} />}
    </div>
  );
}
