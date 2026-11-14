// ============================================================
// WHEN -- "call me next Monday at 6" -> a moment the gym can call.
//
// Pure: text, the gym's clock and rules in; a decision out. The AI agent
// passes the member's own words (and, when it understood them, a date and
// time of its own); THIS module decides, so a model's arithmetic can never
// book the wrong day. It either resolves a callable moment or says exactly
// what to ask next:
//
//   { ok: true,  dayKey, minutes, at, label, approximate }
//   { ok: false, need: 'date' | 'time', reason, ask, dayKey?, minutes? }
//
// reasons: no_date, vague_date, no_time, past, too_soon, too_far,
//          outside_hours, day_closed
//
// Understood (English, Hinglish): today, tonight, tomorrow, day after
// tomorrow, kal, parso; in/after N days or weeks; (next|this|coming) Monday,
// Monday next week, this weekend; on the 20th, 20 November, Nov 20, 20/11;
// first day of next month, end of the month; 6 PM, 6:30, 18:00, at 6,
// half past six, after 7 PM, before noon, morning / afternoon / evening /
// night, subah / dopahar / shaam / raat, "6 baje".
// "Next week", "next month", "after my vacation", "later" are not a date:
// the member is asked which day.
// ============================================================

const DAY_MS = 86_400_000;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_ALIASES = {
  mon: 0, monday: 0, somvar: 0, somwar: 0,
  tue: 1, tues: 1, tuesday: 1, mangalvar: 1, mangalwar: 1,
  wed: 2, weds: 2, wednesday: 2, budhvar: 2, budhwar: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3, guruvar: 3, guruwar: 3, brihaspativar: 3,
  fri: 4, friday: 4, shukravar: 4, shukrawar: 4,
  sat: 5, saturday: 5, shanivar: 5, shaniwar: 5,
  sun: 6, sunday: 6, ravivar: 6, raviwar: 6, itvar: 6, itwar: 6,
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALIASES = Object.fromEntries(MONTHS.flatMap((m, i) => [[m, i], [m.slice(0, 3), i], ...(m === 'september' ? [['sept', i]] : [])]));
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
  a: 1, an: 1, couple: 2,
};
// Default minute of day for a part of the day (clamped into calling hours).
const PART_OF_DAY = { morning: 10 * 60, afternoon: 14 * 60, evening: 18 * 60, night: 20 * 60, noon: 12 * 60 };
const PART_ALIASES = {
  morning: 'morning', subah: 'morning', subha: 'morning',
  afternoon: 'afternoon', dopahar: 'afternoon', dopaher: 'afternoon', lunchtime: 'afternoon',
  evening: 'evening', shaam: 'evening', sham: 'evening', shām: 'evening',
  night: 'night', tonight: 'night', raat: 'night', rat: 'night',
  noon: 'noon', midday: 'noon',
};

/* ---------------- the gym's clock ---------------- */

function partsIn(tz, at) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
}

/** Minutes the zone is ahead of UTC at instant `ms`. */
function offsetMinutes(tz, ms) {
  const p = partsIn(tz, new Date(ms));
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The UTC instant of gym-local `dayKey` at `minutes` past midnight (DST-safe). */
export function localToUtc(dayKey, minutes, tz) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let utc = naive - offsetMinutes(tz, naive) * 60_000;
  utc = naive - offsetMinutes(tz, utc) * 60_000;   // second pass lands on the right side of a DST change
  return new Date(utc);
}

const keyOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const keyToUtc = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const addDays = (k, n) => new Date(keyToUtc(k) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (k) => (new Date(keyToUtc(k)).getUTCDay() + 6) % 7;            // Monday = 0
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();          // m: 1-12

/* ---------------- speaking it back ---------------- */

export function timeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (h === 12 && mi === 0) return 'noon';
  return `${h12}${mi ? `:${String(mi).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

export function dayLabel(dayKey, todayKey) {
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const full = `${cap(WEEKDAYS[weekdayOf(dayKey)])} ${Number(dayKey.slice(8, 10))} ${cap(MONTHS[Number(dayKey.slice(5, 7)) - 1])}`;
  if (todayKey && dayKey === todayKey) return `today (${full})`;
  if (todayKey && dayKey === addDays(todayKey, 1)) return `tomorrow (${full})`;
  return full;
}

export const whenLabel = (dayKey, minutes, todayKey) => `${dayLabel(dayKey, todayKey)} at ${timeLabel(minutes)}`;

/* ---------------- reading the member's words ---------------- */

function normalize(text) {
  let t = ` ${String(text || '').toLowerCase()} `
    .replace(/[“”"’']/g, '')
    .replace(/a\.m\./g, 'am').replace(/p\.m\./g, 'pm')
    .replace(/[,;!?()]/g, ' ')
    .replace(/(\d)\s*(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ');
  // "twenty first" -> 21, "twenty-five" -> 25
  t = t.replace(/\b(twenty|thirty)[\s-](one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g,
    (_, tens, unit) => String(NUMBER_WORDS[tens] + NUMBER_WORDS[unit]));
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)\b/g,
    (w) => String(NUMBER_WORDS[w]));
  return t;
}

const VAGUE_DATE = /\b(next week|agle hafte|agle week|next month|agle mahine|later|baad mein|some ?time|some other (day|time)|another (day|time)|get back|back from|vacation|holiday|trip|travel|few days|free|when i can|whenever)\b/;

/** { minutes?, part?, meridiem? } from the words, or null. */
function readTime(t) {
  let part = null;
  for (const [w, p] of Object.entries(PART_ALIASES)) if (new RegExp(`\\b${w}\\b`).test(t)) { part = p; break; }

  const before = /\bbefore\b/.test(t);
  let h = null;
  let mi = 0;
  let mer = null;
  let m;
  if ((m = /\bhalf past (\d{1,2})\b/.exec(t))) { h = +m[1]; mi = 30; }
  else if ((m = /\bquarter past (\d{1,2})\b/.exec(t))) { h = +m[1]; mi = 15; }
  else if ((m = /\bquarter to (\d{1,2})\b/.exec(t))) { h = +m[1] - 1; mi = 45; }
  else if ((m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(t))) { h = +m[1]; mi = +m[2]; mer = m[3] || null; }
  else if ((m = /\b(\d{1,2})\s*(am|pm)\b/.exec(t))) { h = +m[1]; mer = m[2]; }
  else if ((m = /\b(\d{1,2})\s*(baje|bje|oclock|o clock)\b/.exec(t))) { h = +m[1]; }
  else if ((m = /\b(\d{3,4})\s*(hours|hrs)\b/.exec(t))) { const v = m[1].padStart(4, '0'); h = +v.slice(0, 2); mi = +v.slice(2); }
  else if ((m = /\b(?:at|around|by|after|before|about)\s+(\d{1,2})\b(?!\s*(?:days?|weeks?|months?|th|st|nd|rd|\/|-))/.exec(t))) { h = +m[1]; }
  if (h === null && part === 'noon') return { minutes: before ? 11 * 60 : 12 * 60, part, exact: true };
  if (h === null) return part ? { minutes: PART_OF_DAY[part], part, exact: false } : null;
  if (h > 23 || mi > 59) return null;
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (!mer && h <= 12) {
    if (part === 'morning') { if (h === 12) h = 0; }
    else if (part && part !== 'noon') { if (h < 12) h += 12; }
    else if (h >= 1 && h <= 7) h += 12;               // nobody means 1-7 AM for a gym call
    else if (h === 8 && /\b(at|after|around)\b/.test(t) && !/\bmorning\b/.test(t)) h = 20;
  }
  let minutes = h * 60 + mi;
  if (before) minutes = Math.max(0, minutes - 60);
  return { minutes, part, exact: true };
}

/** { dayKey } | { vague: true } | null, relative to gym-local `today`. */
function readDate(t, todayKey) {
  const [ty, tm, td] = todayKey.split('-').map(Number);
  let m;
  if (/\bday after tomorrow\b|\bparso\b|\bparson\b/.test(t)) return { dayKey: addDays(todayKey, 2) };
  if (/\b(tomorrow|tmrw|tomorow|tommorow|tommorrow|kal)\b/.test(t)) return { dayKey: addDays(todayKey, 1) };
  if (/\b(today|aaj|tonight)\b/.test(t)) return { dayKey: todayKey };

  if (/\b(?:in|after)\s+(?:a\s+)?couple\s+(?:of\s+)?days\b/.test(t)) return { dayKey: addDays(todayKey, 2) };
  if ((m = /\b(?:in|after|within)\s+(?:a\s+)?(\d{1,2})?\s*(day|days|week|weeks)\b/.exec(t))) {
    const n = m[1] ? +m[1] : 1;
    return { dayKey: addDays(todayKey, /week/.test(m[2]) ? 7 * n : n) };
  }
  if ((m = /\b(\d{1,2})\s+(days?|weeks?)\s+(?:later|baad|from now|se)\b/.exec(t))) return { dayKey: addDays(todayKey, /week/.test(m[2]) ? 7 * +m[1] : +m[1]) };

  if (/\b(?:1(?:\s+day)?|first day|beginning|start)\s+(?:of\s+)?(?:the\s+)?next month\b/.test(t)) {
    const ny = tm === 12 ? ty + 1 : ty;
    const nm = tm === 12 ? 1 : tm + 1;
    return { dayKey: keyOf(ny, nm, 1) };
  }
  if (/\b(end of (the |this )?month|month end|month-end)\b/.test(t)) return { dayKey: keyOf(ty, tm, daysInMonth(ty, tm)) };

  // weekdays
  const wdWord = Object.keys(WEEKDAY_ALIASES).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (wdWord) {
    const target = WEEKDAY_ALIASES[wdWord];
    const today = weekdayOf(todayKey);
    if (/\bnext week\b|\bagle hafte\b/.test(t)) {
      const nextMonday = addDays(todayKey, 7 - today);
      return { dayKey: addDays(nextMonday, target) };
    }
    let diff = (target - today + 7) % 7;
    if (diff === 0 && /\bnext\b|\bagle\b|\bcoming\b/.test(t)) diff = 7;
    return { dayKey: addDays(todayKey, diff), sameDayOk: diff === 0 };
  }
  if (/\b(this |the )?weekend\b/.test(t)) {
    const today = weekdayOf(todayKey);
    if (/\bnext weekend\b/.test(t)) return { dayKey: addDays(addDays(todayKey, 7 - today), 5) };
    return { dayKey: addDays(todayKey, (5 - today + 7) % 7) };
  }

  // explicit dates: 20/11(/2026), 20-11, 20 november, november 20, the 20(th)
  const year = (y) => (y ? (+y < 100 ? 2000 + +y : +y) : null);
  const build = (d, mo, y) => {
    if (mo < 1 || mo > 12) return null;
    let yy = y || ty;
    if (!y && (mo < tm || (mo === tm && d < td))) yy += 1;
    if (d < 1 || d > daysInMonth(yy, mo)) return null;
    return keyOf(yy, mo, d);
  };
  if ((m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b(?!\s*(?:am|pm|baje))/.exec(t))) { const k = build(+m[1], +m[2], year(m[3])); if (k) return { dayKey: k }; }
  const monthRe = Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length).join('|');
  if ((m = new RegExp(`\\b(\\d{1,2})\\s+(?:of\\s+)?(${monthRe})\\b(?:\\s+(\\d{4}))?`).exec(t))) { const k = build(+m[1], MONTH_ALIASES[m[2]] + 1, year(m[3])); if (k) return { dayKey: k }; }
  if ((m = new RegExp(`\\b(${monthRe})\\s+(\\d{1,2})\\b(?:\\s+(\\d{4}))?`).exec(t))) { const k = build(+m[2], MONTH_ALIASES[m[1]] + 1, year(m[3])); if (k) return { dayKey: k }; }
  if ((m = /\b(?:on\s+)?the\s+(\d{1,2})\b(?!\s*(?:am|pm|:|baje|days?|weeks?))|\bon\s+(\d{1,2})\b(?!\s*(?:am|pm|:|baje|days?|weeks?))|\b(\d{1,2})\s*tarikh\b/.exec(t))) {
    const d = +(m[1] || m[2] || m[3]);
    let mo = tm;
    let y = ty;
    if (d < td) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    while (d > daysInMonth(y, mo)) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    return { dayKey: keyOf(y, mo, d) };
  }
  if (VAGUE_DATE.test(t)) return { vague: true };
  return null;
}

/* ---------------- deciding ---------------- */

const DAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/**
 * Resolve a call-back moment.
 *
 * args:
 *   text       the member's words ("next Monday, 6 in the evening")
 *   date, time optional: the agent's own reading, 'YYYY-MM-DD' / 'HH:MM';
 *              used only for what the words did not say
 *   now        the current instant
 *   tz         the gym's IANA timezone
 *   window     { start, end } calling minutes (end exclusive)
 *   daysMask   '1111110' Monday..Sunday the gym calls on
 *   leadMin    how far ahead at least (default 15 minutes)
 *   maxDays    how far ahead at most (default 60 days)
 */
export function resolveWhen({ text = '', date = null, time = null, now = new Date(), tz = 'Asia/Kolkata', window = { start: 600, end: 1170 }, daysMask = '1111110', leadMin = 15, maxDays = 60 } = {}) {
  const t = normalize(text);
  const local = partsIn(tz, now);
  const todayKey = keyOf(local.y, local.m, local.d);
  const nowMin = local.h * 60 + local.mi;
  const mask = String(daysMask || '1111110').padEnd(7, '0');
  const open = (k) => mask[weekdayOf(k)] === '1';
  const hours = `${timeLabel(window.start)} and ${timeLabel(window.end)}`;

  let d = readDate(t, todayKey);
  let tm = readTime(t);
  if (!d && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) d = { dayKey: String(date) };
  if (!tm && /^\d{1,2}:\d{2}$/.test(String(time || ''))) {
    const [h, mi] = String(time).split(':').map(Number);
    if (h < 24 && mi < 60) tm = { minutes: h * 60 + mi, exact: true };
  }

  if (d?.vague) {
    return { ok: false, need: 'date', reason: 'vague_date', ask: /next week|agle/.test(t) ? 'Which day next week suits you?' : 'Which date should we call you on?' };
  }
  if (!d && !tm) return { ok: false, need: 'date', reason: 'no_date', ask: 'Which day and time would suit you?' };

  let assumedDay = false;
  if (!d) {
    // A time with no day: today if it is still ahead, otherwise the next open day.
    let k = todayKey;
    if (tm.minutes < nowMin + leadMin || !open(k)) {
      k = addDays(todayKey, 1);
      for (let i = 0; i < 7 && !open(k); i++) k = addDays(k, 1);
    }
    d = { dayKey: k };
    assumedDay = true;
  }
  const dayKey = d.dayKey;
  const ahead = Math.round((keyToUtc(dayKey) - keyToUtc(todayKey)) / DAY_MS);
  if (ahead < 0) return { ok: false, need: 'date', reason: 'past', ask: 'That day has already passed. Which day would suit you?' };
  if (ahead > maxDays) return { ok: false, need: 'date', reason: 'too_far', ask: `We can book a call back up to ${maxDays} days ahead. Which day within that suits you?` };
  if (!open(dayKey)) {
    let next = addDays(dayKey, 1);
    for (let i = 0; i < 7 && !open(next); i++) next = addDays(next, 1);
    return { ok: false, need: 'date', reason: 'day_closed', dayKey, suggestion: next, ask: `We do not call on ${DAY_NAMES[weekdayOf(dayKey)]}. Would ${dayLabel(next, todayKey)} work instead?` };
  }
  if (!tm) return { ok: false, need: 'time', reason: 'no_time', dayKey, ask: `What time on ${dayLabel(dayKey, todayKey)} suits you? We call between ${hours}.` };

  let minutes = tm.minutes;
  if (!tm.exact) {
    // "in the evening": the part's usual time, kept inside calling hours.
    minutes = Math.min(Math.max(minutes, window.start), window.end - 30);
  }
  if (minutes < window.start || minutes >= window.end) {
    return { ok: false, need: 'time', reason: 'outside_hours', dayKey, minutes, ask: `We can only call between ${hours}. What time in that window suits you on ${dayLabel(dayKey, todayKey)}?` };
  }
  if (ahead === 0 && minutes < nowMin + leadMin) {
    return { ok: false, need: 'time', reason: minutes < nowMin ? 'past' : 'too_soon', dayKey, ask: 'That time is too soon. What later time suits you?' };
  }
  const at = localToUtc(dayKey, minutes, tz);
  return {
    ok: true, dayKey, minutes, at: at.toISOString(), assumedDay, approximate: !tm.exact,
    label: `${dayLabel(dayKey, todayKey)} at ${tm.exact ? '' : 'around '}${timeLabel(minutes)}`,
    local: `${dayKey} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
  };
}

export const _test = { normalize, readTime, readDate, offsetMinutes, addDays, weekdayOf };
