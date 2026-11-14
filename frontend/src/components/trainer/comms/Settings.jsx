/**
 * SETTINGS -- the gym-wide rules every campaign obeys, the languages and
 * voices, the spoken lines, and the compliance checklist that must be
 * confirmed before anything is sent.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, PageSkeleton, Toast } from '../../UI.jsx';
import Select from '../../Select.jsx';
import { Field, Pill, SectionHead, Stepper, Tag, useApi } from './shared.jsx';
import { ModeBanner } from './Overview.jsx';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CHANNEL_LANGS = [['voice', 'AI voice calls'], ['agent', 'AI conversations'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']];
const LINE_KEYS = [['disclosure', 'Opening notice'], ['press1', 'Key 1'], ['press9', 'Key 9'], ['after1', 'After key 1'], ['after2', 'After key 2'], ['after9', 'After key 9'], ['agentIntro', 'AI agent opening']];

export default function Settings() {
  const s = useApi('/followups/settings');
  const ov = useApi('/followups/overview');
  const voices = useApi('/followups/voices');
  const [f, setF] = useState(null);
  const [toast, setToast] = useState({ msg: '' });
  const [lineLang, setLineLang] = useState('en');
  useEffect(() => { if (s.data && !f) setF(s.data.settings); }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (s.loading || !f) return <PageSkeleton label="Loading settings" />;
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  const langs = s.data.languages;
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const compliant = !!f.compliance?.accepted_terms;

  const save = async (patch, msg = 'Saved') => {
    try { const r = await api('/followups/settings', { method: 'PUT', body: JSON.stringify(patch) }); setF(r.settings); setToast({ msg }); } catch (e) { setToast({ msg: e.message, tone: 'error' }); }
  };
  const enabledAll = new Set(Object.values(f.languages || {}).flat());
  const toggleLang = (ch, code) => {
    const cur = new Set(f.languages?.[ch] || []);
    if (cur.has(code)) { if (cur.size > 1) cur.delete(code); } else cur.add(code);
    set({ languages: { ...f.languages, [ch]: [...cur] } });
  };
  const lines = f.lines?.[lineLang] || {};
  const defaults = s.data.default_lines[lineLang];

  return (
    <div className="space-y-6">
      <ModeBanner setup={ov.data?.setup} />

      <Card className="p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-[17px]" style={{ color: 'var(--ink)' }}>AI Communication is {f.enabled ? 'on' : 'off'}</div>
          <div className="text-[14px]" style={{ color: 'var(--mute)' }}>{f.enabled ? 'Running campaigns contact members inside your calling hours.' : 'Nothing is sent while this is off.'}{!compliant && ' Confirm the checklist below first.'}</div>
        </div>
        <button type="button" role="switch" aria-checked={f.enabled} aria-label="AI Communication on or off" className="cm-switch" data-on={f.enabled} disabled={!compliant && !f.enabled}
          onClick={() => save({ enabled: !f.enabled }, f.enabled ? 'Switched off' : 'Switched on')} />
      </Card>

      <section>
        <SectionHead title="When to contact members" />
        <Card className="p-5 space-y-5">
          <div className="flex flex-wrap gap-6">
            <Field label="From"><input type="time" className="input w-36" value={f.window_start} min="09:00" max="21:00" onChange={(e) => set({ window_start: e.target.value })} /></Field>
            <Field label="Until"><input type="time" className="input w-36" value={f.window_end} min="09:00" max="21:00" onChange={(e) => set({ window_end: e.target.value })} /></Field>
          </div>
          <p className="text-[13px] -mt-3" style={{ color: 'var(--mute)' }}>Never before 9:00 or after 21:00, whatever is set here.</p>
          <Field label="On these days">
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => <Pill key={d} on={f.days_mask[i] === '1'} onClick={() => set({ days_mask: f.days_mask.slice(0, i) + (f.days_mask[i] === '1' ? '0' : '1') + f.days_mask.slice(i + 1) })}>{d}</Pill>)}
            </div>
          </Field>
          <div className="flex flex-wrap gap-6">
            <Field label="Calls per member per day" hint="All campaigns together."><Stepper value={f.max_per_day} min={1} max={3} onChange={(v) => set({ max_per_day: v })} label="calls" /></Field>
            <Field label="Contacts per member per week" hint="Calls and messages together."><Stepper value={f.max_per_week} min={1} max={21} onChange={(v) => set({ max_per_week: v })} label="contacts" /></Field>
          </div>
          <Field label="Monthly spending limit" hint="Campaigns pause for the month when usage reaches it. Leave empty for none.">
            <input type="number" min={0} className="input w-48" placeholder="No limit" value={f.monthly_cap_inr ?? ''} onChange={(e) => set({ monthly_cap_inr: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <button type="button" className="btn-primary" onClick={() => save({ window_start: f.window_start, window_end: f.window_end, days_mask: f.days_mask, max_per_day: f.max_per_day, max_per_week: f.max_per_week, monthly_cap_inr: f.monthly_cap_inr })}>Save</button>
        </Card>
      </section>

      <section>
        <SectionHead title="AI conversation transcripts" />
        <Card className="p-5 space-y-4">
          <div className="flex items-start gap-3">
            <button type="button" role="switch" aria-checked={f.keep_transcripts} aria-label="Keep transcripts" className="cm-switch mt-0.5" data-on={f.keep_transcripts}
              onClick={() => save({ keep_transcripts: !f.keep_transcripts }, f.keep_transcripts ? 'Transcripts off. Kept ones were deleted.' : 'Transcripts on')} />
            <div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Keep what was said on AI calls</div>
              <div className="text-[13px]" style={{ color: 'var(--mute)' }}>Only you and your gym’s owners can read them. Summaries are always kept; switching this off deletes the transcripts already kept.</div>
            </div>
          </div>
          {f.keep_transcripts && (
            <Field label="Delete transcripts after" hint="Each transcript is deleted automatically after this many days.">
              <div className="flex flex-wrap gap-1.5">{[30, 90, 180, 365].map((d) => <Pill key={d} on={Number(f.transcript_days) === d} onClick={() => save({ transcript_days: d }, `Kept for ${d} days`)}>{d} days</Pill>)}</div>
            </Field>
          )}
        </Card>
      </section>

      <section>
        <SectionHead title="Languages and voices" />
        <Card className="p-5 space-y-5">
          <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Choose which languages each channel may use. A member who picked one of these in their app gets it; everyone else gets the campaign’s fallback language.</p>
          {CHANNEL_LANGS.map(([ch, label]) => (
            <Field key={ch} label={label}>
              <div className="flex flex-wrap gap-1.5">{langs.map((l) => <Pill key={l.code} on={(f.languages?.[ch] || []).includes(l.code)} onClick={() => toggleLang(ch, l.code)}>{l.name}</Pill>)}</div>
            </Field>
          ))}
          <Field label="Main language"><div className="w-64"><Select aria-label="Main language" value={f.language} onChange={(v) => set({ language: v })} options={langs.map((l) => ({ value: l.code, label: (l.native !== l.name ? `${l.name} · ${l.native}` : l.name) }))} /></div></Field>
          <div className="space-y-2">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Default voice for each call quality and language</div>
            {(voices.data?.tiers || []).filter((t) => t.available).map((t) => (
              <div key={t.id} className="space-y-2 pb-2">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>{t.name}</div>
                {[...new Set([...(f.languages?.voice || []), f.language])].map((code) => {
                  const key = `${t.id}:${code}`;
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <span className="w-28 text-[14px]" style={{ color: 'var(--ink)' }}>{langs.find((l) => l.code === code)?.name}</span>
                      <div className="w-64"><Select aria-label={`${t.name} voice for ${code}`} value={f.voices?.[key] || ''} onChange={(v) => set({ voices: { ...f.voices, [key]: v } })} placeholder="Pick a voice"
                        options={(voices.data?.saved || []).filter((v) => v.provider === t.provider).map((v) => ({ value: v.provider_voice_id, label: v.name }))} /></div>
                    </div>
                  );
                })}
              </div>
            ))}
            {(voices.data?.saved || []).length === 0 && <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Add voices under Voices & AI agents first.</p>}
          </div>
          <Field label="How calls name your gym" hint="Leave empty to use your gym’s name."><input className="input w-full max-w-sm" value={f.gym_display_name || ''} maxLength={60} onChange={(e) => set({ gym_display_name: e.target.value })} /></Field>
          <button type="button" className="btn-primary" onClick={() => save({ languages: f.languages, language: f.language, voices: f.voices || {}, gym_display_name: f.gym_display_name || null })}>Save</button>
        </Card>
      </section>

      <section>
        <SectionHead title="What every call says" />
        <Card className="p-5 space-y-4">
          <p className="text-[14px]" style={{ color: 'var(--mute)' }}>These lines wrap every voice message. Reword them if they sound off in your area. The stop option (key 9) is always offered.</p>
          <div className="w-64"><Select aria-label="Language of the lines" value={lineLang} onChange={setLineLang} options={langs.map((l) => ({ value: l.code, label: l.name }))} /></div>
          {LINE_KEYS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input w-full" maxLength={300} placeholder={defaults[k]} value={lines[k] || ''}
                onChange={(e) => set({ lines: { ...(f.lines || {}), [lineLang]: { ...lines, [k]: e.target.value } } })} />
            </Field>
          ))}
          <button type="button" className="btn-primary" onClick={() => save({ lines: f.lines || {} })}>Save</button>
        </Card>
      </section>

      <section>
        <SectionHead title="SMS sender" />
        <Card className="p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Sender header" hint="The 6-letter header registered on DLT, e.g. IRONFG."><input className="input w-full" value={f.sms_header || ''} maxLength={11} onChange={(e) => set({ sms_header: e.target.value.toUpperCase() })} /></Field>
            <Field label="DLT entity id" hint="Your Principal Entity id from the DLT portal."><input className="input w-full" value={f.dlt_entity_id || ''} maxLength={30} onChange={(e) => set({ dlt_entity_id: e.target.value })} /></Field>
          </div>
          <button type="button" className="btn-primary" onClick={() => save({ sms_header: f.sms_header || null, dlt_entity_id: f.dlt_entity_id || null })}>Save</button>
        </Card>
      </section>

      <Compliance current={f.compliance} onSaved={(c) => { set({ compliance: c }); setToast({ msg: 'Checklist confirmed' }); }} />
      {toast.msg && <Toast message={toast.msg} tone={toast.tone} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

function Compliance({ current, onSaved }) {
  const [c, setC] = useState({ business_registered: !!current?.business_registered, dlt_registered: !!current?.dlt_registered, whatsapp_optin_collected: !!current?.whatsapp_optin_collected, consent_basis: current?.consent_basis || '', accepted_terms: !!current?.accepted_terms });
  const [err, setErr] = useState('');
  const set = (p) => setC((x) => ({ ...x, ...p }));
  const save = async () => {
    setErr('');
    try { const r = await api('/followups/compliance', { method: 'PUT', body: JSON.stringify({ ...c, accepted_terms: true }) }); onSaved(r.compliance); } catch (e) { setErr(e.message); }
  };
  const Check = ({ k, children }) => (
    <label className="flex gap-3 items-start text-[14px]" style={{ color: 'var(--ink)' }}>
      <input type="checkbox" className="mt-1" checked={!!c[k]} onChange={(e) => set({ [k]: e.target.checked })} /><span>{children}</span>
    </label>
  );
  return (
    <section>
      <SectionHead title="Before you start" action={current?.accepted_terms ? <Tag tone="good">Confirmed {current.at ? new Date(current.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}</Tag> : <Tag tone="warn">Needed</Tag>} />
      <Card className="p-5 space-y-4">
        <p className="text-[14px]" style={{ color: 'var(--mute)' }}>Automated calls and messages in India are regulated (TRAI’s TCCCPR, DLT for SMS, WhatsApp’s business policy). Barbell sends only from registered business lines and honours every opt-out, but these points are yours to confirm.</p>
        <Check k="business_registered">My gym is a registered business, and I am authorised to contact its members.</Check>
        <Check k="dlt_registered">If I use SMS: my gym (or Barbell for me) is registered on DLT with the sender header and templates I use.</Check>
        <Check k="whatsapp_optin_collected">If I use WhatsApp: members agreed to receive WhatsApp messages from my gym.</Check>
        <Field label="How members agreed to be contacted" hint="e.g. a clause in the membership form they sign, or the switch in the app.">
          <input className="input w-full" value={c.consent_basis} maxLength={400} onChange={(e) => set({ consent_basis: e.target.value })} />
        </Field>
        <Check k="accepted_terms">I will contact only members who agreed, stop when anyone asks, keep to calling hours, and not use these features to mislead or harass.</Check>
        {err && <div role="alert" className="text-[14px]" style={{ color: 'var(--bad)' }}>{err}</div>}
        <button type="button" className="btn-primary" disabled={!c.business_registered || !c.accepted_terms || c.consent_basis.trim().length < 5} onClick={save}>Confirm</button>
      </Card>
    </section>
  );
}
