// ============================================================
// THE GYM'S CLOCK.
//
// Events are stored in UTC, and a gym lives in local time. Anything that
// asks "which hour", "which day" or "is it open" has to answer in the
// gym's timezone, or a 7am Mumbai rush lands in the 1:30am bucket.
//
// Kept in its own module because both the occupancy resolver and the
// analytics need it, and those two already depend on each other in one
// direction -- putting this in either would make the import graph a
// cycle.
// ============================================================

/** { day: 'YYYY-MM-DD', hour: 0-23, minutes: minutes-into-day, dow: 0-6 } in `tz`. */
export function localParts(iso, tz) {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (!d || Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour,
    minutes: hour * 60 + Number(p.minute),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const validHhmm = (v) => v == null || v === '' || HHMM.test(String(v));
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/**
 * Is the gym open right now?
 *
 * Returns null -- not true -- when hours are not configured. "Unknown" is
 * the honest answer, and callers treat it as open: inventing a schedule
 * would tell members a 24-hour gym is shut at midnight. Handles hours that
 * cross midnight (05:00-01:00) and equal open/close meaning 24 hours.
 */
export function isOpenNow(settings, tz, now = new Date()) {
  const open = settings?.crowd_open_time;
  const close = settings?.crowd_close_time;
  if (!HHMM.test(open || '') || !HHMM.test(close || '')) return null;
  const o = toMin(open);
  const c = toMin(close);
  if (o === c) return true;
  const m = localParts(now, tz).minutes;
  return o < c ? (m >= o && m < c) : (m >= o || m < c);
}

/**
 * The most recent closing instant at or before `now`, as a Date -- or null
 * when hours are not configured. Used to auto-close sessions left open
 * past closing, which is only safe if we know when closing was.
 */
export function lastClosingBefore(settings, tz, now = new Date()) {
  const close = settings?.crowd_close_time;
  const open = settings?.crowd_open_time;
  if (!HHMM.test(close || '') || !HHMM.test(open || '') || open === close) return null;
  // Walk back minute-accurately from now: find how many minutes ago the
  // local clock last read the closing time.
  const nowMin = localParts(now, tz).minutes;
  const closeMin = toMin(close);
  const agoMin = ((nowMin - closeMin) + 1440) % 1440;
  return new Date(now.getTime() - agoMin * 60_000 - (now.getUTCSeconds() * 1000));
}

export default { localParts, isOpenNow, validHhmm, lastClosingBefore };
