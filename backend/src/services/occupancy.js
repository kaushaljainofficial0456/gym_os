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

export function occupancyStatus(current, capacity) {
  if (!capacity || capacity <= 0) return 'LOW';
  const pct = Math.round((current / capacity) * 100);
  const status = pct < 40 ? 'LOW' : pct < 65 ? 'MODERATE' : pct < 85 ? 'HIGH' : 'VERY_HIGH';
  return { pct, status };
}

// Replay the day's events and return an occupancy snapshot.
export async function computeOccupancy(db, orgId, tz, settings) {
  const orgTz = tz || await getOrgTz(db, orgId);
  const d = dayKey(new Date(), orgTz);
  const enabled = settings ? settings.crowd_enabled : 1;
  const capacity = settings?.crowd_capacity || 150;
  if (!enabled) return { enabled: false, current: null, capacity, pct: null, status: null, peak: null, average: null, busiestHour: null, byHour: [] };

  const events = await db.q(
    `SELECT client_id, direction, ts FROM attendance_events
      WHERE org_id = ? AND substr(ts, 1, 10) = ? ORDER BY ts, id`, [orgId, d]);

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

  return {
    enabled: true, current, capacity, pct, status,
    peak, peakHour: peakHour || busiestHour,
    average: samples ? Math.round((sum / samples) * 10) / 10 : 0,
    busiestHour,
    byHour: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count }))
  };
}
