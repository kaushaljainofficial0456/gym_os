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
import { dayKey, getOrgTz, shiftDayKey } from '../utils/time.js';
import { localParts } from './access/localTime.js';
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
    const hour = ev.hour ?? Number(String(ev.ts).slice(11, 13));
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
 * WHEN a stored timestamp happened, as the GYM'S day and hour.
 *
 * Timestamps are stored in UTC ("...Z"). Slicing the hour out of that text
 * put an Indian gym's 7 AM rush in the 1 AM column and split its evening
 * across two "days" at 5:30 AM. A zoned string is converted into the gym's
 * timezone; a naive one (older seed data) is already wall-clock time.
 */
function localWhen(ts, tz) {
  const s = String(ts || '');
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const p = localParts(s, tz);
    return p ? { day: p.day, hour: p.hour } : null;
  }
  const hour = Number(s.slice(11, 13));
  return Number.isInteger(hour) ? { day: s.slice(0, 10), hour } : null;
}

/** Manual check-ins (attendance_events): each day's hourly peaks. */
async function peaksFromCheckins(db, orgId, tz, fromIso) {
  const rows = await db.q(
    `SELECT client_id, direction, ts FROM attendance_events
      WHERE org_id = ? AND ts >= ?
      ORDER BY ts, id`, [orgId, fromIso]);
  const byDay = new Map();
  for (const r of rows) {
    const w = localWhen(r.ts, tz);
    if (!w) continue;
    if (!byDay.has(w.day)) byDay.set(w.day, []);
    byDay.get(w.day).push({ ...r, hour: w.hour });
  }
  const out = new Map();
  for (const [day, evs] of byDay) out.set(day, hourlyPeaks(evs));
  return out;
}

const SLOT_MS = 15 * 60 * 1000;
const MAX_SESSION_MS = 16 * 60 * 60 * 1000;

/**
 * Door feed (presence sessions): each day's hourly peaks.
 *
 * Counted in 15-minute slots: a session occupies every slot from its entry
 * to its exit, and an hour's figure is its fullest slot. A session closed
 * without an exit scan (auto-closed at closing time, or reconciled by the
 * next entry) has no real exit time and must not be given one -- for the
 * SHAPE of a typical day it is counted for this gym's own median measured
 * visit, and never past the moment it was closed.
 */
