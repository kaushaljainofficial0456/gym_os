/**
 * VOICES & AI AGENTS
 *
 *   Voices   pick from the voice library, design one from a description,
 *            or clone a voice -- only with the speaker's authorization,
 *            which is recorded with the voice
 *   Agents   the two-way AI conversation product: what the agent is for,
 *            the ONLY facts it may state, and approved answers. Every save
 *            is a version. Fixed safety rules are added by the system.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Seg, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { Field, SectionHead, Tag, Tile, useApi } from './shared.jsx';

export default function VoicesAgents() {
  const [tab, setTab] = useState('voices');
  const [toast, setToast] = useState({ msg: '', tone: 'success' });
  const notify = (msg, tone = 'success') => setToast({ msg, tone });
  return (
    <div className="space-y-5">
      <div className="max-w-sm"><Seg value={tab} onChange={setTab} options={[{ value: 'voices', label: 'Voices' }, { value: 'agents', label: 'AI agents' }]} /></div>
      {tab === 'voices' ? <Voices notify={notify} /> : <Agents notify={notify} />}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

/* ───────────── voices ───────────── */

const tierFor = (tiers, provider) => (tiers || []).filter((t) => t.provider === provider).map((t) => t.name).join(' / ') || provider;

function Voices({ notify }) {
  const v = useApi('/followups/voices');
  const [design, setDesign] = useState(false);
  const [clone, setClone] = useState(false);
  const [filter, setFilter] = useState('');
  if (v.loading) return <PageSkeleton label="Loading voices" />;
  if (v.error) return <ErrorState error={v.error} onRetry={v.reload} />;
  const saved = v.data.saved || [];
  const savedIds = new Set(saved.map((s) => s.provider_voice_id));
  const lib = (v.data.library || []).filter((x) => !filter || `${x.name} ${x.accent || ''} ${x.gender || ''} ${x.description || ''}`.toLowerCase().includes(filter.toLowerCase()));
  const add = async (x) => {
    try { await api('/followups/voices', { method: 'POST', body: JSON.stringify({ provider_voice_id: x.voice_id, name: x.name, description: [x.gender, x.accent, x.age].filter(Boolean).join(', ') }) }); v.reload(); notify(`${x.name} added`); } catch (e) { notify(e.message, 'error'); }
  };
  const remove = async (s) => {
    if (!window.confirm(`Remove ${s.name}?${s.source !== 'library' ? ' The voice is deleted from the voice provider too.' : ''}`)) return;
    await api(`/followups/voices/${s.id}`, { method: 'DELETE' }); v.reload();
  };

  return (
    <div className="space-y-6">
      <section>
        <SectionHead title="Your voices" action={(
          <div className="flex gap-2">
            {v.data.can_design && <button type="button" className="btn btn-sm" onClick={() => setDesign(true)}><Icon name="sparkle" size={14} /> Design a voice</button>}
            {v.data.can_clone && <button type="button" className="btn btn-sm" onClick={() => setClone(true)}><Icon name="mic" size={14} /> Use a real voice</button>}
          </div>
        )} />
        <p className="text-[14px] -mt-1 mb-3" style={{ color: 'var(--mute)' }}>Each call quality speaks with its own voices: {(v.data.tiers || []).map((t) => `${t.name}${t.available ? '' : ' (coming soon)'}`).join(', ')}.</p>
        {saved.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No voices yet. Add one from the library below.</Card> : (
          <Card>
            {saved.map((s) => (
              <div key={s.id} className="cm-row">
                <Tile icon="wave" tone={s.source === 'cloned' ? 'energy' : s.source === 'designed' ? 'nutrition' : 'training'} size={36} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{s.name}</div>
                  <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{s.description || ''}</div>
                </div>
                <Tag>{tierFor(v.data.tiers, s.provider)}</Tag>
                <Tag>{s.source === 'cloned' ? 'Real voice' : s.source === 'designed' ? 'Designed' : 'Library'}</Tag>
                <button type="button" className="btn btn-sm" onClick={() => remove(s)}>Remove</button>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section>
        <SectionHead title="Voice library" />
        {!v.data.library_available ? (
          <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>The voice library opens once Barbell connects the voice provider.</Card>
        ) : (
          <>
            <input className="input w-full mb-3" type="search" placeholder="Search by name, accent or style" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search voices" />
            {v.data.library_error && <p className="text-[14px] mb-2" style={{ color: 'var(--bad)' }}>{v.data.library_error}</p>}
            <Card>
              {lib.slice(0, 60).map((x) => (
                <div key={x.voice_id} className="cm-row">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold" style={{ color: 'var(--ink)' }}>{x.name}</div>
                    <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{[tierFor(v.data.tiers, x.provider), x.gender, x.accent, x.age, x.description].filter(Boolean).join(' · ')}</div>
                  </div>
                  {x.preview_url && <button type="button" className="btn btn-sm" onClick={() => new Audio(x.preview_url).play().catch(() => {})}><Icon name="play" size={13} /> Listen</button>}
                  <button type="button" className="btn btn-sm" disabled={savedIds.has(x.voice_id)} onClick={() => add(x)}>{savedIds.has(x.voice_id) ? 'Added' : 'Add'}</button>
                </div>
              ))}
            </Card>
          </>
        )}
      </section>
      {design && <DesignVoice onClose={() => setDesign(false)} onSaved={() => { setDesign(false); v.reload(); notify('Voice saved'); }} />}
      {clone && <CloneVoice onClose={() => setClone(false)} onSaved={() => { setClone(false); v.reload(); notify('Voice created'); }} />}
    </div>
  );
}

function DesignVoice({ onClose, onSaved }) {
  const [desc, setDesc] = useState('A warm, friendly Indian woman in her thirties, clear and upbeat, speaking at a calm pace.');
  const [previews, setPreviews] = useState([]);
  const [pick, setPick] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const make = async () => {
    setBusy(true); setErr('');
    try { const r = await api('/followups/voices/design', { method: 'POST', body: JSON.stringify({ description: desc }) }); setPreviews(r.previews); setPick(null); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { await api('/followups/voices/design/save', { method: 'POST', body: JSON.stringify({ generated_voice_id: pick, name, description: desc }) }); onSaved(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Design a voice" wide
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!pick || !name || busy} onClick={save}>Save voice</button></div>}>
      <div className="space-y-4">
        <Field label="Describe the voice" hint="Gender, age, accent, tone and pace. At least 20 characters.">
          <textarea className="input w-full cm-text" value={desc} maxLength={1000} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <button type="button" className="btn" disabled={busy || desc.length < 20} onClick={make}><Icon name="sparkle" size={14} /> {busy && !previews.length ? 'Making three versions…' : 'Make three versions'}</button>
        {previews.length > 0 && (
          <div className="space-y-2">
            {previews.map((p, i) => (
              <label key={p.generated_voice_id} className="flex items-center gap-3 p-3 rounded-xl cursor-pointer" style={{ border: `1.5px solid ${pick === p.generated_voice_id ? 'var(--ink)' : 'var(--line)'}` }}>
                <input type="radio" name="voice" checked={pick === p.generated_voice_id} onChange={() => setPick(p.generated_voice_id)} />
                <span className="flex-1 font-semibold" style={{ color: 'var(--ink)' }}>Version {i + 1}</span>
                <button type="button" className="btn btn-sm" onClick={(e) => { e.preventDefault(); new Audio(`data:${p.media_type};base64,${p.audio_base64}`).play().catch(() => {}); }}><Icon name="play" size={13} /> Listen</button>
              </label>
            ))}
            <Field label="Name it"><input className="input w-full" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya" /></Field>
          </div>
        )}
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

function CloneVoice({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', speaker: 'self', speaker_name: '', statement: false, file: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const save = async () => {
    setErr('');
    if (!f.file) return setErr('Add a recording of the voice');
    if (f.file.size > 6_000_000) return setErr('Keep the recording under 6 MB (a minute or two is plenty)');
    setBusy(true);
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f.file); });
      await api('/followups/voices/clone', { method: 'POST', body: JSON.stringify({ name: f.name, speaker: f.speaker, speaker_name: f.speaker_name, statement: true, sample_base64: b64, sample_type: f.file.type || 'audio/mpeg' }) });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Use a real voice" wide
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy || !f.statement || !f.name || f.speaker_name.length < 2} onClick={save}>{busy ? 'Creating…' : 'Create voice'}</button></div>}>
      <div className="space-y-4">
        <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Calls can sound like you or a member of your team, but only with that person’s permission. Never use a member’s, a celebrity’s or anyone else’s voice.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Voice name"><input className="input w-full" value={f.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Vikram (owner)" /></Field>
          <Field label="Whose voice is it?"><Select aria-label="Speaker" value={f.speaker} onChange={(v) => set({ speaker: v })} options={[{ value: 'self', label: 'Mine' }, { value: 'staff_with_consent', label: 'A team member who agreed in writing' }]} /></Field>
        </div>
        <Field label="Speaker’s full name"><input className="input w-full" value={f.speaker_name} maxLength={80} onChange={(e) => set({ speaker_name: e.target.value })} /></Field>
        <Field label="Recording" hint="1 to 2 minutes of clear speech, no music or background noise."><input type="file" accept="audio/*" onChange={(e) => set({ file: e.target.files?.[0] || null })} /></Field>
        <label className="flex gap-3 items-start text-[14px]" style={{ color: 'var(--ink)' }}>
          <input type="checkbox" className="mt-1" checked={f.statement} onChange={(e) => set({ statement: e.target.checked })} />
          <span>I am this speaker, or I have their written consent, to create and use an AI copy of this voice for this gym only. This statement is recorded with the voice.</span>
        </label>
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

/* ───────────── AI agents ───────────── */

function Agents({ notify }) {
  const a = useApi('/followups/agents');
  const [edit, setEdit] = useState(null);
  if (a.loading) return <PageSkeleton label="Loading AI agents" />;
  if (a.error) return <ErrorState error={a.error} onRetry={a.reload} />;
  const list = a.data.agents || [];
  return (
    <div className="space-y-4">
      <SectionHead title="AI agents" action={<button type="button" className="btn-primary" onClick={() => setEdit({ name: '', language: 'en', voice_id: null, greeting: '', purpose: '', knowledge: '', faqs: [] })}>+ New agent</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>An AI agent holds a real two-way conversation. It says it is an AI, sticks to the facts you give it, never offers discounts you did not write, and hands over to your team when asked. AI conversations are a separate plan.</p>
      {list.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No AI agents yet.</Card> : (
        <Card>
          {list.map((x) => (
            <button key={x.id} type="button" className="cm-row w-full text-left" onClick={() => setEdit(x)}>
              <Tile icon="robot" tone="nutrition" size={38} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold" style={{ color: 'var(--ink)' }}>{x.name}</div>
                <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{x.purpose}</div>
              </div>
              <Tag>Version {x.version}</Tag>
            </button>
          ))}
        </Card>
      )}
      {edit && <AgentEditor initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); a.reload(); notify('Agent saved as a new version'); }} />}
    </div>
  );
}

function AgentEditor({ initial, onClose, onSaved }) {
  const [x, setX] = useState({ ...initial, faqs: initial.faqs || [] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const settings = useApi('/followups/settings');
  const voices = useApi('/followups/voices');
  const versions = useApi(initial.id ? `/followups/agents/${initial.id}/versions` : null);
  const set = (p) => setX((v) => ({ ...v, ...p }));
  const save = async () => {
    setBusy(true); setErr('');
    const body = { name: x.name, language: x.language, voice_id: x.voice_id || null, greeting: x.greeting || null, purpose: x.purpose, knowledge: x.knowledge || '', faqs: x.faqs.filter((f) => f.q && f.a) };
    try {
      await api(initial.id ? `/followups/agents/${initial.id}` : '/followups/agents', { method: initial.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const test = async () => {
    setErr('');
    try { await api('/followups/test', { method: 'POST', body: JSON.stringify({ channel: 'agent', agent_id: initial.id, language: x.language }) }); setErr('Test call placed to your phone. Check History for the result.'); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title={initial.id ? 'Edit AI agent' : 'New AI agent'} wide
      footer={<div className="flex justify-between gap-2 w-full flex-wrap">{initial.id ? <button type="button" className="btn" onClick={test}><Icon name="phone" size={14} /> Test on my phone</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div></div>}>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Name"><input className="input w-full" value={x.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Renewals helper" /></Field>
          <Field label="Language"><Select aria-label="Language" value={x.language} onChange={(v) => set({ language: v })} options={(settings.data?.languages || []).map((l) => ({ value: l.code, label: l.name }))} /></Field>
          <Field label="Voice"><Select aria-label="Voice" value={x.voice_id || ''} onChange={(v) => set({ voice_id: v || null })} placeholder="Default voice" options={[{ value: '', label: 'Default voice' }, ...(voices.data?.saved || []).map((v) => ({ value: v.provider_voice_id, label: v.name }))]} /></Field>
        </div>
        <Field label="What should the call achieve?" hint="e.g. Find out why they stopped coming and help them book their next visit."><textarea className="input w-full cm-text" value={x.purpose} maxLength={600} onChange={(e) => set({ purpose: e.target.value })} /></Field>
        <Field label="Facts it may share" hint="Opening hours, plans and prices, how to renew, offers you really have. The agent states nothing else."><textarea className="input w-full cm-text" value={x.knowledge || ''} maxLength={4000} onChange={(e) => set({ knowledge: e.target.value })} /></Field>
        <div className="space-y-2">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Approved answers</div>
          {x.faqs.map((f, i) => (
            <div key={i} className="grid sm:grid-cols-[1fr_1.4fr_auto] gap-2">
              <input className="input" placeholder="Question" value={f.q} maxLength={200} onChange={(e) => set({ faqs: x.faqs.map((y, j) => (j === i ? { ...y, q: e.target.value } : y)) })} />
              <input className="input" placeholder="Answer" value={f.a} maxLength={500} onChange={(e) => set({ faqs: x.faqs.map((y, j) => (j === i ? { ...y, a: e.target.value } : y)) })} />
              <button type="button" className="btn btn-sm" onClick={() => set({ faqs: x.faqs.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => set({ faqs: [...x.faqs, { q: '', a: '' }] })}>+ Add an answer</button>
        </div>
        <Field label="Opening line (optional)" hint="Leave empty for: Hi {name}! I'm an AI assistant calling from {gym}. Do you have a minute?"><input className="input w-full" value={x.greeting || ''} maxLength={300} onChange={(e) => set({ greeting: e.target.value })} /></Field>
        <div className="rounded-2xl p-4 text-[13px] space-y-1" style={{ background: 'rgb(var(--tint-rgb) / .05)', color: 'var(--mute)' }}>
          <div className="font-semibold" style={{ color: 'var(--ink)' }}>Always on, whatever you write</div>
          <div>Says it is an AI · only states your facts · no discounts or promises you did not write · no medical advice · never asks for card numbers or OTPs · stops calling when asked · hands over to your team on request · under two minutes</div>
        </div>
        {versions.data?.versions?.length > 1 && <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{versions.data.versions.length} versions saved. The latest is used.</div>}
        {err && <div role="alert" className="text-[14px]" style={{ color: err.startsWith('Test call placed') ? 'var(--m-body)' : 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}
