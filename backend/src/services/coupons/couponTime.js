// ============================================================
// COUPON WALL-CLOCK TIMES — a founder types "30 Nov 2026, 11:59 PM" in
// a timezone (Asia/Kolkata by default); the database stores UTC ISO.
// Dependency-free: Intl already knows every IANA zone's offsets,
// including DST transitions for the zones that have them.
// ============================================================

export const DEFAULT_COUPON_TZ = 'Asia/Kolkata';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at instant `utcMs`, in ms (IST = +19,800,000). */
function zoneOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * 'YYYY-MM-DD' + 'HH:mm' as wall-clock time in `tz` -> UTC epoch ms, or
 * null for an impossible date (2026-02-30) / malformed input / unknown
 * zone. Two passes so a time on a DST boundary resolves to the offset
 * actually in force at that local time.
 */
export function zonedToUtcMs(date, time, tz = DEFAULT_COUPON_TZ) {
  const d = DATE_RE.exec(String(date || ''));
  const t = TIME_RE.exec(String(time || ''));
  if (!d || !t || !isValidTimeZone(tz)) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== day) return null;
  const naive = Date.UTC(y, m - 1, day, Number(t[1]), Number(t[2]));
  let utc = naive - zoneOffsetMs(naive, tz);
  utc = naive - zoneOffsetMs(utc, tz);
  return utc;
}

/** UTC ISO -> { date: 'YYYY-MM-DD', time: 'HH:mm' } in `tz` (minute precision). */
export function utcToZoned(iso, tz = DEFAULT_COUPON_TZ) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimeZone(tz) ? tz : DEFAULT_COUPON_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(dt).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` };
}

/**
 * The coupon validity window as stored UTC instants.
 *   starts_at  = the first instant of the chosen start minute
 *   expires_at = the LAST instant of the chosen expiry minute
 * so "expires 30 Nov, 11:59 PM" means valid through 11:59:59.999 PM --
 * what a founder means by it -- and the edit form still reads back 23:59.
 */
export function couponWindowFromLocal({ startsDate, startsTime, expiresDate, expiresTime, timezone = DEFAULT_COUPON_TZ }) {
  const start = zonedToUtcMs(startsDate, startsTime, timezone);
  const end = zonedToUtcMs(expiresDate, expiresTime, timezone);
  if (start == null) return { ok: false, reason: 'invalid_start', message: 'Start date/time is not a valid date and time.' };
  if (end == null) return { ok: false, reason: 'invalid_expiry', message: 'Expiry date/time is not a valid date and time.' };
  const expiresMs = end + 59_999;
  if (expiresMs <= start) return { ok: false, reason: 'invalid_window', message: 'Expiry must be after the start.' };
  return { ok: true, startsAt: new Date(start).toISOString(), expiresAt: new Date(expiresMs).toISOString() };
}
