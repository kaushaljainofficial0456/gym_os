/**
 * MEMBERS — which access ID belongs to which person, and whether the door
 * should let them in.
 *
 * Two columns of status on purpose, because they are two different facts:
 *
 *   Should be   what SK OS thinks from the membership (or an override).
 *   Door        what the access system has actually been told.
 *
 * When they differ, that difference is the thing an owner needs to act
 * on -- most often a lapsed member at a door SK OS cannot update, which
 * has to be fixed at the device by hand. Showing one merged status would
 * hide exactly that case.
 *
 * Nothing biometric is stored or shown. An access ID is the card number
 * or user id the access system already uses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Modal, Empty, useConfirm } from '../UI.jsx';
import InfoDot from '../InfoDot.jsx';
import { Pill, Label, Field, ErrorLine, Loading, When, ACCESS_STATUS } from './shared.jsx';

function MapForm({ unmapped, providers, onClose, onSaved }) {
  const [userId, setUserId] = useState(unmapped[0]?.id || '');
  const [externalUserId, setExt] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (!userId) throw new Error('Choose a member.');
      if (!externalUserId.trim()) throw new Error('Enter the access ID your system uses for them.');
      await api('/admin/access/mappings', {
        method: 'POST', body: JSON.stringify({ userId, externalUserId: externalUserId.trim(), providerId: providerId || null }),
      });
      onSaved();
    } catch (e) { setError(e.message || 'Could not map the member.'); }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title="Map a member">
      <div className="space-y-3">
        <Field label="Member">
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {unmapped.map((u) => <option key={u.id} value={u.id}>{u.name}{u.role && u.role !== 'CLIENT' ? ` (${u.role.toLowerCase()})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Access ID" help="The card number, badge ID or user ID your access system uses for this person. Not a fingerprint — SK OS never stores one.">
          <input className="input font-mono" value={externalUserId} onChange={(e) => setExt(e.target.value)} placeholder="GYM-0042" autoComplete="off" />
        </Field>
        {providers.length > 0 && (
          <Field label="Connection">
            <select className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Any connection</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <ErrorLine>{error}</ErrorLine>
        <div className="flex gap-2">
          <button className="btn flex-1" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary flex-1" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Map member'}</button>
        </div>
      </div>
    </Modal>
  );
}

function OverrideForm({ mapping, onClose, onSaved }) {
  const [access, setAccess] = useState(mapping.overrideAccess || (mapping.desiredAccess === 'DENIED' ? 'ALLOWED' : 'DENIED'));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (clear = false) => {
    setBusy(true); setError('');
    try {
      const r = await api(`/admin/access/mappings/${mapping.id}/override`, {
        method: 'POST', body: JSON.stringify(clear ? { access: null } : { access, reason: reason.trim() }),
      });
      onSaved(r.message || (clear ? 'Override cleared.' : 'Override saved.'));
    } catch (e) { setError(e.message || 'Could not save the override.'); }
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} title={`Override access for ${mapping.userName}`}>
      <div className="space-y-3">
        <p className="text-[12px]" style={{ color: 'var(--mute)' }}>
          An override beats the membership rule until you clear it. Who set it, when and why are recorded.
        </p>
        <Field label="Access">
          <select className="input" value={access} onChange={(e) => setAccess(e.target.value)}>
            <option value="ALLOWED">Allow, whatever the membership says</option>
            <option value="DENIED">Deny, whatever the membership says</option>
          </select>
        </Field>
        <Field label="Reason" help="Required. It is what someone reviewing this later will read.">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Paid in cash at the desk" />
        </Field>
        <ErrorLine>{error}</ErrorLine>
        <div className="flex gap-2">
          {mapping.overrideAccess && <button className="btn flex-1" onClick={() => save(true)} disabled={busy}>Clear override</button>}
          <button className="btn btn-primary flex-1" onClick={() => save(false)} disabled={busy}>{busy ? 'Saving…' : 'Save override'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function MembersPanel({ onToast, canManage }) {
  const [data, setData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([api('/admin/access/mappings'), api('/admin/access/providers')]);
      setData(m);
      setProviders((p.providers || []).filter((x) => x.status !== 'DISABLED'));
      setError('');
    } catch (e) { setError(e.message || 'Could not load members.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const pushable = useMemo(() => new Set(providers.filter((p) => p.capabilities?.supportsAccessPermissionSync).map((p) => p.id)), [providers]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data?.mappings || [];
    if (!q) return list;
    return list.filter((m) => [m.userName, m.userEmail, m.externalUserId].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [data, query]);

  const counts = useMemo(() => {
    const list = data?.mappings || [];
    return {
      denied: list.filter((m) => m.desiredAccess === 'DENIED').length,
      mismatch: list.filter((m) => m.desiredAccess === 'DENIED' && m.accessStatus !== 'DENIED').length,
      failed: list.filter((m) => m.accessStatus === 'SYNC_FAILED').length,
    };
  }, [data]);

  const run = async (kind, m) => {
    setBusy(kind + (m?.id || ''));
    try {
      if (kind === 'check') {
        const r = await api('/admin/access/access-sync/run', { method: 'POST' });
        onToast(`Checked ${r.evaluated}: ${r.denied} should be denied, ${r.pushed} updated at the door${r.failed ? `, ${r.failed} failed` : ''}.`);
      } else if (kind === 'reprocess') {
        const r = await api('/admin/access/events/reprocess-unmatched', { method: 'POST' });
        onToast(r.examined === 0 ? 'No unmatched scans to reprocess.' : `${r.matched} of ${r.examined} unmatched scans are now attributed.`);
      } else if (kind === 'sync') {
        const r = await api(`/admin/access/mappings/${m.id}/sync`, { method: 'POST' });
        onToast(r.message || `Door access is now ${ACCESS_STATUS[r.accessStatus]?.label.toLowerCase() || r.accessStatus}.`);
      } else if (kind === 'unmap') {
        if (!(await confirm({
          title: `Unmap ${m.userName}?`,
          body: 'Their future scans will be recorded as unrecognised until they are mapped again. Past attendance stays.',
          confirmLabel: 'Unmap',
        }))) { setBusy(''); return; }
        await api(`/admin/access/mappings/${m.id}`, { method: 'DELETE' });
        onToast('Unmapped.');
      }
      await load();
    } catch (e) { onToast(e.message || 'That did not work.'); }
    setBusy('');
  };

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!data) return <Loading />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <input className="input flex-1 min-w-[180px]" placeholder="Search name, email or access ID"
               value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search members" />
        {canManage && (
          <>
            <button className="btn btn-sm" onClick={() => run('check')} disabled={!!busy}>{busy === 'check' ? 'Checking…' : 'Check memberships'}</button>
            <button className="btn btn-sm" onClick={() => run('reprocess')} disabled={!!busy}>{busy === 'reprocess' ? 'Working…' : 'Reprocess unmatched scans'}</button>
            <button className="btn btn-primary btn-sm" onClick={() => setSheet({ kind: 'map' })} disabled={!data.unmapped?.length}>Map a member</button>
          </>
        )}
      </div>

      {(counts.mismatch > 0 || counts.failed > 0) && (
        <div className="rounded-xl p-3 text-[12px]" style={{ border: '1px solid var(--warn)', background: 'var(--bg2)', color: 'var(--ink)' }}>
          {counts.mismatch > 0 && <div>{counts.mismatch} {counts.mismatch === 1 ? 'person whose membership has lapsed may' : 'people whose memberships have lapsed may'} still open the door.</div>}
          {counts.failed > 0 && <div>{counts.failed} access {counts.failed === 1 ? 'update' : 'updates'} failed; SK OS retries on the next check.</div>}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="px-3 pt-3">
          <Label right={
            <InfoDot label="the two statuses" title="Should be vs door" size={26} align="end">
              &ldquo;Should be&rdquo; comes from the membership: an end date past its grace period, or a paused,
              suspended or transferred membership, means denied. &ldquo;Door&rdquo; is what the access system has
              been told. If your system cannot be updated from SK OS, the door column says so and the person
              has to be removed at the device.
            </InfoDot>
          }>Mapped ({data.mappings.length})</Label>
        </div>
        {shown.length === 0 ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--mute)' }}>
            {data.mappings.length ? 'Nobody matches that search.' : 'Nobody is mapped yet, so scans cannot be attributed to anyone.'}
          </div>
        ) : shown.map((m) => {
          const door = ACCESS_STATUS[m.accessStatus] || ACCESS_STATUS.NOT_SUPPORTED;
          return (
            <div key={m.id} className="p-3 flex flex-wrap items-center gap-x-3 gap-y-2" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="min-w-0 flex-1 basis-[180px]">
                <div className="text-[13px] font-grotesk font-semibold truncate" style={{ color: 'var(--ink)' }}>{m.userName || 'Unknown'}</div>
                <div className="text-[10.5px] truncate" style={{ color: 'var(--faint)' }}>
                  <span className="font-mono">{m.externalUserId}</span>{m.providerName ? ` · ${m.providerName}` : ''}
                  {m.lastSyncedAt && <> · synced <When at={m.lastSyncedAt} /></>}
                </div>
                {m.overrideAccess && (
                  <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--warn)' }}>
                    Override: {m.overrideAccess.toLowerCase()} — {m.overrideReason}
                  </div>
                )}
                {m.syncError && <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--bad)' }}>{m.syncError}</div>}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[9.5px] uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>Should be</span>
                <Pill tone={m.desiredAccess === 'DENIED' ? 'bad' : m.desiredAccess === 'ALLOWED' ? 'good' : 'mute'}>
                  {m.desiredAccess ? m.desiredAccess.toLowerCase() : 'not checked'}
                </Pill>
                <span className="text-[9.5px] uppercase tracking-[.1em]" style={{ color: 'var(--faint)' }}>Door</span>
                <Pill tone={door.tone}>{door.label}</Pill>
              </div>
              {canManage && (
                <div className="flex gap-1.5">
                  {pushable.has(m.providerId) && <button className="btn btn-sm" onClick={() => run('sync', m)} disabled={!!busy}>Sync</button>}
                  <button className="btn btn-sm" onClick={() => setSheet({ kind: 'override', mapping: m })}>Override</button>
                  <button className="btn btn-sm" onClick={() => run('unmap', m)} disabled={!!busy}>Unmap</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data.unmapped?.length > 0 && (
        <div className="card p-3">
          <Label>Not yet mapped ({data.unmapped.length})</Label>
          <div className="text-[11px] mb-2" style={{ color: 'var(--mute)' }}>
            Their scans are recorded but not attributed to them until they are mapped.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.unmapped.slice(0, 60).map((u) => <span key={u.id} className="chip text-[11px]">{u.name}</span>)}
          </div>
        </div>
      )}

      {sheet?.kind === 'map' && (
        <MapForm unmapped={data.unmapped} providers={providers} onClose={() => setSheet(null)}
                 onSaved={() => { setSheet(null); onToast('Mapped. Use “Reprocess unmatched scans” to attribute their earlier scans.'); load(); }} />
      )}
      {sheet?.kind === 'override' && (
        <OverrideForm mapping={sheet.mapping} onClose={() => setSheet(null)}
                      onSaved={(msg) => { setSheet(null); onToast(msg); load(); }} />
      )}
      {confirmDialog}
    </div>
  );
}
