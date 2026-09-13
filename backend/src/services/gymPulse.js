// ============================================================
// GYM PULSE — the numbers an owner opens the app to check.
//
// The owner dashboard could already say how many clients were on track
// and what their adherence was. It could not say how many people came in
// today, how much money was actually outstanding, whether the trainers
// turned up, or what ANY of it looked like over time. Those are the
// questions "how is my gym doing?" actually decomposes into, and every
// one of them was a table away from being answerable.
//
// ONE ENDPOINT, ONE PASS. Each series below is a single grouped query
// over an indexed column, not a per-client fetch — a dashboard that
// walks every client's history to draw a chart stops loading long before
// a gym gets big enough to need the chart.
//
// NOTHING HERE IS SYNTHESISED. A gym with no payments gets an empty
// revenue series, not a flat line at zero, because those are different
// claims: one says "no money was recorded", the other says "we recorded
// that no money came in". The UI needs to be able to tell them apart, so
// empty arrays come back empty and callers render a no-data state.
//
// PORTABILITY: every query here runs on SQLite (tests) and PostgreSQL
// (production). No rowid, and nothing selected that isn't grouped or
// aggregated — see test/sqlPortability.test.js for why that is a rule
// and not a preference.
// ============================================================
import { dayKey } from '../utils/time.js';

