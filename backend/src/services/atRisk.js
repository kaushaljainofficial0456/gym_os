// ============================================================
// AT-RISK DETECTION — rule engine
// Rules run against real data and return actionable alerts.
// Severity: low | medium | high. Client status is derived from
// the worst rule plus inactivity.
// ============================================================
import { computeAdherence, computeAdherenceBulk } from './adherence.js';
import { daysAgoIso, todayKey, daysBetween, round1 } from '../utils/time.js';

const SEVERITY_SCORE = { low: 1, medium: 2, high: 3 };

// Pure rule evaluation from already-fetched per-client data. Shared by the
// single-client and bulk paths so behavior can never drift.
export function evaluateFromData(client, data) {
  const rules = [];
  const today = todayKey();

  // ---- 1. NO_WORKOUT — no workout logged in 5+ days ----
  const lastWorkout = data.lastWorkout || null;
  if (lastWorkout) {
    const days = daysBetween(lastWorkout, today);
    if (days >= 5) {
      rules.push({
        type: 'NO_WORKOUT', severity: days >= 7 ? 'high' : 'medium',
        title: `No workout for ${days} days`,
        detail: `Last logged workout was ${days} days ago (${lastWorkout}).`
      });
    }
  }

  // ---- 2. PLATEAU — weight flat while goal is weight loss ----
  if (client.goal === 'FAT_LOSS' || client.goal === 'RECOMP') {
    const weights = (data.weights || []).sort((a, b) => a.date.localeCompare(b.date));
    if (weights.length >= 3) {
      const span = daysBetween(weights[0].date, weights[weights.length - 1].date);
      const net = weights[0].weight - weights[weights.length - 1].weight; // >0 = lost
      if (span >= 21 && net < 0.3) {
        const severity = span >= 30 ? 'high' : 'medium';
        rules.push({
          type: 'PLATEAU', severity,
          title: `Weight plateau for ${span} days`,
          detail: `Weight has moved ${round1(net)} kg over ${span} days (${weights[0].weight} → ${weights[weights.length - 1].weight} kg).`
        });
      }
    }
  }

  // ---- adherence-derived rules ----
  const adherence = data.adherence;
  if (adherence.components.protein !== null && adherence.components.protein < 70) {
    rules.push({
      type: 'LOW_PROTEIN', severity: adherence.components.protein < 60 ? 'high' : 'medium',
      title: `Protein adherence below 70%`,
      detail: `7-day protein adherence is ${adherence.components.protein}% — well under the 70% floor.`
    });
  }
  if (adherence.components.nutrition !== null && adherence.components.nutrition < 60) {
    rules.push({
      type: 'LOW_NUTRITION', severity: adherence.components.nutrition < 45 ? 'high' : 'medium',
      title: `Nutrition adherence below 60%`,
      detail: `7-day meal adherence is ${adherence.components.nutrition}%.`
    });
  }
  if (adherence.components.workout !== null && adherence.components.workout < 60) {
    rules.push({
      type: 'LOW_WORKOUT', severity: adherence.components.workout < 40 ? 'high' : 'medium',
      title: `Workout adherence below 60%`,
      detail: `Completed ${adherence.components.workout}% of scheduled workouts this week.`
    });
  }
  if (adherence.components.sleep !== null && adherence.components.sleep < 82) {
    rules.push({
      type: 'POOR_SLEEP', severity: adherence.components.sleep < 70 ? 'medium' : 'low',
      title: `Sleep below target`,
      detail: `Average sleep is ${round1((adherence.components.sleep / 100) * 8)}h vs an 8h target.`
    });
  }
  if (adherence.components.checkin === 0) {
    rules.push({
      type: 'MISSED_CHECKIN', severity: 'medium',
      title: `Missed weekly check-in`,
      detail: `No check-in (weight log / measurement) in the last 7 days.`
    });
  }

  // ---- 3. INACTIVE — no activity at all in 14 days ----
  const lastActive = data.lastActive;
  if (lastActive && daysBetween(lastActive, today) >= 14) {
    rules.push({
      type: 'INACTIVE', severity: 'high',
      title: `Client inactive for ${daysBetween(lastActive, today)} days`,
      detail: `Last recorded activity was ${lastActive}.`
    });
  }

  // ---- derive status ----
  let status = 'ON_TRACK';
  if (rules.some(r => r.type === 'INACTIVE')) status = 'INACTIVE';
  else if (rules.some(r => r.severity === 'high')) status = 'AT_RISK';
  else if (rules.some(r => r.severity === 'medium')) status = 'NEEDS_ATTENTION';

  rules.sort((x, y) => SEVERITY_SCORE[y.severity] - SEVERITY_SCORE[x.severity]);
  return { status, adherence, rules };  // adherence = full computed object ({score, components, ...})
}

// Single-client evaluation (alert detail, overview pages). Loads only this
// client's rows, then runs the same pure rules.
export async function evaluateClient(db, client) {
  const map = await loadEvaluationData(db, [client]);
  return evaluateFromData(client, map.get(client.id));
}

