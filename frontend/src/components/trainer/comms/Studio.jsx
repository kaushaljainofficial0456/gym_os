/**
 * MESSAGES (Script Studio) -- what members hear and read.
 *
 *   Voice messages  read aloud on AI calls, one variant per language
 *   SMS             DLT-registered text messages, with a live segment count
 *   WhatsApp        templates WhatsApp must approve before they can be sent
 *
 * Details like {name} are inserted with chips, never typed from memory.
 * A translation is shown for the owner to read and save -- nothing is
 * ever sent in a language the owner has not looked at.
 */
import { useRef, useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Seg, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { KIND, Field, SectionHead, Tag, PlaceholderChips, insertAtCursor, smsSegments, AudioButton, useApi } from './shared.jsx';

const PURPOSES = [...Object.entries(KIND).map(([value, v]) => ({ value, label: v.label })), { value: 'general', label: 'Something else' }];

export default function Studio() {
  const [kind, setKind] = useState('voice');
  const settings = useApi('/followups/settings');
  const [toast, setToast] = useState({ msg: '', tone: 'success' });
  if (settings.loading) return <PageSkeleton label="Loading messages" />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={settings.reload} />;
  const ctx = { languages: settings.data.languages, placeholders: settings.data.placeholders, settings: settings.data.settings, notify: (msg, tone = 'success') => setToast({ msg, tone }) };
  return (
    <div className="space-y-5">
      <div className="max-w-md"><Seg value={kind} onChange={setKind} options={[{ value: 'voice', label: 'Voice messages' }, { value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }]} /></div>
      {kind === 'voice' && <VoiceScripts ctx={ctx} />}
      {kind === 'sms' && <SmsTemplates ctx={ctx} />}
      {kind === 'whatsapp' && <WhatsAppTemplates ctx={ctx} />}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

const langLabel = (languages, code) => languages.find((l) => l.code === code)?.name || code;

/* ───────────── voice messages ───────────── */

function VoiceScripts({ ctx }) {
  const list = useApi('/followups/scripts');
  const [edit, setEdit] = useState(null);
  if (list.loading) return <PageSkeleton label="Loading voice messages" />;
  const groups = (list.data?.groups || []).filter((g) => g.channel_type === 'voice');
  return (
    <>
      <SectionHead title="Voice messages" action={<button type="button" className="btn-primary" onClick={() => setEdit({ name: '', purpose: 'missed_visits', language: ctx.settings.language || 'en', body: '' })}>+ New message</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>Every call starts by saying it is an automated call from your gym, and ends with the keypad menu (1 talk to us, 2 on it, 9 stop). You write the middle.</p>
      {groups.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No voice messages yet.</Card> : (
        <Card>
          {groups.map((g) => (
            <div key={g.group_id} className="cm-row flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <div className="font-semibold" style={{ color: 'var(--ink)' }}>{g.name}</div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{KIND[g.purpose]?.label || 'General'}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.variants.map((v) => (
                  <button key={v.id} type="button" onClick={() => setEdit({ ...v, group_id: g.group_id, purpose: g.purpose, name: g.name })}>
                    <Tag tone={v.approved_at ? 'good' : 'warn'}>{langLabel(ctx.languages, v.language)}{v.approved_at ? '' : ' · review'}</Tag>
                  </button>
                ))}
                <button type="button" className="btn btn-sm" onClick={() => setEdit({ group_id: g.group_id, name: g.name, purpose: g.purpose, language: '', body: '', translateFrom: g.variants[0] })}>+ Language</button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {edit && <ScriptEditor ctx={ctx} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); ctx.notify('Saved'); }} />}
    </>
  );
}

function ScriptEditor({ ctx, initial, onClose, onSaved }) {
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [previewText, setPreviewText] = useState('');
  const voices = useApi('/followups/voices');
  const [voice, setVoice] = useState('');
  const box = useRef(null);
  const set = (p) => setS((x) => ({ ...x, ...p }));
  const languageOptions = ctx.languages.map((l) => ({ value: l.code, label: (l.native !== l.name ? `${l.name} · ${l.native}` : l.name) }));

  const run = async (what, fn) => { setBusy(what); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(''); } };
  const draft = () => run('draft', async () => {
    const r = await api('/followups/scripts/draft', { method: 'POST', body: JSON.stringify({ purpose: KIND[s.purpose]?.label || 'a friendly follow-up from the gym', channel_type: 'voice', language: s.language || 'en' }) });
    set({ body: r.text });
    if (!r.ai) setErr('AI writing is not set up on this server, so here is the ready-made message.');
  });
  const starter = () => run('starter', async () => {
    const r = await api(`/followups/starters?language=${s.language || 'en'}`);
    set({ body: r.starters[s.purpose] || r.starters.missed_visits });
  });
  const translate = () => run('translate', async () => {
    const r = await api('/followups/scripts/translate', { method: 'POST', body: JSON.stringify({ body: s.translateFrom.body, from: s.translateFrom.language, to: s.language }) });
    set({ body: r.text });
  });
  const preview = () => run('preview', async () => {
    const r = await api('/followups/preview-text', { method: 'POST', body: JSON.stringify({ channel: 'call', body: s.body, language: s.language || 'en', kind: s.purpose in KIND ? s.purpose : 'missed_visits' }) });
    setPreviewText(r.text);
    return r.text;
  });
  const save = () => run('save', async () => {
    if (!s.group_id && String(s.name || '').trim().length < 2) throw new Error('Give the message a name');
    await api('/followups/scripts', { method: 'POST', body: JSON.stringify({ group_id: s.group_id || null, name: s.name, purpose: s.purpose, channel_type: 'voice', language: s.language, body: s.body, approve: true }) });
    onSaved();
  });
  const hear = async () => {
    const text = previewText || await preview();
    const res = await fetch('/api/followups/hear', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice_id: voice, text, language: s.language }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j.error || 'Could not make the audio'); return null; }
    return URL.createObjectURL(await res.blob());
  };

  return (
    <Modal open onClose={onClose} title={s.id ? 'Edit voice message' : s.group_id ? 'Add a language' : 'New voice message'} wide
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!!busy || !s.body || !s.language} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save and use'}</button></div>}>
      <div className="space-y-4">
        {!s.group_id && (
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Name"><input className="input w-full" value={s.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. We miss you" /></Field>
            <Field label="For"><Select aria-label="Purpose" value={s.purpose} onChange={(v) => set({ purpose: v })} options={PURPOSES} /></Field>
          </div>
        )}
        <Field label="Language"><Select aria-label="Language" value={s.language} onChange={(v) => set({ language: v })} options={languageOptions} placeholder="Pick a language" /></Field>
        <div className="flex flex-wrap gap-2">
          {s.translateFrom && s.language && s.language !== s.translateFrom.language && (
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={translate}><Icon name="globe" size={14} /> {busy === 'translate' ? 'Translating…' : `Translate from ${langLabel(ctx.languages, s.translateFrom.language)}`}</button>
          )}
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={draft}><Icon name="sparkle" size={14} /> {busy === 'draft' ? 'Writing…' : 'Write it for me'}</button>
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={starter}>Use the ready-made one</button>
        </div>
        <Field label="What the voice says" hint="About 20 seconds is right: 2 to 4 short sentences.">
          <textarea ref={box} className="input w-full cm-text" value={s.body} maxLength={900} onChange={(e) => { set({ body: e.target.value }); setPreviewText(''); }} />
        </Field>
        <PlaceholderChips placeholders={ctx.placeholders} onPick={(p) => set({ body: insertAtCursor(box.current, s.body, p) })} />
        <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgb(var(--tint-rgb) / .05)' }}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-semibold" style={{ color: 'var(--ink)' }}>The whole call, for a member called Rahul</span>
            <button type="button" className="btn btn-sm" disabled={!s.body || !!busy} onClick={preview}>{busy === 'preview' ? '…' : 'Show'}</button>
          </div>
          {previewText && <p className="text-[14px] leading-relaxed" style={{ color: 'var(--ink)' }}>{previewText}</p>}
          {voices.data?.library_available ? (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="w-56"><Select aria-label="Voice to hear" value={voice} onChange={setVoice} placeholder="Pick a voice" options={(voices.data?.saved || []).map((v) => ({ value: v.provider_voice_id, label: v.name }))} /></div>
              <AudioButton getUrl={hear} label="Hear it" className="btn btn-sm" />
            </div>
          ) : <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Listening needs the voice provider to be connected.</p>}
        </div>
        {s.translateFrom && <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Read the translation before saving. Saving approves it for calls.</p>}
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

/* ───────────── SMS ───────────── */

function SmsTemplates({ ctx }) {
  const list = useApi('/followups/sms-templates');
  const [edit, setEdit] = useState(null);
  if (list.loading) return <PageSkeleton label="Loading SMS" />;
  const rows = list.data?.templates || [];
  return (
    <>
      <SectionHead title="SMS" action={<button type="button" className="btn-primary" onClick={() => setEdit({ name: '', purpose: 'membership_ending', language: ctx.settings.language || 'en', body: '', dlt_template_id: '', sms_type: 'transactional' })}>+ New SMS</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>In India every business SMS must match a template registered on a DLT portal. Register the exact text there, then paste its template id here.</p>
      {rows.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No SMS templates yet.</Card> : (
        <Card>
          {rows.map((t) => (
            <button key={t.id} type="button" className="cm-row w-full text-left" onClick={() => setEdit(t)}>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate" style={{ color: 'var(--ink)' }}>{t.name} <span className="font-normal" style={{ color: 'var(--mute)' }}>· {langLabel(ctx.languages, t.language)}</span></div>
                <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{t.body}</div>
              </div>
              <Tag>{t.segments} part{t.segments > 1 ? 's' : ''}</Tag>
              <Tag tone={t.status === 'active' ? (t.dlt_template_id ? 'good' : 'warn') : 'mute'}>{t.status === 'active' ? (t.dlt_template_id ? 'Ready' : 'Needs DLT id') : t.status === 'draft' ? 'Draft' : 'Off'}</Tag>
            </button>
          ))}
        </Card>
      )}
      {edit && <SmsEditor ctx={ctx} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); ctx.notify('Saved'); }} />}
    </>
  );
}

