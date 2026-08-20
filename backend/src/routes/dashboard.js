import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { computeAdherence } from '../services/adherence.js';
import { evaluateClient, evaluateClients } from '../services/atRisk.js';
import { daysAgoIso, todayKey, lastNDays, round1 } from '../utils/time.js';

export default function dashboardRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);

  // ---- /api/dashboard/overview ----
  // Owner/admin view: org-wide metrics. Uses bulk evaluation to avoid N+1.
  r.get('/overview', requireRole('GYM_OWNER', 'SUPER_ADMIN'), async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
    if (!clients.length) {
      return res.json({
        kpis: {
          activeClients: 0, newClients: 0, onTrack: 0, needsAttention: 0, atRisk: 0, inactive: 0,
          avgAdherence: null, avgWeightChange: 0, workoutCompletion: null, nutritionAdherence: null,
          renewalsDue: 0, monthlyRevenue: 0
        },
        clients: []
      });
    }

    // Bulk evaluate ALL clients in ~8 queries instead of ~7 per client
    const evs = await evaluateClients(db, clients);

    // Bulk-fetch 7-day weight changes
    const ids = clients.map(c => c.id);
    const inClause = ids.map(() => '?').join(',');
    const weightLogs7d = await db.q(
      `SELECT client_id, date, weight FROM weight_logs
       WHERE client_id IN (${inClause}) AND date >= ?
       ORDER BY client_id, date`, [...ids, daysAgoIso(7)]);
    const w7By = new Map();
    for (const w of weightLogs7d) {
      (w7By.get(w.client_id) || w7By.set(w.client_id, []).get(w.client_id)).push(w);
    }

    let onTrack = 0, atRisk = 0, needs = 0, inactive = 0;
    const adherenceScores = [];
    const workoutCompletion = [], nutritionAdherence = [], weightChanges = [];

    for (const c of clients) {
      const ev = evs.get(c.id);
      if (ev.status === 'ON_TRACK') onTrack++;
      else if (ev.status === 'AT_RISK') atRisk++;
      else if (ev.status === 'NEEDS_ATTENTION') needs++;
      else inactive++;
      adherenceScores.push(ev.adherence.score);
      if (ev.adherence.components.workout !== null) workoutCompletion.push(ev.adherence.components.workout);
      if (ev.adherence.components.nutrition !== null) nutritionAdherence.push(ev.adherence.components.nutrition);
      const w7 = w7By.get(c.id) || [];
      if (w7.length >= 2) {
        weightChanges.push(((w7[w7.length - 1].weight - w7[0].weight) / w7[0].weight) * 100);
      }
    }

    const avg = (arr) => arr.length ? round1(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
    const newClients = clients.filter(c => c.created_at >= daysAgoIso(30)).length;

    // business numbers for owners
    const subs = await db.q(
      `SELECT * FROM subscriptions WHERE org_id = ? AND status = 'active'`, [orgId]);
    const renewalsDue = subs.filter(s => s.renewal_date && s.renewal_date <= daysAgoIso(-30)).length;
    const monthStart = todayKey().slice(0, 7) + '-01';
    const payments = await db.q(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE org_id = ? AND paid_at >= ?`,
      [orgId, monthStart]);

    res.json({
      kpis: {
        activeClients: clients.filter(c => c.status !== 'INACTIVE').length || (clients.length - inactive),
        newClients,
        onTrack, atRisk, needsAttention: needs, inactive,
        avgAdherence: avg(adherenceScores),
        avgWeightChange: weightChanges.length ? round1(avg(weightChanges)) : 0,
        workoutCompletion: avg(workoutCompletion),
        nutritionAdherence: avg(nutritionAdherence),
        renewalsDue, monthlyRevenue: Number(payments[0]?.total || 0)
      },
      clients: [...evs.entries()].map(([clientId, ev]) => ({
        clientId, status: ev.status, adherence: ev.adherence.score, rules: ev.rules
      }))
    });
  });

  // ---- /api/dashboard/attention — clients needing the trainer's focus ----
  // Owner/admin: org-wide attention list. Uses bulk evaluation.
  r.get('/attention', requireRole('GYM_OWNER', 'SUPER_ADMIN'), async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
    if (!clients.length) return res.json({ clients: [] });
    const evs = await evaluateClients(db, clients);
    const userIds = [...new Set(clients.map(c => c.user_id))];
    const users = userIds.length
      ? await db.q(`SELECT id, name FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, userIds)
      : [];
    const userBy = new Map(users.map(u => [u.id, u]));
    const out = [];
    for (const c of clients) {
      const ev = evs.get(c.id);
      if (ev.status === 'ON_TRACK' || ev.status === 'INACTIVE') continue;
      out.push({
        clientId: c.id, name: userBy.get(c.user_id)?.name || 'Client',
        status: ev.status, adherence: ev.adherence.score,
        goal: c.goal, currentWeight: c.current_weight, targetWeight: c.target_weight,
        rules: ev.rules
      });
    }
    out.sort((a, b) => b.rules.length - a.rules.length || a.adherence - b.adherence);
    res.json({ clients: out });
  });

  // ---- /api/dashboard/adherence-trend — avg adherence per day, 14 days ----
  // Trainers: scoped to their assigned clients only.
  // Owners/admins: org-wide.
  r.get('/adherence-trend', async (req, res) => {
    const orgId = req.orgId;
    const days = lastNDays(14);
    let whereClause = 'c.org_id = ?';
    const params = [orgId];
    if (req.user.role === 'TRAINER') {
      whereClause += ' AND c.trainer_id = ?';
      params.push(req.user.sub);
    }
    params.push(days[0]);
    const records = await db.q(
      `SELECT ar.date, ar.score FROM adherence_records ar
        JOIN clients c ON c.id = ar.client_id
       WHERE ${whereClause} AND ar.date >= ?`, params);
    const perDay = days.map(d => {
      const rows = records.filter(r => r.date === d);
      return { date: d, avg: rows.length ? round1(rows.reduce((s, x) => s + x.score, 0) / rows.length) : null };
    });
    res.json({ trend: perDay });
  });

  // ============================================================
  // TRAINER DASHBOARD — scoped to the authenticated trainer's clients
  // ============================================================
  // GET /api/dashboard/trainer
  // Returns aggregated metrics + per-client status for clients assigned
  // to the logged-in TRAINER only. Owners/admins should use /overview.
  //
  // Authorization: TRAINER role required. Org-scoped.
  // Never returns clients belonging to another trainer or organization.
  r.get('/trainer', requireRole('TRAINER'), async (req, res) => {
    const trainerId = req.user.sub;
    const orgId = req.orgId;
    const today = todayKey();

    // 1. Fetch ONLY the trainer's assigned clients (org + trainer scoped)
    const clients = await db.q(
      'SELECT * FROM clients WHERE org_id = ? AND trainer_id = ?',
      [orgId, trainerId]);

    if (!clients.length) {
      return res.json({
        kpis: {
          totalClients: 0, activeClients: 0,
          onTrack: 0, needsAttention: 0, atRisk: 0, inactive: 0,
          avgAdherence: null, avgWeightChange7d: null,
          todayWorkoutsCompleted: 0, todayWorkoutsTotal: 0,
          recentWorkoutCompletion: null
        },
        clients: [],
        attention: []
      });
    }

    // 2. Bulk-evaluate adherence + at-risk status (reuses existing services)
    const { evaluateClients } = await import('../services/atRisk.js');
    const evs = await evaluateClients(db, clients);
    const clientMap = new Map(clients.map(c => [c.id, c]));

    // 3. Bulk-fetch: user names, today's workouts, 7-day weight changes,
    //    recent workout completions, open alerts
    const ids = clients.map(c => c.id);
    const inClause = ids.map(() => '?').join(',');

    const [users, todayWorkouts, weightLogs7d, recentWorkouts, openAlerts] = await Promise.all([
      db.q(`SELECT id, name, email, avatar FROM users WHERE id IN (${inClause})`,
        clients.map(c => c.user_id)),
      // Today's workouts per client: assigned or completed
      db.q(`SELECT client_id, id, name, status, scheduled_date
              FROM workouts
             WHERE client_id IN (${inClause}) AND scheduled_date = ?`,
        [...ids, today]),
      // 7-day weight logs for weight-change calculation
      db.q(`SELECT client_id, date, weight FROM weight_logs
             WHERE client_id IN (${inClause}) AND date >= ?
             ORDER BY client_id, date`,
        [...ids, daysAgoIso(7)]),
      // Recent workout completion rate (last 14 days)
      db.q(`SELECT client_id, status FROM workouts
             WHERE client_id IN (${inClause})
               AND scheduled_date >= ? AND scheduled_date <= ?`,
        [...ids, daysAgoIso(14), today]),
      // Open alerts for this trainer's clients
      db.q(`SELECT a.id, a.client_id, a.type, a.severity, a.title, a.detail, a.created_at
              FROM alerts a
             WHERE a.client_id IN (${inClause}) AND a.status = 'open'
             ORDER BY CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.created_at DESC`,
        ids)
    ]);

    // 4. Build lookup maps
    const userBy = new Map(users.map(u => [u.id, u]));
    const twBy = new Map(); // today's workouts by client
    for (const w of todayWorkouts) {
      (twBy.get(w.client_id) || twBy.set(w.client_id, []).get(w.client_id)).push(w);
    }
    const w7By = new Map(); // 7-day weight logs by client
    for (const w of weightLogs7d) {
      (w7By.get(w.client_id) || w7By.set(w.client_id, []).get(w.client_id)).push(w);
    }
    const rwBy = new Map(); // recent workouts by client
    for (const w of recentWorkouts) {
      (rwBy.get(w.client_id) || rwBy.set(w.client_id, []).get(w.client_id)).push(w);
    }

    // 5. Compute per-client dashboard objects
    const clientDashboards = [];
    let onTrack = 0, atRisk = 0, needs = 0, inactive = 0;
    const adherenceScores = [];
    let totalTodayCompleted = 0, totalTodayScheduled = 0;
    let totalRecentCompleted = 0, totalRecentScheduled = 0;
    const weightChanges = [];

    for (const c of clients) {
      const ev = evs.get(c.id);
      const user = userBy.get(c.user_id);
      const tw = twBy.get(c.id) || [];
      const w7 = w7By.get(c.id) || [];
      const rw = rwBy.get(c.id) || [];

      // Status counts
      if (ev.status === 'ON_TRACK') onTrack++;
      else if (ev.status === 'AT_RISK') atRisk++;
      else if (ev.status === 'NEEDS_ATTENTION') needs++;
      else inactive++;

      adherenceScores.push(ev.adherence.score);

      // Today's workouts
      const todayCompleted = tw.filter(w => w.status === 'completed').length;
      const todayScheduled = tw.length;
      totalTodayCompleted += todayCompleted;
      totalTodayScheduled += todayScheduled;

      // Recent workout completion
      const recentCompleted = rw.filter(w => w.status === 'completed').length;
      const recentScheduled = rw.length;
      totalRecentCompleted += recentCompleted;
      totalRecentScheduled += recentScheduled;

      // 7-day weight change
      let change7d = null;
      if (w7.length >= 2) {
        change7d = round1(w7[w7.length - 1].weight - w7[0].weight);
        weightChanges.push(((w7[w7.length - 1].weight - w7[0].weight) / w7[0].weight) * 100);
      }

      clientDashboards.push({
        clientId: c.id,
        name: user?.name || 'Client',
        avatar: user?.avatar || null,
        goal: c.goal,
        currentWeight: c.current_weight,
        targetWeight: c.target_weight,
        status: ev.status,
        adherence: ev.adherence.score,
        change7d,
        todayWorkout: tw.length ? {
          name: tw[0].name,
          status: tw[0].status,
          completed: tw[0].status === 'completed'
        } : null,
        rules: ev.rules.slice(0, 3)
      });
    }

    // 6. Build KPIs
    const avg = (arr) => arr.length ? round1(arr.reduce((s, x) => s + x, 0) / arr.length) : null;

    const kpis = {
      totalClients: clients.length,
      activeClients: clients.filter(c => c.status !== 'INACTIVE').length,
      onTrack,
      needsAttention: needs,
      atRisk,
      inactive,
      avgAdherence: avg(adherenceScores),
      avgWeightChange7d: weightChanges.length ? round1(avg(weightChanges)) : null,
      todayWorkoutsCompleted: totalTodayCompleted,
      todayWorkoutsTotal: totalTodayScheduled,
      recentWorkoutCompletion: totalRecentScheduled > 0
        ? round1((totalRecentCompleted / totalRecentScheduled) * 100)
        : null
    };

    // 7. Attention list (clients needing focus, sorted by severity)
    const attention = clientDashboards
      .filter(c => c.status !== 'ON_TRACK' && c.status !== 'INACTIVE')
      .sort((a, b) => b.rules.length - a.rules.length || a.adherence - b.adherence);

    res.json({ kpis, clients: clientDashboards, attention });
  });

  return r;
}
