// ============================================================
// TIME UTILITIES — timezone-aware (default: Asia/Kolkata)
// ============================================================

// Default timezone for the application. The org-level timezone
// takes precedence when available (stored in organizations.timezone).
export const DEFAULT_TZ = process.env.TIMEZONE || 'Asia/Kolkata';

// Format a date as YYYY-MM-DD in the given timezone.
// Uses native Intl — no external dependencies.
export function dayKey(d = new Date(), tz = DEFAULT_TZ) {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * THE LOGGING DAY, which is not the calendar day.
 *
 * A meal eaten at 00:40 belongs to the night that just happened, not to
 * the morning that has technically started. Keying food logs on the
 * calendar date meant a late dinner landed on tomorrow: the day you
 * actually ate it closed under-counted, and the next day opened already
 * spent, before you had eaten anything. Nobody thinks of their day that
 * way, and a tracker that does is wrong about both days at once.
 *
 * So a logging day runs from `startHour` to `startHour` -- 4am by
 * default, which is past when people stop eating and before they start.
 * Anything earlier than that counts to the day before. 0 restores plain
 * calendar behaviour for anyone who wants it.
 *
 * This is a DISPLAY AND GROUPING rule, not a storage one: the row still
 * records the real instant it was created. Only which day it is counted
 * against moves, so changing the cutoff re-buckets history rather than
 * rewriting it.
 */
export const DEFAULT_DAY_START_HOUR = 4;

export function logDayKey(d = new Date(), tz = DEFAULT_TZ, startHour = DEFAULT_DAY_START_HOUR) {
  const h = Number(startHour);
  const shift = Number.isFinite(h) ? Math.min(Math.max(h, 0), 12) : DEFAULT_DAY_START_HOUR;
  if (shift === 0) return dayKey(d, tz);
  // Reading the hour IN THE TARGET TIMEZONE matters: shifting the UTC
  // instant first and then formatting would move the boundary by the
  // zone's own offset, which is how a 4am rule silently becomes 9:30am
  // in Asia/Kolkata.
  const hourInTz = Number(d.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }));
  if (hourInTz >= shift) return dayKey(d, tz);
  const prev = new Date(d.getTime() - 24 * 3600 * 1000);
  return dayKey(prev, tz);
}

/** True when `now` falls in the pre-cutoff window, i.e. the log is being
 *  counted against yesterday. The UI says so rather than letting the
 *  date quietly disagree with the clock on the wall. */
export function isBeforeDayStart(d = new Date(), tz = DEFAULT_TZ, startHour = DEFAULT_DAY_START_HOUR) {
  const h = Number(startHour);
  const shift = Number.isFinite(h) ? Math.min(Math.max(h, 0), 12) : DEFAULT_DAY_START_HOUR;
  if (shift === 0) return false;
  const hourInTz = Number(d.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }));
  return hourInTz < shift;
}

// ISO timestamp in the given timezone (YYYY-MM-DDTHH:mm:ss±HH:mm)
export function iso(d = new Date(), tz = DEFAULT_TZ) {
  return d.toLocaleString('sv', { timeZone: tz, hour12: false }).replace(' ', 'T');
}

// Current UTC ISO string (for DB timestamps that need sorting across timezones)
export function utcIso(d = new Date()) {
  return d.toISOString();
}

// Add days to a date (preserves the original timezone context)
export const addDays = (date, n) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

// Date N days ago, as YYYY-MM-DD in the given timezone
export function daysAgoIso(n, tz = DEFAULT_TZ) {
  return dayKey(addDays(new Date(), -n), tz);
}

export const daysAgo = (n) => addDays(new Date(), -n);
export const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
export const todayKey = (tz = DEFAULT_TZ) => dayKey(new Date(), tz);
export const lastNDays = (n, tz = DEFAULT_TZ) => Array.from({ length: n }, (_, i) => dayKey(daysAgo(n - 1 - i), tz));

// 0=Sun...6=Sat, using the given timezone
export function weekDay(dateKeyStr, tz = DEFAULT_TZ) {
  return new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'SUN' ? 0 :
    new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'SAT' ? 6 :
    new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'FRI' ? 5 :
    new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'THU' ? 4 :
    new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'WED' ? 3 :
    new Date(dateKeyStr + 'T00:00:00').toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }).toUpperCase() === 'TUE' ? 2 : 1;
}

export const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;

// Get the timezone for an org. Returns the default if not set.
export async function getOrgTz(db, orgId) {
  if (!orgId) return DEFAULT_TZ;
  try {
    const org = await db.q1('SELECT timezone FROM organizations WHERE id = ?', [orgId]);
    return org?.timezone || DEFAULT_TZ;
  } catch { return DEFAULT_TZ; }
}

// requireAuth() calls getOrgTz() on EVERY authenticated request (it needs req.tz
// before the route handler runs), which previously meant an extra DB round trip
// ahead of every single request's own queries. Org timezone changes essentially
// never (no route in this codebase currently writes organizations.timezone), so
// it's safe to cache per-org with a short TTL — this removes that round trip
// from the hot path while still picking up changes within a few minutes.
const ORG_TZ_TTL_MS = 5 * 60 * 1000;
const orgTzCache = new Map(); // orgId -> { tz, at }

export async function getOrgTzCached(db, orgId) {
  if (!orgId) return DEFAULT_TZ;
  const hit = orgTzCache.get(orgId);
  const now = Date.now();
  if (hit && (now - hit.at) < ORG_TZ_TTL_MS) return hit.tz;
  const tz = await getOrgTz(db, orgId);
  orgTzCache.set(orgId, { tz, at: now });
  return tz;
}

// Call after any write to organizations.timezone so the change is picked up
// immediately instead of waiting out the TTL.
export function invalidateOrgTzCache(orgId) {
  if (orgId) orgTzCache.delete(orgId);
  else orgTzCache.clear();
}