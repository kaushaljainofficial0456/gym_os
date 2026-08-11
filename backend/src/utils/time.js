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