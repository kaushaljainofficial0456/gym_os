// ============================================================
// OCCUPANCY ENGINE
// Attendance events arrive from the gym's access-control system
// as NORMALIZED events (member_id / direction / timestamp) —
// never biometric data. This engine turns them into a reliable
// occupancy figure:
//   * duplicate entry while already inside      → ignored
//   * duplicate exit while already outside      → ignored
//   * exit without a matching entry             → ignored (no negative occupancy)
//   * entry without exit                        → member stays inside
//   * midnight rollover                         → day scoped in the org's timezone
//   * manual correction                         → insert a synthetic event
// ============================================================
import { dayKey, getOrgTz } from '../utils/time.js';
import { getCrowdStatus, getFreshness } from './crowdStatus.js';

/**
 * Legacy percentage banding, kept because the client Home card and the
 * owner crowd endpoint both still read `pct`/`status` off the snapshot.
 *
 * IT USED TO RETURN TWO DIFFERENT SHAPES. With a capacity it returned
 * `{ pct, status }`; without one it returned the bare string 'LOW'. Both
 * call sites do `const { pct, status } = occupancyStatus(...)`, and
 * destructuring a string yields undefined for both keys -- so a gym with
 * no configured capacity silently produced `pct: undefined`, which is what
 * the Home card feeds straight into `width: ${pct}%`. It never fired in
 * practice only because computeOccupancy defaults capacity to 150 before
 * calling this, i.e. the guard was load-bearing on a default that hides it.
 * One shape, always.
 *
 * New code should use getCrowdStatus in crowdStatus.js, which is
 * threshold-configurable and does not invent a percentage without a
 * capacity.
 */
export function occupancyStatus(current, capacity) {
  if (!capacity || capacity <= 0) return { pct: null, status: 'LOW' };
  const pct = Math.round((current / capacity) * 100);
  const status = pct < 40 ? 'LOW' : pct < 65 ? 'MODERATE' : pct < 85 ? 'HIGH' : 'VERY_HIGH';
  return { pct, status };
}

