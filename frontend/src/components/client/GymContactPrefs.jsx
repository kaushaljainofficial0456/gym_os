/**
 * CALLS & MESSAGES FROM YOUR GYM -- the member's own switches for the
 * gym's automated follow-ups (AI calls, SMS, WhatsApp), their language
 * and the time of day that suits them.
 *
 * Turning a channel off here stops it from every number and campaign of
 * the gym, at once, and only the member can turn it back on. Hidden for
 * people who are not members of a gym.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Card } from '../UI.jsx';
import Select from '../Select.jsx';

const CHANNELS = [
  ['call', 'Reminder calls', 'Automated calls about your membership and visits'],
  ['sms', 'SMS', 'Text reminders'],
  ['whatsapp', 'WhatsApp', 'Messages on WhatsApp'],
];

export default function GymContactPrefs() {
  const [d, setD] = useState(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => { api('/followups/me').then(setD).catch(() => setD({ available: false })); }, []);
  if (!d?.available) return null;

  const save = async (patch) => {
    setSaving(true); setNote('');
    const next = { ...d, ...patch, channels: { ...d.channels, ...(patch.channels || {}) } };
    setD(next);
    try {
      await api('/followups/me', { method: 'PUT', body: JSON.stringify({ ...(patch.channels || {}), ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'channels')) }) });
      setNote('Saved');
    } catch (e) { setNote(e.message); setD(d); } finally { setSaving(false); }
  };

  return (
    <Card className="p-4 space-y-1">
      <div className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>Calls & messages from {d.gym}</div>
      <p className="text-[11px] leading-snug pb-1" style={{ color: 'var(--mute)' }}>Your gym can remind you about renewals, payments and visits. Choose what you are happy to get. Switching something off stops it straight away.</p>
      {CHANNELS.map(([k, label, hint]) => (
        <Row key={k} label={label} hint={hint} checked={!!d.channels[k]} disabled={saving} onChange={(v) => save({ channels: { [k]: v } })} />
      ))}
      <Row label="Only a person, never automated" hint="Your gym’s team can still call you themselves" checked={!!d.human_only} disabled={saving} onChange={(v) => save({ human_only: v })} />
      <Row label="Offers and events" hint="Promotions and event news. Separate from reminders, and off unless you turn it on" checked={!!d.offers} disabled={saving} onChange={(v) => save({ offers: v })} />
      <div className="grid grid-cols-2 gap-2 pt-2">
        <label className="block text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Language
          <div className="mt-1"><Select aria-label="Language for calls and messages" value={d.language || ''} onChange={(v) => save({ language: v || null })}
            options={[{ value: '', label: 'Gym’s choice' }, ...d.languages.map((l) => ({ value: l.code, label: l.native }))]} /></div>
        </label>
        <label className="block text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Best time
          <div className="mt-1"><Select aria-label="Best time to contact you" value={d.window_start ? `${d.window_start}-${d.window_end}` : ''} onChange={(v) => { const [a, b] = v ? v.split('-') : [null, null]; save({ window_start: a, window_end: b }); }}
            options={[{ value: '', label: 'Any time' }, { value: '09:00-12:00', label: 'Morning' }, { value: '12:00-17:00', label: 'Afternoon' }, { value: '17:00-21:00', label: 'Evening' }]} /></div>
        </label>
      </div>
      {note && <p className="text-[11px] pt-1" role="status" style={{ color: 'var(--mute)' }}>{note}</p>}
    </Card>
  );
}

function Row({ label, hint, checked, onChange, disabled }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} disabled={disabled} role="switch" aria-checked={checked}
      className="w-full flex items-center justify-between gap-3 text-left" style={{ minHeight: 46, paddingTop: 4, paddingBottom: 4 }}>
      <span className="min-w-0 flex-1">
        <span className="block truncate" style={{ fontSize: 13, fontWeight: 550, color: 'var(--ink)' }}>{label}</span>
        <span className="block text-[11px] mt-0.5 leading-snug" style={{ color: 'var(--mute)' }}>{hint}</span>
      </span>
      <span aria-hidden="true" className="relative shrink-0 rounded-full transition-colors" style={{ width: 42, height: 24, background: checked ? 'var(--accent)' : 'var(--line)' }}>
        <span className="absolute rounded-full transition-transform" style={{ top: 3, left: 3, width: 18, height: 18, background: checked ? 'var(--accent-contrast)' : 'var(--panel)', transform: checked ? 'translateX(18px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,.3)' }} />
      </span>
    </button>
  );
}