async function peaksFromSessions(db, orgId, tz, fromIso, now) {
  const rows = await db.q(
    `SELECT entered_at, exited_at, status, duration_sec, confidence, updated_at
       FROM gym_presence_sessions
      WHERE org_id = ? AND is_demo = 0 AND entered_at >= ?`, [orgId, fromIso]);
  const measured = rows
    .filter((r) => r.confidence === 'exact' && Number(r.duration_sec) > 0)
    .map((r) => Number(r.duration_sec))
    .sort((a, b) => a - b);
  const typicalMs = (measured.length >= 5 ? measured[Math.floor(measured.length / 2)] : 75 * 60) * 1000;

  const slots = new Map();
  for (const r of rows) {
    const start = Date.parse(r.entered_at);
    if (!Number.isFinite(start)) continue;
    let end;
    if (r.exited_at) end = Date.parse(r.exited_at);
    else if (r.status === 'OPEN') end = now.getTime();
    else {
      end = start + typicalMs;
      const closedAt = Date.parse(r.updated_at);
      if (Number.isFinite(closedAt) && closedAt > start) end = Math.min(end, closedAt);
    }
    if (!Number.isFinite(end) || end <= start) end = start + 1;
    end = Math.min(end, start + MAX_SESSION_MS);
    for (let k = Math.floor(start / SLOT_MS); k * SLOT_MS < end; k += 1) slots.set(k, (slots.get(k) || 0) + 1);
  }
  const out = new Map();
  for (const [k, n] of slots) {
    const p = localParts(new Date(k * SLOT_MS), tz);
    if (!p) continue;
    if (!out.has(p.day)) out.set(p.day, new Array(24).fill(0));
    const arr = out.get(p.day);
    arr[p.hour] = Math.max(arr[p.hour], n);
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The best time to go, from here on: the quietest two-hour window still
 * ahead today while the gym is open -- or, late in the evening, tomorrow's
 * usual quietest window. Never a time the gym is closed, and never a
 * window the history has nothing to say about.
 */
export function bestTimeToVisit(typical, nowHour, settings, quietest) {
  const open = HHMM.test(settings?.crowd_open_time || '') ? Number(settings.crowd_open_time.slice(0, 2)) : null;
  const closeRaw = HHMM.test(settings?.crowd_close_time || '') ? Number(settings.crowd_close_time.slice(0, 2)) : null;
  const close = closeRaw != null && open != null && closeRaw <= open ? 24 : closeRaw;
  let best = null;
  for (let h = nowHour + 1; h + 2 <= 24; h += 1) {
    if (open != null && h < open) continue;
    if (close != null && h + 2 > close) continue;
    // Only hours the gym is actually used, when no hours are configured:
    // a zero at 3 AM is a closed building, not a quiet one.
    if (open == null && (typical[h] <= 0 || typical[h + 1] <= 0)) continue;
    const average = Math.round(((typical[h] + typical[h + 1]) / 2) * 10) / 10;
    if (!best || average < best.average) best = { startHour: h, endHour: h + 2, average };
  }
  if (best) return { ...best, when: 'today' };
  return quietest ? { ...quietest, when: 'tomorrow' } : null;
}

/**
 * Typical occupancy by hour across the last `days` days, plus today's and
 * yesterday's own curves, the weekly pattern and the best time to go.
 * Real data or an honest `sufficient: false`.
 *
 * `source` is the same choice the live figure makes (liveCrowd.js): a gym
 * whose door feeds us events is measured from presence sessions; one on
 * manual check-in from attendance_events. Reading only the manual log meant
 * a gym on a fingerprint terminal never had a typical day at all, however
 * many months of scans it had.
 */
export async function crowdHistory(db, orgId, tz, { days = 28, source = 'manual', settings = null, now = new Date() } = {}) {
  const orgTz = tz || await getOrgTz(db, orgId);
  const today = dayKey(now, orgTz);
  const yesterday = shiftDayKey(today, -1);
  const from = shiftDayKey(today, -days);
  // A day early, so the first local day is complete in any timezone.
  const fromIso = `${shiftDayKey(from, -1)}T00:00:00.000Z`;

  const peaksByDay = source === 'door'
    ? await peaksFromSessions(db, orgId, orgTz, fromIso, now)
    : await peaksFromCheckins(db, orgId, orgTz, fromIso);

  const zeros = () => new Array(24).fill(0);
  const series = (peaks) => (peaks || zeros()).map((count, hour) => ({ hour, count }));
  const todayPeaks = peaksByDay.get(today) || zeros();
  const yesterdayPeaks = peaksByDay.get(yesterday) || zeros();
  // The gym's hour now, so "today vs yesterday at this hour" is read on the
  // gym's clock rather than the phone's.
  const nowHour = localParts(now, orgTz)?.hour ?? null;

  // Today is excluded from "typical": a day still in progress would drag
  // every evening hour down to zero and move the apparent peak to lunchtime.
  const pastDays = [...peaksByDay.keys()].filter((d) => d < today && d >= from).sort();

  if (pastDays.length < MIN_DAYS_FOR_TYPICAL) {
    return {
      sufficient: false,
      source,
      nowHour,
      daysOfHistory: pastDays.length,
      daysRequired: MIN_DAYS_FOR_TYPICAL,
      typicalByHour: null,
      busiestHours: null,
      quietestHours: null,
      bestTime: null,
      todayByHour: series(todayPeaks),
      yesterdayByHour: series(yesterdayPeaks),
      byWeekday: null,
    };
  }

  const sums = new Array(24).fill(0);
  for (const d of pastDays) {
    const peaks = peaksByDay.get(d);
    for (let h = 0; h < 24; h += 1) sums[h] += peaks[h];
  }
  const typical = sums.map((v) => Math.round((v / pastDays.length) * 10) / 10);

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
    source,
    nowHour,
    daysOfHistory: pastDays.length,
    daysRequired: MIN_DAYS_FOR_TYPICAL,
    typicalByHour: series(typical),
    todayByHour: series(todayPeaks),
    yesterdayByHour: series(yesterdayPeaks),
    busiestHours: busiest,
    quietestHours: quietest,
    bestTime: bestTimeToVisit(typical, nowHour ?? 0, settings, quietest),
    byWeekday: weekdayAverages(peaksByDay, pastDays),
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

function weekdayAverages(peaksByDay, pastDays) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const d of pastDays) {
    // Midday avoids the date shifting across a timezone boundary.
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    sums[dow] += Math.max(...peaksByDay.get(d));
    counts[dow] += 1;
  }
  return sums.map((v, dow) => ({
    dow,
    averagePeak: counts[dow] ? Math.round((v / counts[dow]) * 10) / 10 : null,
    days: counts[dow],
  }));
}