// Replay the day's events and return an occupancy snapshot.
export async function computeOccupancy(db, orgId, tz, settings, { showExactCount = true } = {}) {
  const orgTz = tz || await getOrgTz(db, orgId);
  const d = dayKey(new Date(), orgTz);
  const enabled = settings ? settings.crowd_enabled : 1;
  const capacity = settings?.crowd_capacity || 150;
  if (!enabled) return { enabled: false, current: null, capacity, pct: null, status: null, peak: null, average: null, busiestHour: null, byHour: [] };

  const events = await db.q(
    `SELECT client_id, direction, ts FROM attendance_events
      WHERE org_id = ? AND substr(ts, 1, 10) = ? ORDER BY ts, id`, [orgId, d]);
  // The age of the newest event, NOT of this request. Freshness has to be
  // measured against the data, or every response looks a second old.
  const lastEventAt = events.length ? events[events.length - 1].ts : null;

  const inside = new Set();     // client ids currently inside
  const byHour = new Map();     // hour -> count snapshot at that hour
  let peak = 0;
  let peakHour = null;
  let sum = 0, samples = 0;

  const snapshot = (ts) => {
    const n = inside.size;
    peak = Math.max(peak, n);
    const hour = (ts || '00:00').slice(11, 13);
    byHour.set(hour, n);
    sum += n; samples++;
    if (n === peak) peakHour = hour;
  };

  for (const ev of events) {
    if (ev.direction === 'entry') {
      if (inside.has(ev.client_id)) continue;   // duplicate entry
      inside.add(ev.client_id);
    } else {
      if (!inside.has(ev.client_id)) continue;  // exit without entry / duplicate exit
      inside.delete(ev.client_id);
    }
    snapshot(ev.ts);
  }
  if (samples === 0) snapshot('00:00');

  const current = inside.size;
  const { pct, status } = occupancyStatus(current, capacity);
  const busiestHour = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const calculatedAt = new Date().toISOString();
  /* THE PRIVACY SETTING HAS TO REACH THE LEGACY FIELDS TOO.
     getCrowdStatus nulls its own occupancyCount when a gym has chosen not
     to publish head-counts -- but `current`, `peak`, `average` and the
     per-hour series sit alongside it at the top level of this same
     response, and they carry the identical number. Hiding it in one place
     and shipping it in four others is not a privacy setting, it is a
     component that declines to render something anyone can read out of
     the network tab. The percentage stays: how busy it is IS the thing
     members are meant to see. Only the owner path (showExactCount
     defaulting true) gets the raw counts. */
  const hide = !showExactCount;
  return {
    enabled: true,
    current: hide ? null : current,
    capacity, pct, status,
    peak: hide ? null : peak,
    peakHour: peakHour || busiestHour,
    average: hide ? null : (samples ? Math.round((sum / samples) * 10) / 10 : 0),
    busiestHour,
    byHour: hide ? null : [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
    /* The rendered state, decided here rather than on four screens. `pct`
       and `status` above stay for the existing callers; everything new
       reads `crowd`, which respects the owner's configured thresholds and
       refuses to invent a percentage when no capacity is set. */
    crowd: getCrowdStatus({
      occupancyCount: current,
      capacity: settings?.crowd_capacity || null,
      thresholds: {
        quiet: settings?.crowd_threshold_quiet,
        moderate: settings?.crowd_threshold_moderate,
        busy: settings?.crowd_threshold_busy,
      },
      showExactCount,
    }),
    freshness: getFreshness({ calculatedAt, lastEventAt }),
    lastEventAt,
    calculatedAt,
  };
}

// ============================================================
// CROWD HISTORY — the real answer to "when is it usually busy?"
//
// This exists because the client-facing crowd screen was answering that
// question from a hard-coded 24-element array. Every gym in the product
// was shown the same invented curve, the same "Peak hours 5:00 PM - 7:00
// PM", and the same advice to come at midnight -- under a footer reading
// "Live data from the gym access system". The backend was already
// computing the real figures; the screen simply never asked for them.
//
// HOW TYPICAL HOURS ARE DERIVED. For each of the last N days we replay
// that day's events through the same presence rules computeOccupancy uses
// (an entry puts someone inside, an exit takes them out, duplicates on
// either side are ignored) and record the peak occupancy in each hour.
// Averaging the per-hour PEAK rather than a running count is what makes
// "busiest hour" mean what people think it means: the worst it got, not
// the average of a sparse sample.
//
// WHY A MINIMUM DAY COUNT. An average over two days is not a typical day,
// and presenting it as one is the same failure as the hard-coded array
// with extra steps. Below MIN_DAYS_FOR_TYPICAL this returns
// `sufficient: false` and the screen says so instead of drawing a curve.
// ============================================================

/** Days of history needed before "usually busiest at ..." is a fair claim. */
export const MIN_DAYS_FOR_TYPICAL = 7;

/**
 * Peak occupancy per hour for one day's ordered event list.
 *
 * THE STANDING OCCUPANCY IS RECORDED BEFORE THE EVENT IS APPLIED, and that
 * ordering is the whole correctness of this function. Four people who
 * arrive at 18:10 and leave at 20:10 make 19:00 a four-person hour and
 * 20:00 a four-person hour -- the building was full right up until they
 * scanned out. Filling those hours from the occupancy AFTER the first exit
 * reported three, and the evening peak came out as 3.5 instead of 4;
 * filling a quiet midday gap the same way reported one person in a room
 * that held two. Both were caught by the tests below.
 *
 * So each event first carries the occupancy that HELD since the previous
 * event across every hour in between (inclusive of both ends), and only
 * then changes it.
 */
function hourlyPeaks(events) {
  const inside = new Set();
  const peaks = new Array(24).fill(0);
  let lastHour = null;
  for (const ev of events) {
    const hour = Number(String(ev.ts).slice(11, 13));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;

    // Hours with no events of their own inherit the standing occupancy: a
    // gym with 30 people in it and nobody moving for an hour is still a
    // busy hour, and counting only hours that contain a scan reports it
    // as empty. Done before the duplicate check, because the occupancy
    // genuinely held through that time whether or not this event counts.
    for (let h = lastHour == null ? hour : lastHour; h <= hour; h += 1) {
      peaks[h] = Math.max(peaks[h], inside.size);
    }
    lastHour = hour;

    if (ev.direction === 'entry') {
      if (inside.has(ev.client_id)) continue;   // duplicate entry
      inside.add(ev.client_id);
    } else {
      if (!inside.has(ev.client_id)) continue;  // exit without entry
      inside.delete(ev.client_id);
    }
    peaks[hour] = Math.max(peaks[hour], inside.size);
  }
  return peaks;
}

/**
 * Typical occupancy by hour across the last `days` days, plus today's own
 * curve for comparison. Returns real data or an honest `sufficient: false`.
 */
export async function crowdHistory(db, orgId, tz, { days = 28 } = {}) {
  const orgTz = tz || await getOrgTz(db, orgId);
  const today = dayKey(new Date(), orgTz);
  const from = dayKey(new Date(Date.now() - days * 86400000), orgTz);

  const rows = await db.q(
    `SELECT client_id, direction, ts, substr(ts, 1, 10) AS day
       FROM attendance_events
      WHERE org_id = ? AND substr(ts, 1, 10) >= ? AND substr(ts, 1, 10) <= ?
      ORDER BY ts, id`, [orgId, from, today]);

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }

  // Today is excluded from "typical": a day still in progress would drag
  // every evening hour down to zero and move the apparent peak to lunchtime.
  const pastDays = [...byDay.keys()].filter((d) => d < today).sort();
  const todayPeaks = byDay.has(today) ? hourlyPeaks(byDay.get(today)) : new Array(24).fill(0);

  if (pastDays.length < MIN_DAYS_FOR_TYPICAL) {
    return {
      sufficient: false,
      daysOfHistory: pastDays.length,
      daysRequired: MIN_DAYS_FOR_TYPICAL,
      typicalByHour: null,
      busiestHours: null,
      quietestHours: null,
      todayByHour: todayPeaks.map((count, hour) => ({ hour, count })),
      byWeekday: null,
    };
  }

  const sums = new Array(24).fill(0);
  for (const d of pastDays) {
    const peaks = hourlyPeaks(byDay.get(d));
    for (let h = 0; h < 24; h += 1) sums[h] += peaks[h];
  }
  const typical = sums.map((s) => Math.round((s / pastDays.length) * 10) / 10);

  /* Busiest and quietest are reported as CONTIGUOUS WINDOWS, because
     "usually busiest 6-8 PM" is what a member can act on, and a single
     peak hour is both less useful and more fragile. Quiet hours are taken
     only from hours the gym is actually used -- 3am is not a
     recommendation, it is a closed building. */
  const used = typical.map((v, h) => ({ v, h })).filter(({ v }) => v > 0);
  const busiest = windowOf(typical, 'max');
  const quietest = used.length >= 3 ? windowOf(typical, 'min', used.map((u) => u.h)) : null;

  return {
    sufficient: true,
    daysOfHistory: pastDays.length,
    daysRequired: MIN_DAYS_FOR_TYPICAL,
    typicalByHour: typical.map((count, hour) => ({ hour, count })),
    todayByHour: todayPeaks.map((count, hour) => ({ hour, count })),
    busiestHours: busiest,
    quietestHours: quietest,
    byWeekday: weekdayAverages(byDay, pastDays, orgTz),
  };
}

/** The best two-hour window, as {startHour, endHour, average}. */
function windowOf(typical, mode, allowedHours = null) {
  const allowed = allowedHours ? new Set(allowedHours) : null;
  let best = null;
  for (let h = 0; h < 23; h += 1) {
    if (allowed && (!allowed.has(h) || !allowed.has(h + 1))) continue;
    const avg = (typical[h] + typical[h + 1]) / 2;
    if (!best || (mode === 'max' ? avg > best.average : avg < best.average)) {
      best = { startHour: h, endHour: h + 2, average: Math.round(avg * 10) / 10 };
    }
  }
  return best;
}

function weekdayAverages(byDay, pastDays, tz) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const d of pastDays) {
    // Midday avoids the date shifting across a timezone boundary.
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    const peaks = hourlyPeaks(byDay.get(d));
    sums[dow] += Math.max(...peaks);
    counts[dow] += 1;
  }
  return sums.map((s, dow) => ({
    dow,
    averagePeak: counts[dow] ? Math.round((s / counts[dow]) * 10) / 10 : null,
    days: counts[dow],
  }));
}