// Bulk evaluation for many clients in ~8 total queries (instead of ~13 per
// client). Returns Map(clientId -> { status, adherence, rules }).
// data is always computed; rules/status are derived.
export async function loadEvaluationData(db, clients) {
  const ids = clients.map(c => c.id);
  const inClause = ids.map(() => '?').join(',');
  if (!ids.length) return new Map();
  const week35 = daysAgoIso(35);
  const today = todayKey();

  const [lastLogs, weights, adherences, anyActivity] = await Promise.all([
    db.q(`SELECT client_id, MAX(date) AS d FROM workout_logs WHERE client_id IN (${inClause}) GROUP BY client_id`, ids),
    db.q(`SELECT client_id, date, weight FROM weight_logs WHERE client_id IN (${inClause}) AND date >= ? ORDER BY client_id, date`, [...ids, week35]),
    computeAdherenceBulk(db, clients),
    db.q(`SELECT client_id, MAX(d) AS d FROM (
            SELECT client_id, MAX(date) AS d FROM workout_logs WHERE client_id IN (${inClause}) GROUP BY client_id
            UNION ALL
            SELECT client_id, MAX(date) AS d FROM weight_logs WHERE client_id IN (${inClause}) GROUP BY client_id
            UNION ALL
            SELECT client_id, MAX(date) AS d FROM meal_logs WHERE client_id IN (${inClause}) GROUP BY client_id
          ) t GROUP BY client_id`, [...ids, ...ids, ...ids])
  ]);

  const lastBy = new Map(lastLogs.map(r => [r.client_id, r.d]));
  const weightBy = new Map();
  for (const w of weights) { (weightBy.get(w.client_id) || weightBy.set(w.client_id, []).get(w.client_id)).push({ date: w.date, weight: w.weight }); }
  const activeBy = new Map(anyActivity.map(r => [r.client_id, r.d]));

  const out = new Map();
  for (const c of clients) {
    out.set(c.id, {
      lastWorkout: lastBy.get(c.id) || null,
      weights: weightBy.get(c.id) || [],
      adherence: adherences.get(c.id) || null,
      lastActive: activeBy.get(c.id) || null
    });
  }
  return out;
}

export async function evaluateClients(db, clients) {
  const data = await loadEvaluationData(db, clients);
  const out = new Map();
  for (const c of clients) out.set(c.id, evaluateFromData(c, data.get(c.id)));
  return out;
}

// Evaluate all clients of an org and persist alerts. Idempotent:
//   * fired rule + open alert of same client+type  -> refresh content (no duplicate)
//   * fired rule + no open alert                   -> insert
//   * condition cleared + open alert exists        -> mark resolved
// This makes repeated evaluation safe and keeps the Alerts page current.
export async function evaluateOrg(db, orgId, trainerId = null) {
  const clients = await db.q(
    `SELECT * FROM clients WHERE org_id = ? AND status != 'INACTIVE'`, [orgId]);
  const results = [];
  const nowIso = new Date().toISOString();
  const evaluated = await evaluateClients(db, clients);
  // Was one `SELECT ... WHERE client_id = ?` per client -- this runs on
  // every GET /alerts (alerts.js re-evaluates before listing), so an org
  // with a few hundred clients meant a few hundred round trips just to
  // read each client's currently-open alerts, before any writes even
  // happen. Batched into one query + grouped in JS, same pattern already
  // used for evaluateClients/withEvaluationBulk elsewhere in this
  // codebase. Only the READ is batched -- the per-rule INSERT/UPDATE
  // below is untouched, since that's real per-client state that only
  // writes for clients whose alerts actually changed, not all of them.
  const clientIds = clients.map((c) => c.id);
  const allOpen = clientIds.length
    ? await db.q(
        `SELECT id, type, client_id FROM alerts WHERE client_id IN (${clientIds.map(() => '?').join(',')}) AND status = 'open'`,
        clientIds)
    : [];
  const openByClient = new Map();
  for (const a of allOpen) {
    if (!openByClient.has(a.client_id)) openByClient.set(a.client_id, []);
    openByClient.get(a.client_id).push(a);
  }
  for (const c of clients) {
    const r = evaluated.get(c.id);
    results.push({ client: c, ...r });
    const open = openByClient.get(c.id) || [];
    const openByType = new Map(open.map(a => [a.type, a.id]));
    const firedTypes = new Set();
    for (const rule of r.rules) {
      firedTypes.add(rule.type);
      const existingId = openByType.get(rule.type);
      if (existingId) {
        // refresh content so stale severity/title/detail don't linger
        await db.run(
          `UPDATE alerts SET severity = ?, title = ?, detail = ?, data_json = ? WHERE id = ?`,
          [rule.severity, rule.title, rule.detail, JSON.stringify(rule), existingId]);
      } else {
        await db.run(
          `INSERT INTO alerts (id, org_id, client_id, trainer_id, type, severity, title, detail, data_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          ['alt_' + Math.random().toString(36).slice(2, 12), orgId, c.id, trainerId || c.trainer_id,
           rule.type, rule.severity, rule.title, rule.detail, JSON.stringify(rule), nowIso]);
      }
    }
    // resolve alerts whose condition no longer fires
    for (const [type, id] of openByType) {
      if (!firedTypes.has(type)) {
        await db.run(`UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`, [nowIso, id]);
      }
    }
  }
  return results;
}
