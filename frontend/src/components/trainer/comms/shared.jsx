/**
 * AI COMMUNICATION -- shared words and small pieces for the owner's tab.
 * One place for every label, so a status or a reason reads the same on
 * every screen. The backend's reason codes are translated here.
 */
import Icon from '../../Icon.jsx';
import { api } from '../../../api.js';
import { useFetch } from '../../../utils.js';
import './comms.css';

/** useFetch for a path; a null path fetches nothing. */
export const useApi = (path) => useFetch(() => (path ? api(path) : Promise.resolve(null)), [path]);

export const KIND = {
  missed_visits: { label: 'Stopped coming', hint: 'No visit for a while', icon: 'calendar', hue: 'recovery' },
  membership_ending: { label: 'Membership ending', hint: 'Before and after it ends', icon: 'card', hue: 'strength' },
  payment_due: { label: 'Payment pending', hint: 'Until it is paid', icon: 'receipt', hue: 'energy' },
  onboarding: { label: 'New member, not in yet', hint: 'A nudge after joining', icon: 'sparkle', hue: 'body' },
};

export const CHANNEL = {
  call: { label: 'AI voice call', short: 'Call', icon: 'phone', hue: 'training', product: 'voice' },
  agent: { label: 'AI conversation', short: 'AI talk', icon: 'robot', hue: 'nutrition', product: 'agent' },
  sms: { label: 'SMS', short: 'SMS', icon: 'chat', hue: 'strength', product: 'sms' },
  whatsapp: { label: 'WhatsApp', short: 'WhatsApp', icon: 'chat', hue: 'body', product: 'whatsapp' },
};

/** A balance unit's name, from the server's product list ("voice:premium" -> "Premium voice calls"). */
export const productName = (products, key) => (products || []).find((p) => p.key === key)?.name || key;
export const productShort = (products, key) => (products || []).find((p) => p.key === key)?.short || '';
export const PRODUCT_HUE = { voice: 'training', agent: 'nutrition', sms: 'strength', whatsapp: 'body' };

export const STATUS = {
  queued: 'Queued', dialing: 'Calling', answered: 'Answered', completed: 'Connected', no_answer: 'No answer', busy: 'Busy',
  failed: 'Failed', skipped: 'Not sent', sent: 'Sent', delivered: 'Delivered', read: 'Read',
};

export const OUTCOME = {
  callback: 'Wants a call back', on_it: 'Said they’re on it', opted_out: 'Asked to stop', coming_back: 'Coming back',
  renewing: 'Will renew', will_pay: 'Will pay', not_interested: 'Not interested', wrong_number: 'Wrong number', other: 'Other',
};

/** Why someone was not contacted -- the engine's reason codes, in words. */
export const REASON = {
  no_phone: 'No valid mobile number', no_permission: 'No permission yet', refused: 'Said no', opted_out: 'Asked to stop',
  human_only: 'Wants a person only', paused: 'Paused', wrong_number: 'Wrong number', callback_pending: 'Waiting for your call back',
  outside_hours: 'Outside calling hours', outside_member_window: 'Outside their preferred time', daily_cap: 'Daily limit reached',
  weekly_cap: 'Weekly limit reached', no_language: 'No message in their language', missing_details: 'A detail is missing',
  campaign_ended: 'Campaign ended', not_interested: 'Said not interested', snoozed: 'Said they’re on it', step_done: 'Already contacted',
  responded: 'Already responded', in_progress: 'In progress', waiting_gap: 'Waiting before the next try', waiting_to_escalate: 'Waiting before the next channel',
  sequence_done: 'All channels tried', channel_paused: 'Channel paused', no_capacity: 'Out of capacity', budget_reached: 'Campaign budget used',
  no_message: 'No message picked', no_agent: 'No AI agent picked', tier_unavailable: 'That quality is not available yet', template_not_approved: 'WhatsApp template not approved', template_pending: 'WhatsApp template awaiting approval',
};

export const hue = (name) => ({ '--t': `var(--m-${name})`, '--tb': `var(--m-${name}-bg)` });

export function Tile({ icon, tone = 'training', size = 40 }) {
  return (
    <span className="ws-tile shrink-0" style={{ ...hue(tone), '--s': `${size}px` }}>
      <Icon name={icon} size={Math.round(size * 0.48)} strokeWidth={1.8} />
    </span>
  );
}

export function Pill({ on, onClick, children, ...rest }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={!!on} {...rest}
      className="rounded-full font-semibold shrink-0 px-3.5 text-[13px] whitespace-nowrap"
      style={{ minHeight: 36, background: on ? 'var(--ink)' : 'rgb(var(--tint-rgb) / .07)', color: on ? 'var(--bg)' : 'var(--mute)' }}>
      {children}
    </button>
  );
}