function SmsEditor({ ctx, initial, onClose, onSaved }) {
  const [t, setT] = useState(initial);
  const [err, setErr] = useState('');
  const box = useRef(null);
  const set = (p) => setT((x) => ({ ...x, ...p }));
  const seg = smsSegments(t.body);
  const save = async () => {
    setErr('');
    try {
      const body = { name: t.name, purpose: t.purpose, body: t.body, language: t.language, dlt_template_id: t.dlt_template_id || null, sms_type: t.sms_type, status: t.status || 'active' };
      if (t.id) await api(`/followups/sms-templates/${t.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/followups/sms-templates', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title={t.id ? 'Edit SMS' : 'New SMS'} wide
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" onClick={save}>Save</button></div>}>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Name"><input className="input w-full" value={t.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Language"><Select aria-label="Language" value={t.language} onChange={(v) => set({ language: v })} options={ctx.languages.map((l) => ({ value: l.code, label: l.name }))} /></Field>
        </div>
        <Field label="Message" hint={`${seg.length} characters · ${seg.segments} SMS part${seg.segments > 1 ? 's' : ''}${seg.unicode ? ' (Indian scripts use more parts per message)' : ''}. Each part is billed.`}>
          <textarea ref={box} className="input w-full cm-text" value={t.body} maxLength={600} onChange={(e) => set({ body: e.target.value })} />
        </Field>
        <PlaceholderChips placeholders={ctx.placeholders} onPick={(p) => set({ body: insertAtCursor(box.current, t.body, p) })} />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="DLT template id" hint="From your DLT portal, once the exact text is approved."><input className="input w-full" value={t.dlt_template_id || ''} maxLength={30} onChange={(e) => set({ dlt_template_id: e.target.value })} /></Field>
          <Field label="Type"><Select aria-label="SMS type" value={t.sms_type} onChange={(v) => set({ sms_type: v })} options={[{ value: 'transactional', label: 'Service (about their membership)' }, { value: 'promotional', label: 'Promotional' }]} /></Field>
        </div>
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

/* ───────────── WhatsApp ───────────── */

const WA_STATUS = { draft: ['Draft', 'mute'], pending: ['Waiting for WhatsApp', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'], paused: ['Paused by WhatsApp', 'warn'], disabled: ['Disabled', 'bad'] };

function WhatsAppTemplates({ ctx }) {
  const list = useApi('/followups/templates');
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState('');
  if (list.loading) return <PageSkeleton label="Loading WhatsApp templates" />;
  const rows = list.data?.templates || [];
  const act = async (t, what) => {
    setBusy(t.id);
    try { await api(`/followups/templates/${t.id}/${what}`, { method: 'POST' }); list.reload(); ctx.notify(what === 'submit' ? 'Sent to WhatsApp for approval' : 'Status updated'); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <>
      <SectionHead title="WhatsApp templates" action={<button type="button" className="btn-primary" onClick={() => setEdit({ name: '', purpose: 'membership_ending', language: ctx.settings.language || 'en', body: '', category: 'UTILITY' })}>+ New template</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>WhatsApp reviews every template before it can be sent, usually within a day. Each one gets "Call me", "I’m on it" and "Stop messages" buttons automatically.</p>
      {rows.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No templates yet.</Card> : (
        <Card>
          {rows.map((t) => {
            const [label, tone] = WA_STATUS[t.status] || ['?', 'mute'];
            return (
              <div key={t.id} className="cm-row flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{t.name} <span className="font-normal" style={{ color: 'var(--mute)' }}>· {langLabel(ctx.languages, t.language)}</span></div>
                  <div className="text-[13px] line-clamp-2" style={{ color: 'var(--mute)' }}>{t.body}</div>
                  {t.rejection_reason && <div className="text-[13px] mt-1" style={{ color: 'var(--bad)' }}>{t.rejection_reason}</div>}
                </div>
                <Tag tone={tone}>{label}</Tag>
                {['draft', 'rejected'].includes(t.status) && <button type="button" className="btn btn-sm" disabled={busy === t.id} onClick={() => act(t, 'submit')}>Send for approval</button>}
                {t.status === 'pending' && <button type="button" className="btn btn-sm" disabled={busy === t.id} onClick={() => act(t, 'refresh')}>Check status</button>}
              </div>
            );
          })}
        </Card>
      )}
      {edit && <WaEditor ctx={ctx} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload(); ctx.notify('Saved as a draft. Send it for approval when ready.'); }} />}
    </>
  );
}

function WaEditor({ ctx, initial, onClose, onSaved }) {
  const [t, setT] = useState(initial);
  const [err, setErr] = useState('');
  const box = useRef(null);
  const set = (p) => setT((x) => ({ ...x, ...p }));
  const save = async () => {
    setErr('');
    try { await api('/followups/templates', { method: 'POST', body: JSON.stringify({ name: t.name, purpose: t.purpose, body: t.body, language: t.language, category: t.category }) }); onSaved(); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title="New WhatsApp template" wide
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" onClick={save}>Save draft</button></div>}>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Name"><input className="input w-full" value={t.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="For"><Select aria-label="Purpose" value={t.purpose} onChange={(v) => set({ purpose: v, category: v === 'missed_visits' || v === 'onboarding' ? 'MARKETING' : 'UTILITY' })} options={PURPOSES} /></Field>
          <Field label="Language"><Select aria-label="Language" value={t.language} onChange={(v) => set({ language: v })} options={ctx.languages.map((l) => ({ value: l.code, label: l.name }))} /></Field>
          <Field label="WhatsApp category" hint="Reminders about their own membership are Utility; come-back messages are Marketing (WhatsApp may reclassify).">
            <Select aria-label="Category" value={t.category} onChange={(v) => set({ category: v })} options={[{ value: 'UTILITY', label: 'Utility' }, { value: 'MARKETING', label: 'Marketing' }]} />
          </Field>
        </div>
        <Field label="Message"><textarea ref={box} className="input w-full cm-text" value={t.body} maxLength={900} onChange={(e) => set({ body: e.target.value })} /></Field>
        <PlaceholderChips placeholders={ctx.placeholders} onPick={(p) => set({ body: insertAtCursor(box.current, t.body, p) })} />
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}
