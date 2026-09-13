/**
 * WHICH DAY A CLIENT'S LOG COUNTS AGAINST.
 *
 * One resolver, used by every route that writes or reads a dated log,
 * because the alternative is worse than the bug it fixes: if writing
 * used the cutoff and reading used the calendar, a late-night meal would
 * be stored against yesterday and then not appear in yesterday's totals
 * either. The rule has to be the same on both sides or it is not a rule.
 *
 * The cutoff itself lives on the client (client_profiles.day_start_hour,
 * 4am by default, 0 for plain calendar days) and the maths lives in
 * utils/time.js. This is just the part that knows whose preference to
 * read, with a short cache because the value changes about once a year
 * and is needed on every write.
 */
import { logDayKey, isBeforeDayStart, DEFAULT_DAY_START_HOUR, DEFAULT_TZ } from '../utils/time.js';

const TTL_MS = 60_000;
const cache = new Map();   // clientId -> { hour, at }

export function invalidateDayStart(clientId) {
  cache.delete(clientId);
}

export async function dayStartHour(db, clientId) {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hour;
  let hour = DEFAULT_DAY_START_HOUR;
  try {
    const row = await db.q1('SELECT day_start_hour FROM client_profiles WHERE client_id = ?', [clientId]);
    const h = Number(row?.day_start_hour);
    if (Number.isFinite(h)) hour = h;
  } catch {
    // Column missing on an un-migrated database: the default is correct
    // and a nutrition write must not fail over a preference lookup.
  }
  cache.set(clientId, { hour, at: Date.now() });
  return hour;
}

/** The client's logging day for `when` (default: now). */
export async function clientLogDay(db, clientId, tz = DEFAULT_TZ, when = new Date()) {
  return logDayKey(when, tz, await dayStartHour(db, clientId));
}

/** True when the client is currently in the pre-cutoff window, i.e. a log
 *  made right now counts against yesterday. The UI says so out loud. */
export async function inPreviousLogDay(db, clientId, tz = DEFAULT_TZ, when = new Date()) {
  return isBeforeDayStart(when, tz, await dayStartHour(db, clientId));
}
