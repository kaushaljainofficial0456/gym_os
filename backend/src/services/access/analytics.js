// ============================================================
// OCCUPANCY ANALYTICS — measured, calculated, or not shown.
//
// Three kinds of number come out of this file, and the owner screens label
// them as such:
//
//   MEASURED    entries and exits per hour: counted from door events.
//   RECORDED    occupancy per hour: the peak of the snapshots we took at
//               the time. Not reconstructed afterwards -- reconstructing
//               past occupancy from sessions would need the exit time of
//               every reconciled session, and for those we deliberately do
//               not have one.
//   CALCULATED  comparisons ("14% more entries than yesterday by this
//               hour"), always against a like-for-like window, never
//               against a whole day that has not happened yet.
//
// HOURS ARE THE GYM'S HOURS. Events are stored in UTC; bucketing them by
// the UTC hour would put a 7am Mumbai rush at 1:30am. Every bucket here is
// computed in the gym's own timezone.
// ============================================================
import { randomUUID } from 'node:crypto';
import { liveCrowd } from './liveCrowd.js';
import { localParts } from './localTime.js';

const nowIso = () => new Date().toISOString();

export { localParts, isOpenNow, validHhmm } from './localTime.js';

/* ── snapshots ─────────────────────────────────────────────────────── */

const lastSnapshot = new Map();   // per-instance throttle; the DB check below is the real one

/**
 * Record what we believe occupancy is, at most every `minIntervalSec`.
 * Only for gyms with crowd tracking on. Never for demo data -- liveCrowd
 * already excludes it.
 */
export async function maybeSnapshot(db, orgId, tz, settings, { minIntervalSec = 300, now = new Date() } = {}) {
  if (settings && settings.crowd_enabled === 0) return null;
  const cutoff = new Date(now.getTime() - minIntervalSec * 1000).toISOString();
  const memo = lastSnapshot.get(orgId);
  if (memo && memo > cutoff) return null;
  const recent = await db.q1(
    'SELECT calculated_at FROM occupancy_snapshots WHERE org_id = ? AND branch_id IS NULL ORDER BY calculated_at DESC LIMIT 1',
    [orgId]);
  if (recent && recent.calculated_at > cutoff) { lastSnapshot.set(orgId, recent.calculated_at); return null; }

  const crowd = await liveCrowd(db, orgId, tz, settings, { showExactCount: true });
  if (!crowd?.enabled || crowd.current == null) return null;
  const ts = now.toISOString();
  const cap = Number(settings?.crowd_capacity) || null;
  await db.run(
    `INSERT INTO occupancy_snapshots (id, org_id, branch_id, occupancy_count, configured_capacity, occupancy_percentage, calculated_at, calculation_version)
     VALUES (?,?,NULL,?,?,?,?,?)`,
    [randomUUID(), orgId, crowd.current, cap, cap ? Math.round((crowd.current / cap) * 1000) / 10 : null, ts,
      crowd.source === 'access_control' ? 'presence-v1' : 'replay-v1']);
  lastSnapshot.set(orgId, ts);
  return { recorded: true, occupancy: crowd.current };
}

/**
 * Today's totals, bucketed in the GYM's day rather than UTC's.
 *
 * Lives here, next to the hourly bucketing that follows the same rule, so
 * the dashboard's "entries today" and the chart underneath it can never
 * disagree about when today started. Counting with substr(occurred_at,
 * 1, 10) against the UTC date filed an Indian gym's midnight-to-5:30am
 * scans under yesterday.
 *
 * Demo scans are excluded from the real counts for the same reason they
 * are excluded from occupancy -- but they ARE included in the unresolved
 * tallies, which are about our own processing, not about the building.
 */
export function tallyToday(rows, tz, now = new Date()) {
  const today = localParts(now, tz)?.day;
  const out = { entries: 0, exits: 0, unmatched: 0, rejected: 0 };
  for (const e of rows || []) {
    if (localParts(e.occurred_at, tz)?.day !== today) continue;
    if (e.processing_status === 'UNMATCHED') out.unmatched += 1;
    if (e.processing_status === 'REJECTED') out.rejected += 1;
    if (e.source === 'demo') continue;
    if (e.event_type === 'ENTRY' && Number(e.affected_occupancy) === 1) out.entries += 1;
    if (e.event_type === 'EXIT' && Number(e.affected_occupancy) === -1) out.exits += 1;
  }
  return out;
}

/* ── hourly analytics ──────────────────────────────────────────────── */

async function eventsBetween(db, orgId, fromIso, toIso) {
  // Door events when the gym has any; the manual log otherwise. Never both
  // (see liveCrowd.js for why the two are never summed).
  const door = await db.q(
    `SELECT occurred_at AS ts, event_type, affected_occupancy FROM access_events
      WHERE org_id = ? AND source != 'demo' AND occurred_at >= ? AND occurred_at < ?
        AND affected_occupancy != 0`, [orgId, fromIso, toIso]);
  if (door.length) {
    return {
      source: 'access_control',
      rows: door.map((e) => ({ ts: e.ts, kind: e.affected_occupancy > 0 ? 'entry' : 'exit' })),
    };
  }
  const manual = await db.q(
    'SELECT ts, direction FROM attendance_events WHERE org_id = ? AND ts >= ? AND ts < ?', [orgId, fromIso, toIso]);
  return { source: manual.length ? 'manual_checkin' : 'none', rows: manual.map((e) => ({ ts: e.ts, kind: e.direction })) };
}