export function Tag({ children, tone = 'mute' }) {
  const colour = tone === 'good' ? 'var(--m-body)' : tone === 'warn' ? 'var(--m-strength)' : tone === 'bad' ? 'var(--m-energy)' : 'var(--mute)';
  const bg = tone === 'good' ? 'var(--m-body-bg)' : tone === 'warn' ? 'var(--m-strength-bg)' : tone === 'bad' ? 'var(--m-energy-bg)' : 'rgb(var(--tint-rgb) / .06)';
  return <span className="inline-flex items-center rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap" style={{ minHeight: 24, color: colour, background: bg }}>{children}</span>;
}

export const statusTone = (s) => (['completed', 'delivered', 'read'].includes(s) ? 'good' : ['failed'].includes(s) ? 'bad' : ['no_answer', 'busy', 'skipped'].includes(s) ? 'warn' : 'mute');

export function SectionHead({ title, action }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="text-[17px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h2>
      {action}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="block text-[14px] font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>{label}</span>
      {children}
      {hint && <span className="block text-[13px] mt-1.5" style={{ color: 'var(--mute)' }}>{hint}</span>}
    </label>
  );
}

export function Stepper({ value, onChange, min = 0, max = 99, label, suffix }) {
  const set = (v) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center gap-1 rounded-full p-1" style={{ background: 'rgb(var(--tint-rgb) / .07)' }} role="group" aria-label={label}>
      <button type="button" className="w-9 h-9 rounded-full font-bold" aria-label={`Fewer ${label || ''}`} onClick={() => set(value - 1)} disabled={value <= min}>−</button>
      <span className="min-w-[56px] text-center text-[15px] font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>{value}{suffix ? ` ${suffix}` : ''}</span>
      <button type="button" className="w-9 h-9 rounded-full font-bold" aria-label={`More ${label || ''}`} onClick={() => set(value + 1)} disabled={value >= max}>+</button>
    </div>
  );
}

export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
export const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
export const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
};

export const PLACEHOLDER_LABELS = {
  name: 'First name', gym: 'Gym name', branch: 'Branch', plan: 'Plan', end_date: 'End date', days_left: 'Days left', days_absent: 'Days since last visit',
  days_since_joining: 'Days since joining', amount_due: 'Amount due', gym_phone: 'Gym phone', trainer: 'Trainer', owner: 'Owner', app_link: 'App link',
};

/* Client-side SMS segment count -- mirrors the server (render.js). */
const GSM = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const EXT = new Set(Array.from('^{}\\[~]|€\f'));
export function smsSegments(text) {
  let n = 0;
  for (const ch of String(text || '')) {
    if (GSM.has(ch)) n += 1; else if (EXT.has(ch)) n += 2; else { const u = String(text).length; return { unicode: true, length: u, segments: u <= 70 ? 1 : Math.ceil(u / 67) }; }
  }
  return { unicode: false, length: n, segments: n <= 160 ? 1 : Math.ceil(n / 153) };
}

/** Insert text at the cursor of a textarea, returning the new value. */
export function insertAtCursor(el, value, insert) {
  if (!el) return `${value}${insert}`;
  const s = el.selectionStart ?? value.length;
  const e = el.selectionEnd ?? value.length;
  const next = value.slice(0, s) + insert + value.slice(e);
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + insert.length, s + insert.length); });
  return next;
}

export function PlaceholderChips({ placeholders, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Insert a detail">
      {placeholders.map((p) => (
        <button key={p} type="button" onClick={() => onPick(`{${p}}`)}
          className="rounded-full px-2.5 text-[12px] font-semibold" style={{ minHeight: 28, background: 'var(--m-training-bg)', color: 'var(--m-training)' }}>
          + {PLACEHOLDER_LABELS[p] || p}
        </button>
      ))}
    </div>
  );
}

export function AudioButton({ getUrl, label = 'Hear it', className = 'btn btn-sm' }) {
  const play = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const url = await getUrl();
      if (url) { const a = new Audio(url); await a.play().catch(() => {}); }
    } finally { btn.disabled = false; }
  };
  return <button type="button" className={className} onClick={play}><Icon name="play" size={14} /> {label}</button>;
}

/** Quality tier cards: name, tagline, and "Coming soon" when its provider is not live. */
export function TierPicker({ tiers, value, onChange, label }) {
  return (
    <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label={label}>
      {(tiers || []).map((t) => {
        const on = value === t.id;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={on} disabled={!t.available} onClick={() => onChange(t.id)}
            className="text-left p-3 rounded-2xl" style={{ border: `1.5px solid ${on ? 'var(--ink)' : 'var(--line)'}`, background: on ? 'rgb(var(--tint-rgb) / .05)' : 'transparent', opacity: t.available ? 1 : 0.55 }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold" style={{ color: 'var(--ink)' }}>{t.name}</span>
              {!t.available && <Tag>Coming soon</Tag>}
            </div>
            <div className="text-[13px] mt-1 leading-snug" style={{ color: 'var(--mute)' }}>{t.tagline}</div>
          </button>
        );
      })}
    </div>
  );
}
