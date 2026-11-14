/**
 * MEMBERS & CALL BACKS
 *
 *   Members     who can be reached on which channel, and why not. The owner
 *               records permission members gave (with what proves it); a
 *               member's own "stop" is never overridden from here.
 *   Call backs  members who asked for a person. Automated contact pauses for
 *               them until a call back is closed.
 */
import { useMemo, useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { CHANNEL, OUTCOME, STATUS, Field, Pill, SectionHead, Tag, statusTone, when, useApi } from './shared.jsx';

export default function People({ view }) {
  return view === 'callbacks' ? <Callbacks /> : <Members />;
}

const CH = [['call', 'Calls'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']];

function Members() {
  const m = useApi('/followups/members');
  const settings = useApi('/followups/settings');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [consent, setConsent] = useState(false);
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState({ msg: '' });
  const list = useMemo(() => (m.data?.members || []).filter((x) => {
    if (q && !x.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'reachable') return x.reach.call || x.reach.sms || x.reach.whatsapp;
    if (filter === 'none') return x.phone_ok && !x.reach.call && !x.reach.sms && !x.reach.whatsapp && !Object.values(x.opted_out).some(Boolean);
    if (filter === 'stopped') return Object.values(x.opted_out).some(Boolean) || x.human_only;
    if (filter === 'nophone') return !x.phone_ok;
    return true;
  }), [m.data, filter, q]);
  if (m.loading) return <PageSkeleton label="Loading members" />;
  if (m.error) return <ErrorState error={m.error} onRetry={m.reload} />;

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allPicked = list.length > 0 && list.every((x) => picked.has(x.id));

  return (
    <div className="space-y-4">
      <SectionHead title="Members" action={<button type="button" className="btn-primary" disabled={!picked.size} onClick={() => setConsent(true)}>Record permission{picked.size ? ` (${picked.size})` : ''}</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>Only members who agreed are contacted, separately for calls, SMS and WhatsApp. Members can also switch each one on or off in their own app.</p>
      <input className="input w-full" type="search" placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search members" />
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
        {[['all', 'Everyone'], ['reachable', 'Can be reached'], ['none', 'No permission yet'], ['stopped', 'Asked to stop'], ['nophone', 'No mobile number']].map(([k, l]) => <Pill key={k} on={filter === k} onClick={() => setFilter(k)}>{l}</Pill>)}
      </div>
      <Card>
        <label className="cm-row cursor-pointer" style={{ minHeight: 48 }}>
          <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(list.map((x) => x.id)))} aria-label="Select all shown" />
          <span className="text-[14px]" style={{ color: 'var(--mute)' }}>{list.length} shown{picked.size ? ` · ${picked.size} selected` : ''}</span>
        </label>
        {list.slice(0, 300).map((x) => (
          <div key={x.id} className="cm-row">
            <input type="checkbox" checked={picked.has(x.id)} onChange={() => toggle(x.id)} aria-label={`Select ${x.name}`} />
            <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setDetail(x)}>
              <div className="font-semibold truncate" style={{ color: 'var(--ink)' }}>{x.name}</div>
              <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>
                {!x.phone_ok ? 'No valid mobile number' : x.human_only ? 'Wants a person, not automated contact' : x.paused_until ? `Paused until ${x.paused_until}` : x.branch || ' '}
              </div>
            </button>
            <div className="flex gap-1">
              {CH.map(([k, l]) => (
                <span key={k} title={`${l}: ${x.opted_out[k] ? 'asked to stop' : x.reach[k] ? 'can be reached' : 'no permission'}`}
                  className="w-8 h-8 rounded-full grid place-items-center" style={x.reach[k] ? { background: `var(--m-${CHANNEL[k].hue}-bg)`, color: `var(--m-${CHANNEL[k].hue})` } : { background: 'rgb(var(--tint-rgb) / .05)', color: 'var(--faint)', opacity: x.opted_out[k] ? 0.4 : 1 }}>
                  <Icon name={k === 'call' ? 'phone' : 'chat'} size={14} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </Card>
      {consent && <ConsentModal ids={[...picked]} onClose={() => setConsent(false)} onDone={(r) => { setConsent(false); setPicked(new Set()); m.reload(); setToast({ msg: `Recorded for ${r.changed}${r.kept_member_choice ? `. ${r.kept_member_choice} had turned it off themselves and were left as they chose.` : '.'}` }); }} />}
      {detail && <MemberDetail member={detail} languages={settings.data?.languages || []} onClose={() => setDetail(null)} onChanged={() => m.reload()} />}
      {toast.msg && <Toast message={toast.msg} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

function ConsentModal({ ids, onClose, onDone }) {
  const [channels, setChannels] = useState(new Set(['call', 'sms', 'whatsapp']));
  const [evidence, setEvidence] = useState('Signed the membership form, which includes reminder calls and messages');
  const [attest, setAttest] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    try { onDone(await api('/followups/members/consent', { method: 'POST', body: JSON.stringify({ client_ids: ids, channels: [...channels], action: 'granted', evidence, attest: true }) })); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title={`Record permission for ${ids.length} member${ids.length === 1 ? '' : 's'}`}
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!attest || !channels.size || evidence.trim().length < 5} onClick={save}>Record</button></div>}>
      <div className="space-y-4">
        <Field label="They agreed to">
          <div className="flex gap-1.5 flex-wrap">{CH.map(([k, l]) => <Pill key={k} on={channels.has(k)} onClick={() => setChannels((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>{l}</Pill>)}</div>
        </Field>
        <Field label="How you know" hint="Kept with each member’s record, as proof."><input className="input w-full" value={evidence} maxLength={300} onChange={(e) => setEvidence(e.target.value)} /></Field>
        <label className="flex gap-3 items-start text-[14px]" style={{ color: 'var(--ink)' }}>
          <input type="checkbox" className="mt-1" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>I confirm these members agreed to receive automated calls and messages from this gym, as stated above. Members who switched a channel off themselves stay off.</span>
        </label>
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

function MemberDetail({ member, languages, onClose, onChanged }) {
  const h = useApi(`/followups/members/${member.id}/history`);
  const [msg, setMsg] = useState('');
  const patch = async (body) => {
    try { await api(`/followups/members/${member.id}/prefs`, { method: 'PUT', body: JSON.stringify(body) }); setMsg('Saved'); onChanged(); } catch (e) { setMsg(e.message); }
  };
  const pauseFor = (days) => {
    const d = new Date(Date.now() + days * 86_400_000);
    patch({ paused_until: days ? d.toISOString().slice(0, 10) : null });
  };
  return (
    <Modal open onClose={onClose} title={member.name} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          {CH.map(([k, l]) => <Tag key={k} tone={member.reach[k] ? 'good' : member.opted_out[k] ? 'bad' : 'mute'}>{l}: {member.opted_out[k] ? 'asked to stop' : member.reach[k] ? 'yes' : 'no permission'}</Tag>)}
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Pause automated contact">
            <Select aria-label="Pause" value={member.paused_until ? 'keep' : ''} onChange={(v) => v !== 'keep' && pauseFor(Number(v))}
              options={[{ value: '', label: 'Not paused' }, ...(member.paused_until ? [{ value: 'keep', label: `Until ${member.paused_until}` }] : []), { value: '7', label: '1 week' }, { value: '14', label: '2 weeks' }, { value: '30', label: '1 month' }]} />
          </Field>
          <Field label="Calls a day, at most">
            <Select aria-label="Calls a day" value={String(member.max_per_day || '')} onChange={(v) => patch({ max_per_day: v ? Number(v) : null })}
              options={[{ value: '', label: 'Gym default' }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
          </Field>
          <Field label="Language">
            <Select aria-label="Language" value={member.language || ''} onChange={(v) => patch({ language: v || null })}
              options={[{ value: '', label: 'Not set' }, ...languages.map((l) => ({ value: l.code, label: l.name }))]} />
          </Field>
        </div>
        {msg && <div className="text-[13px]" style={{ color: 'var(--mute)' }} role="status">{msg}</div>}
        <section>
          <div className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Contact history</div>
          {(h.data?.jobs || []).length === 0 ? <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Not contacted yet.</p> : (
            <div className="space-y-1.5">
              {h.data.jobs.map((j) => (
                <div key={j.id} className="flex items-center gap-2 text-[14px] flex-wrap">
                  <span style={{ color: 'var(--faint)' }}>{when(j.created_at)}</span>
                  <span style={{ color: 'var(--ink)' }}>{CHANNEL[j.channel]?.label}</span>
                  <Tag tone={statusTone(j.status)}>{STATUS[j.status]}</Tag>
                  {j.outcome && <Tag tone="good">{OUTCOME[j.outcome] || j.outcome}</Tag>}
                  {j.campaign && <span style={{ color: 'var(--mute)' }}>· {j.campaign}</span>}
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <div className="font-semibold mb-2" style={{ color: 'var(--ink)' }}>Permission record</div>
          {(h.data?.consent || []).length === 0 ? <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Nothing recorded yet.</p> : (
            <div className="space-y-1 text-[13px]" style={{ color: 'var(--mute)' }}>
              {h.data.consent.map((c, i) => <div key={i}>{when(c.created_at)} · {c.channel} · {c.action.replace('_', ' ')} by {c.source}{c.evidence ? ` · “${c.evidence}”` : ''}</div>)}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ───────────── call backs ───────────── */

const CB_STATUS = { new: 'New', assigned: 'Assigned', in_progress: 'In progress', completed: 'Done', unreachable: 'Could not reach', cancelled: 'Cancelled' };

function Callbacks() {
  const [show, setShow] = useState('open');
  const c = useApi(`/followups/callbacks${show === 'open' ? '' : `?status=${show}`}`);
  const [toast, setToast] = useState({ msg: '' });
  if (c.loading) return <PageSkeleton label="Loading call backs" />;
  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  const update = async (cb, body) => {
    try { await api(`/followups/callbacks/${cb.id}`, { method: 'PUT', body: JSON.stringify(body) }); c.reload(); setToast({ msg: 'Updated' }); } catch (e) { setToast({ msg: e.message, tone: 'error' }); }
  };
  const list = c.data.callbacks;
  return (
    <div className="space-y-4">
      <SectionHead title="Call backs" />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>Members who asked to talk to a person. Automated calls and messages pause for them until you close their call back.</p>
      <div className="flex gap-1.5">{[['open', 'Open'], ['completed', 'Done'], ['unreachable', 'Could not reach']].map(([k, l]) => <Pill key={k} on={show === k} onClick={() => setShow(k)}>{l}</Pill>)}</div>
      {list.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>{show === 'open' ? 'Nobody is waiting for a call back.' : 'Nothing here.'}</Card> : (
        <div className="space-y-3">
          {list.map((cb) => (
            <Card key={cb.id} className="p-4 space-y-3">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{cb.member_name}</div>
                  <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{when(cb.created_at)} · {CHANNEL[cb.channel]?.label || cb.channel}{cb.campaign ? ` · ${cb.campaign}` : ''}</div>
                </div>
                <Tag tone={cb.priority === 'high' ? 'warn' : 'mute'}>{CB_STATUS[cb.status]}</Tag>
                {cb.phone && <a className="btn btn-sm" href={`tel:${cb.phone}`}><Icon name="phone" size={14} /> Call</a>}
              </div>
              {cb.reason && <p className="text-[14px]" style={{ color: 'var(--ink)' }}>{cb.reason}</p>}
              {show === 'open' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="w-52"><Select aria-label="Assign to" value={cb.assigned_to || ''} onChange={(v) => update(cb, { assigned_to: v || null })} placeholder="Assign to" options={(c.data.staff || []).map((s) => ({ value: s.id, label: s.name }))} /></div>
                  <button type="button" className="btn btn-sm" onClick={() => update(cb, { status: 'completed', note: window.prompt('What happened? (optional)') || undefined })}>Done</button>
                  <button type="button" className="btn btn-sm" onClick={() => update(cb, { status: 'unreachable' })}>Could not reach</button>
                </div>
              )}
              {cb.note && <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Note: {cb.note}</p>}
            </Card>
          ))}
        </div>
      )}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}