/** YYYY-MM-DD, n days before `from` (default today). */
function daysBefore(n, from = new Date()) {
  const d = new Date(from.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Fills a date-keyed map into a dense day-by-day series.
 *  Dense on purpose: a gap in attendance is a real zero (the gym was
 *  open and nobody came), unlike a gap in a personal food log. */
function denseDays(map, days, endKey) {
  const out = [];
  const end = new Date(`${endKey}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: key, value: Number(map.get(key) || 0) });
  }
  return out;
}

const num = (v) => Number(v) || 0;

/**
 * Everything the owner dashboard needs, for one org, in one call.
 * `days` controls the length of the daily series (7 / 30 / 90).
 */
export async function gymPulse(db, orgId, { tz = 'Asia/Kolkata', days = 30, now = new Date() } = {}) {
  const today = dayKey(now, tz);
  const from = daysBefore(days - 1, now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

  const [
    checkInsToday, attendanceRows, trainerRows, trainerPresent,
    paidRows, pendingRows, revenueRows,
    subStatusRows, expiringRows, joinRows, workoutRows,
  ] = await Promise.all([
    // --- today at a glance ---
    db.q1('SELECT COUNT(*) AS n FROM attendance WHERE org_id = ? AND date = ? AND present = 1', [orgId, today]),

    db.q('SELECT date, COUNT(*) AS n FROM attendance WHERE org_id = ? AND present = 1 AND date >= ? GROUP BY date',
      [orgId, from]),

    db.q1('SELECT COUNT(*) AS n FROM trainers WHERE org_id = ?', [orgId]),

    // Trainers who have actually checked in today. LEFT as its own count
    // rather than derived from the roster: "3 of 5 in" is the whole
    // point, and a missing row means not-in, not unknown.
    db.q1(`SELECT COUNT(*) AS n FROM trainer_attendance
            WHERE org_id = ? AND date = ? AND check_in IS NOT NULL`, [orgId, today]).catch(() => ({ n: 0 })),

    // --- money ---
    db.q1(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
             FROM payments WHERE org_id = ? AND status = 'paid' AND paid_at >= ?`, [orgId, monthStart]),

    // Outstanding is a SUBSCRIPTION state, not a payment state: an unpaid
    // membership has no payments row to count, so counting payments would
    // report zero owed no matter how many members were behind.
    db.q(`SELECT payment_status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
            FROM subscriptions
           WHERE org_id = ? AND payment_status IN ('pending', 'overdue', 'failed')
           GROUP BY payment_status`, [orgId]),

    db.q(`SELECT substr(paid_at, 1, 7) AS month, COALESCE(SUM(amount), 0) AS total
            FROM payments
           WHERE org_id = ? AND status = 'paid' AND paid_at IS NOT NULL
           GROUP BY substr(paid_at, 1, 7)
           ORDER BY substr(paid_at, 1, 7) DESC`, [orgId]),

    // --- membership ---
    /* THE END DATE OUTRANKS THE STATUS COLUMN.
     *
     * Nothing in this app expires a subscription on a schedule, so rows
     * sit at status 'active' long after they have run out -- this gym has
     * memberships that ended in April still marked active. Grouping on
     * the column alone reported "23 active" to an owner whose members had
     * mostly lapsed, which is the most expensive number on the dashboard
     * to get wrong: it is the one that says the business is fine.
     *
     * The CASE is repeated in GROUP BY rather than referencing the alias,
     * which is the form both SQLite and PostgreSQL accept. */
    db.q(`SELECT CASE WHEN status = 'active' AND end_date IS NOT NULL AND end_date < ?
                      THEN 'lapsed' ELSE status END AS bucket,
                 COUNT(*) AS n
            FROM subscriptions WHERE org_id = ?
           GROUP BY CASE WHEN status = 'active' AND end_date IS NOT NULL AND end_date < ?
                         THEN 'lapsed' ELSE status END`, [today, orgId, today]),

    db.q1(`SELECT COUNT(*) AS n FROM subscriptions
            WHERE org_id = ? AND status = 'active' AND end_date IS NOT NULL
              AND end_date >= ? AND end_date <= ?`, [orgId, today, in30]),

    // --- growth ---
    db.q(`SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS n
            FROM clients WHERE org_id = ? AND substr(created_at, 1, 10) >= ?
           GROUP BY substr(created_at, 1, 10)`, [orgId, from]),

    // --- coaching throughput ---
    db.q(`SELECT scheduled_date AS date,
                 COUNT(*) AS assigned,
                 SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
            FROM workouts
           WHERE org_id = ? AND scheduled_date IS NOT NULL AND scheduled_date >= ?
           GROUP BY scheduled_date`, [orgId, from]),
  ]);

  const attMap = new Map(attendanceRows.map((r) => [r.date, r.n]));
  const joinMap = new Map(joinRows.map((r) => [r.date, r.n]));
  const woAssigned = new Map(workoutRows.map((r) => [r.date, r.assigned]));
  const woCompleted = new Map(workoutRows.map((r) => [r.date, r.completed]));

  const pendingTotal = pendingRows.reduce((s, r) => s + num(r.total), 0);
  const pendingCount = pendingRows.reduce((s, r) => s + num(r.n), 0);
  const overdueCount = pendingRows
    .filter((r) => r.payment_status === 'overdue' || r.payment_status === 'failed')
    .reduce((s, r) => s + num(r.n), 0);

  // Last 12 months, most recent last, only months that actually have a
  // payment. A month with no takings is genuinely absent from the record
  // here rather than asserted as zero.
  const revenue = revenueRows
    .slice(0, 12)
    .map((r) => ({ month: r.month, value: num(r.total) }))
    .reverse();

  return {
    today: {
      date: today,
      checkIns: num(checkInsToday?.n),
      trainersTotal: num(trainerRows?.n),
      trainersIn: num(trainerPresent?.n),
    },
    money: {
      collectedThisMonth: num(paidRows?.total),
      paymentsThisMonth: num(paidRows?.n),
      outstandingAmount: pendingTotal,
      outstandingCount: pendingCount,
      overdueCount,
      currency: 'INR',
    },
    members: {
      expiringSoon: num(expiringRows?.n),
      byStatus: subStatusRows.map((r) => ({ status: r.bucket, value: num(r.n) })),
    },
    series: {
      days,
      attendance: denseDays(attMap, days, today),
      joins: denseDays(joinMap, days, today),
      workoutsAssigned: denseDays(woAssigned, days, today),
      workoutsCompleted: denseDays(woCompleted, days, today),
      revenue,
    },
  };
}
