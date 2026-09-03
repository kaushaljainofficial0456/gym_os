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