function emptyDay() {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, entries: 0, exits: 0, peak: null }));
}

/**
 * Today vs yesterday, by the gym's local hour, plus a 4-week
 * weekday-by-hour pattern of arrivals.
 */
export async function hourlyAnalytics(db, orgId, tz, { now = new Date() } = {}) {
  const here = localParts(now, tz);
  const todayKey = here.day;
  const yesterdayKey = localParts(new Date(now.getTime() - 86400000), tz).day;

  // A window wide enough to cover both local days in any timezone.
  const from = new Date(now.getTime() - 3 * 86400000).toISOString();
  const to = new Date(now.getTime() + 86400000).toISOString();
  const { source, rows } = await eventsBetween(db, orgId, from, to);

  const today = emptyDay();
  const yesterday = emptyDay();
  for (const r of rows) {
    const p = localParts(r.ts, tz);
    if (!p) continue;
    const target = p.day === todayKey ? today : p.day === yesterdayKey ? yesterday : null;
    if (!target) continue;
    if (r.kind === 'entry') target[p.hour].entries += 1; else target[p.hour].exits += 1;
  }

  // Recorded occupancy: the peak snapshot in each local hour.
  const snaps = await db.q(
    `SELECT occupancy_count, calculated_at FROM occupancy_snapshots
      WHERE org_id = ? AND branch_id IS NULL AND calculated_at >= ? ORDER BY calculated_at`, [orgId, from]);
  for (const s of snaps) {
    const p = localParts(s.calculated_at, tz);
    const target = p?.day === todayKey ? today : p?.day === yesterdayKey ? yesterday : null;
    if (!target) continue;
    target[p.hour].peak = Math.max(target[p.hour].peak ?? 0, Number(s.occupancy_count) || 0);
  }

  /* Like-for-like: entries so far today vs entries by the same hour
     yesterday. Comparing a half-finished day with a whole one would report
     every morning as a collapse. */
  const soFar = (day) => day.slice(0, here.hour + 1).reduce((a, h) => a + h.entries, 0);
  const todaySoFar = soFar(today);
  const yesterdaySameTime = soFar(yesterday);
  const comparison = yesterdaySameTime > 0
    ? { todaySoFar, yesterdaySameTime, pctChange: Math.round(((todaySoFar - yesterdaySameTime) / yesterdaySameTime) * 100) }
    : { todaySoFar, yesterdaySameTime, pctChange: null };

  const peakRow = today.reduce((best, h) => ((h.peak ?? -1) > (best?.peak ?? -1) ? h : best), null);

  // Average visit length today, from sessions a real scan closed. Estimated
  // closures have no exit time and are excluded rather than guessed.
  const visits = await db.q(
    `SELECT duration_sec, entered_at FROM gym_presence_sessions
      WHERE org_id = ? AND is_demo = 0 AND confidence = 'exact' AND duration_sec IS NOT NULL AND entered_at >= ?`,
    [orgId, from]);
  const todayVisits = visits.filter((v) => localParts(v.entered_at, tz)?.day === todayKey);
  const avgVisitMin = todayVisits.length
    ? Math.round(todayVisits.reduce((a, v) => a + v.duration_sec, 0) / todayVisits.length / 60)
    : null;

  return {
    source,
    timezone: tz,
    today,
    yesterday,
    comparison,
    peakToday: peakRow?.peak != null ? { occupancy: peakRow.peak, hour: peakRow.hour } : null,
    avgVisitMin,
    visitsMeasured: todayVisits.length,
    weekly: await weeklyPattern(db, orgId, tz, { now }),
  };
}

/** Average arrivals per weekday × hour over the last 28 days. */
export async function weeklyPattern(db, orgId, tz, { now = new Date(), days = 28 } = {}) {
  const from = new Date(now.getTime() - days * 86400000).toISOString();
  const { rows } = await eventsBetween(db, orgId, from, now.toISOString());
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const daysSeen = Array.from({ length: 7 }, () => new Set());
  for (const r of rows) {
    if (r.kind !== 'entry') continue;
    const p = localParts(r.ts, tz);
    if (!p || p.dow < 0) continue;
    grid[p.dow][p.hour] += 1;
    daysSeen[p.dow].add(p.day);
  }
  const totalDays = daysSeen.reduce((a, s) => a + s.size, 0);
  if (totalDays < 7) return { sufficient: false, daysWithData: totalDays, daysRequired: 7, grid: null };
  return {
    sufficient: true,
    daysWithData: totalDays,
    grid: grid.map((hours, dow) => ({
      dow,
      days: daysSeen[dow].size,
      hours: hours.map((n) => (daysSeen[dow].size ? Math.round((n / daysSeen[dow].size) * 10) / 10 : null)),
    })),
  };
}

export default { maybeSnapshot, hourlyAnalytics, weeklyPattern, tallyToday };
