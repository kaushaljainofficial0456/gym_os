/**
 * CAMPAIGNS -- who is contacted, when, how and with what.
 *
 * The editor reads top to bottom as four questions: When? How? What do
 * they hear or read? Any limits? -- and a live preview answers "who would
 * this reach today, and what would it use?" before anything is switched
 * on. New campaigns are saved paused; the owner starts them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { CHANNEL, KIND, REASON, CALL_MODES, Field, SectionHead, Stepper, Tag, Tile, Pill, TierPicker, num, productName, productShort, useApi } from './shared.jsx';

const BEFORE_CHOICES = [14, 10, 7, 5, 4, 3, 2, 1, 0];
const MISS_CHOICES = [2, 3, 5, 7, 10, 14, 21, 30];
const AUDIENCE = [['all', 'Every member'], ['active', 'Active members'], ['expiring', 'Ending soon'], ['expired', 'Ended recently']];

const blank = (kind = 'missed_visits') => ({
  name: KIND[kind].label, kind, config: {}, sequence: [{ channel: 'call', after_hours: 0 }], per_day: 1, gap_hours: 3,
  language: 'en', voice_tier: 'standard', agent_tier: 'advanced', voice_id: null, script_group_id: null, sms_group_id: null, template_group_id: null, agent_id: null, ends_on: null, budget: {}, branch_id: null,
  recording_id: null, purpose: 'service',
});

/** Which calling mode a sequence uses: prerecorded, interactive, or messages only. */
const modeOf = (sequence) => (sequence.some((s) => s.channel === 'agent') ? 'interactive' : sequence.some((s) => s.channel === 'call') ? 'prerecorded' : 'messages');
const MODE_LABEL = { prerecorded: 'Prerecorded call', interactive: 'AI conversation', messages: 'Messages' };

