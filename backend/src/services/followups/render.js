// ============================================================
// RENDERING -- the words a member hears or reads, phone numbers in E.164,
// and how many SMS segments a text really costs.
//
// Owners write {name}-style placeholders (easy to type). The master
// prompt's {{client_first_name}}-style names are accepted too and mapped
// to the same values. A message that needs a detail a member does not have
// is NEVER sent with a blank -- missingDetails() catches it and the engine
// holds that member for review instead.
// ============================================================
import { localeFor, spokenLines } from './languages.js';

export const PLACEHOLDERS = ['name', 'gym', 'branch', 'plan', 'end_date', 'days_left', 'days_absent', 'days_since_joining', 'amount_due', 'gym_phone', 'trainer', 'owner', 'app_link'];

const ALIASES = {
  client_first_name: 'name', first_name: 'name', member_name: 'name',
  gym_name: 'gym', branch_name: 'branch', membership_plan: 'plan',
  membership_expiry_date: 'end_date', expiry_date: 'end_date',
  days_since_last_visit: 'days_absent', renewal_link: 'app_link',
  owner_name: 'owner', trainer_name: 'trainer',
};

/** {{client_first_name}} -> {name}; unknown names are left as they are. */
export function normalizePlaceholders(text) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (m, a, b) => {
    const k = a || b;
    const canon = ALIASES[k] || k;
    return PLACEHOLDERS.includes(canon) ? `{${canon}}` : m;
  });
}

/** Indian mobile numbers to +91XXXXXXXXXX; anything already +E.164 kept. */
export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const d = s.slice(1).replace(/\D/g, '');
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  let d = s.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

export const prettyPhone = (e164) => (/^\+91\d{10}$/.test(e164 || '') ? `+91 ${e164.slice(3, 8)} ${e164.slice(8)}` : (e164 || ''));
export const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

function formatDate(key, locale) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return String(key || '');
  try { return new Date(`${key}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }); } catch { return key; }
}

function formatMoney(n, locale) {
  const v = Math.round(Number(n) || 0);
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v); } catch { return `₹${v}`; }
}

/** Values for a member, formatted for `language`. Empty values are omitted. */
export function formatVariables(vars, language) {
  const locale = localeFor(language);
  const out = {};
  for (const k of PLACEHOLDERS) {
    const v = vars?.[k];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (k === 'end_date') out[k] = formatDate(v, locale);
    else if (k === 'amount_due') out[k] = formatMoney(v, locale);
    else out[k] = String(v).trim();
  }
  return out;
}

const used = (text) => [...new Set([...normalizePlaceholders(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];

/** Placeholders that are not real ones -- a typo guard for the editor. */
export const unknownPlaceholders = (text) => used(text).filter((k) => !PLACEHOLDERS.includes(k));

/** Placeholders the text uses that this member has no value for. */
export function missingDetails(text, vars) {
  return used(text).filter((k) => PLACEHOLDERS.includes(k) && (vars?.[k] === undefined || vars[k] === null || String(vars[k]).trim() === ''));
}

/** Fill {placeholders}. Callers check missingDetails first. */
export function fill(text, formatted) {
  return normalizePlaceholders(text)
    .replace(/\{(\w+)\}/g, (_, k) => (formatted[k] !== undefined ? formatted[k] : ''))
    .replace(/\s+([,.!?।])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * The full voice message: the automated-call notice, the owner's message,
 * then the keypad menu (always offering 9 = stop). Plus the menu alone
 * (replayed when nothing was pressed) and the lines after a key press.
 */
export function buildVoiceMessage({ script, language, kind, overrides, vars }) {
  const f = formatVariables(vars, language);
  const lines = spokenLines(language, kind, overrides);
  // An announcement asks nothing of the member: only "talk to us" and "stop".
  const menu = [lines.press1, kind === 'announcement' ? null : lines.press2, lines.press9].filter(Boolean).map((l) => fill(l, f)).join(' ');
  const notice = fill(lines.disclosure, f);
  return {
    full: [notice, fill(script, f), menu].filter(Boolean).join(' '),
    notice,
    menu,
    after: { 1: fill(lines.after1, f), 2: fill(lines.after2, f), 9: fill(lines.after9, f) },
  };
}

export const buildText = (body, language, vars) => fill(body, formatVariables(vars, language));

/* ---------------- SMS segments ---------------- */

// GSM 03.38 basic set, and the extension table (each costs two septets).
const GSM_BASIC = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const GSM_EXT = new Set(Array.from('^{}\\[~]|€\f'));

/**
 * The billable segments for an SMS body, the way carriers count them:
 * GSM-7 fits 160 characters (153 per part when split); any other character
 * makes the whole message Unicode, which fits 70 (67 per part).
 */
export function smsSegments(text) {
  const s = String(text || '');
  let septets = 0;
  let gsm = true;
  for (const ch of s) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXT.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { encoding: 'GSM-7', length: septets, segments: septets <= 160 ? Math.max(1, Math.ceil(septets / 160)) : Math.ceil(septets / 153) };
  const units = s.length;                       // UTF-16 code units, as carriers count UCS-2
  return { encoding: 'Unicode', length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** WhatsApp templates use {{1}}, {{2}}...; owners write {name}. Same order both ways.
 *  Meta's format, so it is the same for every WhatsApp provider. */
export function toMetaBody(body) {
  const order = [];
  const text = normalizePlaceholders(body).replace(/\{(\w+)\}/g, (_, k) => {
    let i = order.indexOf(k);
    if (i === -1) { order.push(k); i = order.length - 1; }
    return `{{${i + 1}}}`;
  });
  return { text, order };
}