export default function Campaigns({ go }) {
  const rules = useApi('/followups/rules');
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState({ msg: '', tone: 'success' });
  if (rules.loading) return <PageSkeleton label="Loading campaigns" />;
  if (rules.error) return <ErrorState error={rules.error} onRetry={rules.reload} />;
  const list = rules.data.campaigns;
  const defaults = rules.data.defaults;

  const toggle = async (c) => {
    try {
      await api(`/followups/rules/${c.id}/status`, { method: 'POST', body: JSON.stringify({ status: c.status === 'active' ? 'paused' : 'active' }) });
      rules.reload();
      setToast({ msg: c.status === 'active' ? 'Paused' : 'Started', tone: 'success' });
    } catch (e) { setToast({ msg: e.message, tone: 'error' }); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Delete "${c.name}"? Anything still queued for it is cancelled.`)) return;
    await api(`/followups/rules/${c.id}`, { method: 'DELETE' });
    rules.reload();
  };

  return (
    <div className="space-y-5">
      <SectionHead title="Campaigns" action={<button type="button" className="btn-primary" onClick={() => setEditing({ ...blank(), config: { ...defaults.missed_visits } })}>+ New campaign</button>} />
      {list.length === 0 ? (
        <div className="grid sm:grid-cols-2 gap-3">
          {Object.entries(KIND).map(([k, v]) => (
            <button key={k} type="button" className="text-left" onClick={() => setEditing({ ...blank(k), config: { ...defaults[k] } })}>
              <Card className="p-5 h-full flex gap-3 items-start" hover>
                <Tile icon={v.icon} tone={v.hue} size={44} />
                <div>
                  <div className="font-semibold" style={{ color: 'var(--ink)' }}>{v.label}</div>
                  <div className="text-[14px]" style={{ color: 'var(--mute)' }}>{v.hint}</div>
                </div>
              </Card>
            </button>
          ))}
        </div>
      ) : (
        <Card>
          {list.map((c) => (
            <div key={c.id} className="cm-row">
              <Tile icon={KIND[c.kind].icon} tone={KIND[c.kind].hue} size={40} />
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setEditing({ ...c })}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold truncate" style={{ color: 'var(--ink)' }}>{c.name}</span>
                  <Tag tone={modeOf(c.sequence) === 'interactive' ? 'good' : 'mute'}>{MODE_LABEL[modeOf(c.sequence)]}</Tag>
                  {c.purpose === 'promotional' && <Tag tone="warn">Promotional</Tag>}
                  {c.status !== 'active' && <Tag>Paused</Tag>}
                </div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{c.sequence.map((s) => CHANNEL[s.channel].short).join(' → ')} · {c.schedule}</div>
              </button>
              <button type="button" className="btn btn-sm hidden sm:inline-flex" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}>Delete</button>
              <button type="button" role="switch" aria-checked={c.status === 'active'} aria-label={`${c.name} ${c.status === 'active' ? 'on' : 'off'}`}
                onClick={() => toggle(c)} className="cm-switch" data-on={c.status === 'active'} />
            </div>
          ))}
        </Card>
      )}
      {editing && (
        <CampaignEditor initial={editing} defaults={defaults} go={go} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); rules.reload(); setToast({ msg, tone: 'success' }); }} />
      )}
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

function CampaignEditor({ initial, defaults, onClose, onSaved, go }) {
  const [c, setC] = useState(() => ({ ...blank(initial.kind), ...initial, budget: initial.budget || {} }));
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const scripts = useApi('/followups/scripts');
  const sms = useApi('/followups/sms-templates');
  const wa = useApi('/followups/templates');
  const agents = useApi('/followups/agents');
  const voices = useApi('/followups/voices');
  const settings = useApi('/followups/settings');
  const numbers = useApi('/followups/numbers');
  const cat = useApi('/followups/catalogue');
  const recordings = useApi('/followups/recordings');
  const [preview, setPreview] = useState(null);
  const [voiceSource, setVoiceSource] = useState(initial.script_group_id && !initial.recording_id ? 'text' : 'recording');
  const set = (patch) => setC((x) => ({ ...x, ...patch }));
  const cfg = (patch) => setC((x) => ({ ...x, config: { ...x.config, ...patch } }));

  const used = new Set(c.sequence.map((s) => s.channel));
  const mode = modeOf(c.sequence);
  // The call itself is chosen with the mode cards; only messages are added here.
  const addable = ['sms', 'whatsapp'].filter((ch) => !used.has(ch));
  const setMode = (m) => {
    const messages = c.sequence.filter((s) => s.channel === 'sms' || s.channel === 'whatsapp');
    const call = m === 'prerecorded' ? [{ channel: 'call', after_hours: 0 }] : m === 'interactive' ? [{ channel: 'agent', after_hours: 0 }] : [];
    const seq = [...call, ...messages.map((s, i) => ({ ...s, after_hours: call.length || i ? s.after_hours || 4 : 0 }))];
    set({ sequence: seq.length ? seq : [{ channel: 'sms', after_hours: 0 }] });
  };
  const recs = recordings.data?.recordings || [];
  const pickedRec = recs.find((r) => r.id === c.recording_id);

  // Live preview, debounced.
  const timer = useRef();
  const body = useMemo(() => payload(c), [c]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api('/followups/rules/preview', { method: 'POST', body: JSON.stringify(body) }).then(setPreview).catch(() => setPreview(null));
    }, 500);
    return () => clearTimeout(timer.current);
  }, [body]);

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      if (c.id) await api(`/followups/rules/${c.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/followups/rules', { method: 'POST', body: JSON.stringify(body) });
      onSaved(c.id ? 'Campaign saved' : 'Campaign saved. Switch it on when you are ready.');
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  const langs = settings.data?.languages || [];
  const enabled = new Set(Object.values(settings.data?.settings?.languages || {}).flat());
  const langOptions = langs.filter((l) => enabled.has(l.code) || l.code === c.language).map((l) => ({ value: l.code, label: (l.native !== l.name ? `${l.name} · ${l.native}` : l.name) }));
  const groupOptions = (groups) => (groups || []).map((g) => ({ value: g.group_id, label: g.name, hint: g.variants.map((v) => v.language.toUpperCase() + (v.approved_at ? '' : ' (draft)')).join(' · ') }));
  const tplGroups = (rows, approvedKey) => {
    const m = new Map();
    for (const t of rows || []) { if (!m.has(t.group_id)) m.set(t.group_id, { group_id: t.group_id, name: t.name, variants: [] }); m.get(t.group_id).variants.push({ language: t.language, approved_at: approvedKey(t) }); }
    return [...m.values()];
  };
  const voiceGroups = (scripts.data?.groups || []).filter((g) => g.channel_type === 'voice');

  return (
    <Modal open onClose={onClose} title={c.id ? 'Edit campaign' : 'New campaign'} wide
      footer={(
        <div className="flex items-center justify-between gap-3 w-full flex-wrap">
          <span className="text-[14px]" style={{ color: 'var(--mute)' }}>{preview ? `Would reach ${num(preview.count)} member${preview.count === 1 ? '' : 's'} ${c.kind === 'announcement' && c.config?.send_on ? `on ${c.config.send_on}` : 'today'}` : ' '}</span>
          <div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></div>
        </div>
      )}>
      <div className="space-y-7">
        {/* 1 · When */}
        <section className="space-y-4">
          <Step n={1} title="When" />
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(KIND).map(([k, v]) => (
              <button key={k} type="button" onClick={() => set({ kind: k, config: { ...defaults[k] }, name: c.name === KIND[c.kind].label ? v.label : c.name, purpose: k === 'announcement' ? c.purpose : 'service' })}
                className="flex items-center gap-2.5 p-3 rounded-2xl text-left" aria-pressed={c.kind === k}
                style={{ border: `1.5px solid ${c.kind === k ? 'var(--ink)' : 'var(--line)'}`, background: c.kind === k ? 'rgb(var(--tint-rgb) / .05)' : 'transparent' }}>
                <Tile icon={v.icon} tone={v.hue} size={34} />
                <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{v.label}</span>
              </button>
            ))}
          </div>
          <ScheduleControls kind={c.kind} config={c.config} onChange={cfg} purpose={c.purpose} onPurpose={(p) => set({ purpose: p })} />
          {preview?.schedule && <p className="text-[14px] rounded-xl p-3" style={{ background: 'rgb(var(--tint-rgb) / .05)', color: 'var(--ink)' }}>{preview.schedule}.</p>}
        </section>

        {/* 2 · How */}
        <section className="space-y-3">
          <Step n={2} title="How" hint="Pick how the call goes. SMS and WhatsApp can follow if there is no reply." />
          <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Calling mode">
            {[...Object.entries(CALL_MODES), ['messages', { label: 'Messages only', icon: 'chat', hue: 'strength', what: 'No call: an SMS and/or a WhatsApp message.' }]].map(([k, m]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)}
                className="text-left p-3.5 rounded-2xl flex flex-col gap-2" style={{ border: `1.5px solid ${mode === k ? 'var(--ink)' : 'var(--line)'}`, background: mode === k ? 'rgb(var(--tint-rgb) / .05)' : 'transparent' }}>
                <span className="flex items-center gap-2.5"><Tile icon={m.icon} tone={m.hue} size={32} /><span className="font-semibold leading-tight" style={{ color: 'var(--ink)' }}>{m.label}</span></span>
                <span className="text-[13px] leading-snug" style={{ color: 'var(--mute)' }}>{m.what}</span>
              </button>
            ))}
          </div>
          {c.sequence.map((s, i) => (
            <div key={s.channel} className="flex items-center gap-3 flex-wrap">
              <span className="w-6 text-center text-[13px] font-bold" style={{ color: 'var(--faint)' }}>{i + 1}</span>
              <Tile icon={CHANNEL[s.channel].icon} tone={CHANNEL[s.channel].hue} size={34} />
              <span className="font-semibold flex-1 min-w-[120px]" style={{ color: 'var(--ink)' }}>{CHANNEL[s.channel].label}</span>
              {i > 0 && (
                <span className="flex items-center gap-2 text-[14px]" style={{ color: 'var(--mute)' }}>
                  if no reply after <Stepper value={s.after_hours || 0} min={0} max={12} suffix="h" label="hours"
                    onChange={(v) => set({ sequence: c.sequence.map((x, j) => (j === i ? { ...x, after_hours: v } : x)) })} />
                </span>
              )}
              {c.sequence.length > 1 && !['call', 'agent'].includes(s.channel) && <button type="button" className="btn btn-sm" aria-label={`Remove ${CHANNEL[s.channel].label}`} onClick={() => set({ sequence: c.sequence.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          {addable.length > 0 && c.sequence.length < 4 && (
            <div className="flex flex-wrap gap-2">
              {addable.map((ch) => <Pill key={ch} onClick={() => set({ sequence: [...c.sequence, { channel: ch, after_hours: 4 }] })}>+ {CHANNEL[ch].label}</Pill>)}
            </div>
          )}
          {(used.has('call') || used.has('agent')) && (
            <div className="flex flex-wrap gap-6 pt-1">
              <Field label="Calls a day if unanswered"><Stepper value={c.per_day} min={1} max={3} onChange={(v) => set({ per_day: v })} label="calls" /></Field>
              <Field label="Hours between tries"><Stepper value={c.gap_hours} min={1} max={12} suffix="h" onChange={(v) => set({ gap_hours: v })} label="hours" /></Field>
            </div>
          )}
        </section>

        {/* 3 · What */}
        <section className="space-y-4">
          <Step n={3} title="What they hear or read" hint="Members get their own language when they chose one you use; everyone else gets the fallback." />
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Fallback language"><Select aria-label="Fallback language" value={c.language} onChange={(v) => set({ language: v })} options={langOptions.length ? langOptions : [{ value: 'en', label: 'English' }]} /></Field>
            <Field label="Campaign name"><input className="input w-full" value={c.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} /></Field>
          </div>
          {used.has('call') && (
            <Field label="Call quality" hint="Each quality has its own balance; pick what this campaign deserves.">
              <TierPicker label="Call quality" value={c.voice_tier} onChange={(v) => set({ voice_tier: v, voice_id: null })}
                tiers={(voices.data?.tiers || []).map((t) => ({ ...t }))} />
            </Field>
          )}
          {used.has('agent') && (
            <Field label="Conversation quality">
              <TierPicker label="Conversation quality" value={c.agent_tier} onChange={(v) => set({ agent_tier: v })}
                tiers={(cat.data?.products || []).filter((p) => p.product === 'agent').map((p) => ({ id: p.tier, name: p.tier_name, tagline: p.tagline, available: p.available }))} />
            </Field>
          )}
          {used.has('call') && (
            <div className="space-y-3">
              <Field label="What the call plays">
                <div className="flex gap-1.5 flex-wrap">
                  <Pill on={voiceSource === 'recording'} onClick={() => { setVoiceSource('recording'); set({ script_group_id: null }); }}>Your recording</Pill>
                  <Pill on={voiceSource === 'text'} onClick={() => { setVoiceSource('text'); set({ recording_id: null }); }}>Text read out by a voice</Pill>
                </div>
              </Field>
              <div className="grid sm:grid-cols-2 gap-4">
                {voiceSource === 'recording' ? (
                  <Field label="Recording" hint={<button type="button" className="underline" onClick={() => go('messages')}>Upload or record one</button>}>
                    <Select aria-label="Recording" value={c.recording_id || ''} onChange={(v) => set({ recording_id: v })} placeholder={recs.length ? 'Pick a recording' : 'No recordings yet'}
                      options={recs.map((r) => ({ value: r.id, label: r.name, hint: `${Math.round(r.duration_secs)}s · ${r.language.toUpperCase()}` }))} />
                    {pickedRec && <audio controls preload="none" className="w-full mt-2" src={`/api/followups/recordings/${pickedRec.id}/audio`} aria-label={`Preview ${pickedRec.name}`} />}
                  </Field>
                ) : (
                  <Field label="Voice message" hint={<button type="button" className="underline" onClick={() => go('messages')}>Write a new one</button>}>
                    <Select aria-label="Voice message" value={c.script_group_id || ''} onChange={(v) => set({ script_group_id: v })} placeholder="Pick a message" options={groupOptions(voiceGroups)} />
                  </Field>
                )}
                <Field label="Voice" hint={voiceSource === 'recording' ? 'Speaks the fixed opening notice and the keypad menu around your recording.' : 'Only voices of this call quality. Empty uses your default for the language.'}>
                  <Select aria-label="Voice" value={c.voice_id || ''} onChange={(v) => set({ voice_id: v || null })} placeholder="Default voice"
                    options={[{ value: '', label: 'Default voice' }, ...(voices.data?.saved || [])
                      .filter((v) => v.provider === (voices.data?.tiers || []).find((t) => t.id === c.voice_tier)?.provider)
                      .map((v) => ({ value: v.provider_voice_id, label: v.name, hint: v.source }))]} />
                </Field>
              </div>
              <p className="text-[13px]" style={{ color: 'var(--mute)' }}>
                Every call starts with “This is an automated call from your gym” and ends with the keypad menu: 1 to talk to you, 9 to stop. Those lines are added for you and cannot be removed.
              </p>
            </div>
          )}
          {used.has('agent') && (
            <Field label="AI agent" hint={<button type="button" className="underline" onClick={() => go('voices')}>Create or change an agent</button>}>
              <Select aria-label="AI agent" value={c.agent_id || ''} onChange={(v) => set({ agent_id: v })} placeholder="Pick an agent"
                options={(agents.data?.agents || []).map((a) => ({ value: a.id, label: a.name, hint: a.language.toUpperCase() }))} />
              {(() => {
                const a = (agents.data?.agents || []).find((x) => x.id === c.agent_id);
                if (!a) return null;
                const on = (v) => Number(v ?? 1) === 1;
                return (
                  <span className="flex flex-wrap gap-1.5 mt-2">
                    <Tag tone={on(a.allow_callbacks) ? 'good' : 'mute'}>{on(a.allow_callbacks) ? 'Books call backs' : 'No call backs'}</Tag>
                    <Tag tone={on(a.allow_handover) ? 'good' : 'mute'}>{on(a.allow_handover) ? 'Hands over to your team' : 'No hand-over'}</Tag>
                    <Tag tone={on(a.answer_plans) ? 'good' : 'mute'}>{on(a.answer_plans) ? 'Quotes your plans' : 'Does not quote plans'}</Tag>
                    <Tag>Up to {a.max_minutes || 3} min</Tag>
                  </span>
                );
              })()}
            </Field>
          )}
          {used.has('sms') && (
            <Field label="SMS" hint={<button type="button" className="underline" onClick={() => go('messages')}>Add an SMS template</button>}>
              <Select aria-label="SMS template" value={c.sms_group_id || ''} onChange={(v) => set({ sms_group_id: v })} placeholder="Pick an SMS"
                options={groupOptions(tplGroups(sms.data?.templates, (t) => t.status === 'active'))} />
            </Field>
          )}
          {used.has('whatsapp') && (
            <Field label="WhatsApp template" hint="Only templates WhatsApp approved are sent.">
              <Select aria-label="WhatsApp template" value={c.template_group_id || ''} onChange={(v) => set({ template_group_id: v })} placeholder="Pick a template"
                options={groupOptions(tplGroups(wa.data?.templates, (t) => t.status === 'approved'))} />
            </Field>
          )}
        </section>

        {/* 4 · Limits */}
        <section className="space-y-4">
          <Step n={4} title="Limits" hint="Optional. Your gym-wide daily and weekly limits always apply too." />
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Stop after"><input type="date" className="input w-full" value={c.ends_on || ''} onChange={(e) => set({ ends_on: e.target.value || null })} /></Field>
            {(numbers.data?.branches || []).length > 0 && (
              <Field label="Branch"><Select aria-label="Branch" value={c.branch_id || ''} onChange={(v) => set({ branch_id: v || null })}
                options={[{ value: '', label: 'All branches' }, ...numbers.data.branches.map((b) => ({ value: b.id, label: b.name }))]} /></Field>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            {[...used].map((ch) => {
              const product = CHANNEL[ch].product;
              const label = { voice: 'Budget: call minutes', agent: 'Budget: AI conversation minutes', sms: 'Budget: SMS', whatsapp: 'Budget: WhatsApp messages' }[product];
              return (
                <Field key={ch} label={label}>
                  <input type="number" min={0} className="input w-40" placeholder="No limit" value={c.budget?.[product] ?? ''}
                    onChange={(e) => set({ budget: { ...c.budget, [product]: e.target.value === '' ? undefined : Number(e.target.value) } })} />
                </Field>
              );
            })}
          </div>
        </section>

        {preview && (
          <section className="rounded-2xl p-4 space-y-3" style={{ background: 'rgb(var(--tint-rgb) / .05)' }}>
            <div className="font-semibold" style={{ color: 'var(--ink)' }}>If this were on right now</div>
            <div className="text-[14px]" style={{ color: 'var(--ink)' }}>
              It would contact <b>{num(preview.count)}</b> member{preview.count === 1 ? '' : 's'} today
              {Object.values(preview.estimate).some(Boolean) && <> using about {Object.entries(preview.estimate).filter(([, v]) => v).map(([k, v]) => `${num(v)} ${productShort(preview.products, k)} of ${productName(preview.products, k)}`).join(', ')}</>}.
            </div>
            {preview.members.length > 0 && (
              <div className="flex flex-wrap gap-1.5">{preview.members.slice(0, 12).map((m) => <Tag key={m.client_id}>{m.name.split(' ')[0]} · {CHANNEL[m.channel].short}</Tag>)}{preview.count > 12 && <Tag>+{preview.count - 12} more</Tag>}</div>
            )}
            {Object.keys(preview.held || {}).length > 0 && (
              <div className="text-[13px]" style={{ color: 'var(--mute)' }}>
                Not today: {Object.entries(preview.held).map(([k, n]) => `${n} · ${REASON[k] || k}`).join(' · ')}
              </div>
            )}
          </section>
        )}
        {err && <div role="alert" className="text-[14px] font-semibold" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}

function Step({ n, title, hint }) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-full grid place-items-center text-[13px] font-bold" style={{ background: 'var(--ink)', color: 'var(--bg)' }}>{n}</span>
        <h3 className="text-[17px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
      </div>
      {hint && <p className="text-[13px] mt-1 ml-9" style={{ color: 'var(--mute)' }}>{hint}</p>}
    </div>
  );
}

function ScheduleControls({ kind, config, onChange, purpose, onPurpose }) {
  const c = config || {};
  if (kind === 'announcement') {
    const today = new Date().toISOString().slice(0, 10);
    return (
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Send on" hint="Once, on this day, inside your calling hours. Never sent late.">
            <input type="date" className="input w-full" min={today} value={c.send_on || ''} onChange={(e) => onChange({ send_on: e.target.value || null })} />
          </Field>
          {c.audience === 'expiring' && <Field label="Ending within"><Stepper value={c.expiring_days ?? 7} min={1} max={60} suffix="days" onChange={(v) => onChange({ expiring_days: v })} label="days" /></Field>}
        </div>
        <Field label="To">
          <div className="flex flex-wrap gap-1.5">{AUDIENCE.map(([k, l]) => <Pill key={k} on={(c.audience || 'active') === k} onClick={() => onChange({ audience: k })}>{l}</Pill>)}</div>
        </Field>
        <Field label="What kind of message" hint={purpose === 'promotional'
          ? 'Offers and events reach only members who agreed to offers (a separate permission). A call back they asked for never counts.'
          : 'Service news every member needs, such as a holiday closure or a change in timings.'}>
          <div className="flex flex-wrap gap-1.5">
            <Pill on={purpose !== 'promotional'} onClick={() => onPurpose('service')}>Service: closures, timings</Pill>
            <Pill on={purpose === 'promotional'} onClick={() => onPurpose('promotional')}>Promotional: offers, events</Pill>
          </div>
        </Field>
      </div>
    );
  }
  if (kind === 'membership_ending') {
    const before = new Set(c.before || []);
    return (
      <div className="space-y-4">
        <Field label="Remind them">
          <div className="flex flex-wrap gap-1.5">
            {BEFORE_CHOICES.map((d) => (
              <Pill key={d} on={before.has(d)} onClick={() => { const n = new Set(before); if (n.has(d)) n.delete(d); else n.add(d); onChange({ before: [...n].sort((a, b) => b - a) }); }}>
                {d === 0 ? 'On the day' : `${d} day${d === 1 ? '' : 's'} before`}
              </Pill>
            ))}
          </div>
        </Field>
        <div className="flex flex-wrap gap-6">
          <Field label="After it ends, every"><Stepper value={c.after_every ?? 2} min={0} max={30} suffix="days" onChange={(v) => onChange({ after_every: v })} label="days" /></Field>
          <Field label="Up to"><Stepper value={c.after_max ?? 3} min={0} max={20} suffix="times" onChange={(v) => onChange({ after_max: v })} label="times" /></Field>
        </div>
      </div>
    );
  }
  const first = kind === 'payment_due' ? 'start_after' : 'after_days';
  const every = kind === 'payment_due' ? 'every' : 'repeat_every';
  return (
    <div className="space-y-4">
      {kind === 'missed_visits' && (
        <Field label="Days without a visit">
          <div className="flex flex-wrap gap-1.5">
            {MISS_CHOICES.map((d) => <Pill key={d} on={c.after_days === d} onClick={() => onChange({ after_days: d })}>{d} days</Pill>)}
            <Stepper value={c.after_days ?? 7} min={1} max={90} onChange={(v) => onChange({ after_days: v })} label="days" />
          </div>
        </Field>
      )}
      <div className="flex flex-wrap gap-6">
        {kind !== 'missed_visits' && (
          <Field label={kind === 'payment_due' ? 'Days after it is due' : 'Days after joining'}><Stepper value={c[first] ?? 0} min={kind === 'payment_due' ? 0 : 1} max={60} onChange={(v) => onChange({ [first]: v })} label="days" /></Field>
        )}
        <Field label="Then every"><Stepper value={c[every] ?? 3} min={0} max={30} suffix="days" onChange={(v) => onChange({ [every]: v })} label="days" /></Field>
        <Field label="Up to"><Stepper value={c.max_contacts ?? 3} min={1} max={20} suffix="times" onChange={(v) => onChange({ max_contacts: v })} label="times" /></Field>
      </div>
    </div>
  );
}

function payload(c) {
  const budget = Object.fromEntries(Object.entries(c.budget || {}).filter(([, v]) => Number.isFinite(v) && v >= 0));
  return {
    name: String(c.name || '').trim() || KIND[c.kind].label, kind: c.kind, config: c.config, sequence: c.sequence.map((s, i) => ({ channel: s.channel, after_hours: i === 0 ? 0 : s.after_hours || 0 })),
    per_day: c.per_day, gap_hours: c.gap_hours, language: c.language, voice_tier: c.voice_tier || 'standard', agent_tier: c.agent_tier || 'advanced', voice_id: c.voice_id || null, script_group_id: c.script_group_id || null,
    sms_group_id: c.sms_group_id || null, template_group_id: c.template_group_id || null, agent_id: c.agent_id || null, ends_on: c.ends_on || null,
    budget: Object.keys(budget).length ? budget : undefined, branch_id: c.branch_id || null,
    recording_id: c.recording_id || null, purpose: c.kind === 'announcement' ? c.purpose || 'service' : 'service',
  };
}
