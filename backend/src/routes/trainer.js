// ============================================================
// TRAINER-SPECIFIC ROUTES
//   * Client detail dashboard — drill-down view for a single client
// ============================================================
import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { evaluateClient } from '../services/atRisk.js';
import { daysAgoIso, todayKey, round1 } from '../utils/time.js';
import { liveCrowd } from '../services/access/liveCrowd.js';
import { localParts } from '../services/access/localTime.js';

export default function trainerRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('TRAINER'), orgScope);

  // ============================================================
  // GET /api/trainer/clients/:clientId/dashboard
  // ============================================================
  // Trainer's client-detail screen. Returns a comprehensive snapshot
  // of a single client's current status, adherence, weight, workouts,
  // nutrition, and alerts.
  //
  // Authorization:
  //   - TRAINER role required (enforced at router level)
  //   - client must belong to the trainer (trainer_id = req.user.sub)
  //   - client must belong to the same org
  //   - returns 404 for clients the trainer doesn't own (avoids
  //     leaking existence of other trainers' clients)
  /* ---------------- gym crowd, trainer view ----------------------------
     AGGREGATE ONLY, and gated twice.

     A trainer is staff, not an owner: they get the same head-count a
     member does so they can plan a session around a busy floor, and
     nothing else. No member-level presence, no device list, no event log,
     no provider state -- those live behind access.view, which TRAINER
     does not hold.

     The owner switches this off with crowd_trainer_visible, separately
     from the member card: a gym may want its floor staff to see the crowd
     while not publishing it to members, and the reverse. */
  r.get('/crowd', async (req, res) => {
    const settings = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    if (settings && (settings.crowd_enabled === 0 || settings.crowd_trainer_visible === 0)) {
      return res.json({ enabled: false, reason: 'not_published' });
    }
    const snapshot = await liveCrowd(db, req.orgId, req.tz, settings, {
      showExactCount: settings?.crowd_show_exact_count !== 0,
    });
    res.json(snapshot);
  });

  /* ---------------- my clients, in the building -----------------------
     Member-level, so scoped as tightly as the data allows: ONLY this
     trainer's own assigned clients (clients.trainer_id), ONLY whether they
     are inside and whether they came in today, and ONLY when the owner has
     trainer crowd visibility on. No times beyond today, no device, no
     access ID, nothing about anyone else's clients. Demo sessions never
     appear -- a trainer must not plan around a simulated client. */
  r.get('/crowd/clients', async (req, res) => {
    const settings = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [req.orgId]);
    if (settings && (settings.crowd_enabled === 0 || settings.crowd_trainer_visible === 0)) {
      return res.json({ enabled: false, reason: 'not_published', clients: [] });
    }
    /* "Came in today" means the gym's today. A rolling 18-hour window
       said yes at 9am for a client who trained at 7pm yesterday. The window
       below is only wide enough to find the latest entry; the day test is
       done in the gym's timezone. */
    const since = new Date(Date.now() - 36 * 3600_000).toISOString();
    const todayLocal = localParts(new Date(), req.tz)?.day;
    const rows = await db.q(
      `SELECT c.id, u.name,
              (SELECT MIN(s.entered_at) FROM gym_presence_sessions s
                WHERE s.client_id = c.id AND s.org_id = c.org_id AND s.is_demo = 0 AND s.status = 'OPEN') AS inside_since,
              (SELECT MAX(s.entered_at) FROM gym_presence_sessions s
                WHERE s.client_id = c.id AND s.org_id = c.org_id AND s.is_demo = 0 AND s.entered_at >= ?) AS last_entry
         FROM clients c JOIN users u ON u.id = c.user_id
        WHERE c.org_id = ? AND c.trainer_id = ?
        ORDER BY u.name`, [since, req.orgId, req.user.sub]);
    res.json({
      enabled: true,
      clients: rows.map((r) => ({
        id: r.id,
        name: r.name,
        insideNow: !!r.inside_since,
        insideSince: r.inside_since || null,
        cameInToday: !!r.last_entry && localParts(r.last_entry, req.tz)?.day === todayLocal,
      })),
    });
  });

  r.get('/clients/:clientId/dashboard', async (req, res) => {
    const trainerId = req.user.sub;
    const orgId = req.orgId;
    const clientId = req.params.clientId;
    const today = todayKey();

    // ---- 1. Resolve client with trainer + org check ----
    const client = await db.q1(
      `SELECT c.*, u.name, u.email, u.avatar, u.phone
         FROM clients c JOIN users u ON u.id = c.user_id
        WHERE c.id = ?`, [clientId]);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    // Trainer must own this client AND be in the same org
    if (client.org_id !== orgId || client.trainer_id !== trainerId) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // ---- 2. Run existing evaluation (adherence + at-risk rules) ----
    const ev = await evaluateClient(db, client);

    // ---- 3. Fetch all data in parallel ----
    const sevenDaysAgo = daysAgoIso(7);
    const fourteenDaysAgo = daysAgoIso(14);

    const [
      profile,
      weightHistory,
      todayWorkouts,
      recentWorkouts,
      recentWorkouts7d,
      openAlerts,
      latestPlan,
      todayMealLogs,
      waterLog,
      photoRows,
      measurements
    ] = await Promise.all([
      // Profile for sleep/water targets
      db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [client.id]),
      // Weight history — last 90 days for progress chart
      db.q(`SELECT date, weight FROM weight_logs WHERE client_id = ? AND date >= ?
             ORDER BY date`, [client.id, daysAgoIso(90)]),
      // Today's workouts
      db.q(`SELECT id, name, status, scheduled_date FROM workouts
             WHERE client_id = ? AND scheduled_date = ?
             ORDER BY scheduled_date`, [client.id, today]),
      // Recent workouts — last 14 days for history list
      db.q(`SELECT id, name, status, scheduled_date FROM workouts
             WHERE client_id = ? AND scheduled_date >= ? AND scheduled_date <= ?
             ORDER BY scheduled_date DESC, created_at DESC
             LIMIT 20`, [client.id, fourteenDaysAgo, today]),
      // 7-day workout completion stats
      db.q(`SELECT status FROM workouts
             WHERE client_id = ? AND scheduled_date >= ? AND scheduled_date <= ?`,
        [client.id, sevenDaysAgo, today]),
      // Open alerts
      db.q(`SELECT type, severity, title, detail FROM alerts
             WHERE client_id = ? AND status = 'open'
             ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                      created_at DESC`, [client.id]),
      // Latest nutrition plan (for targets)
      db.q1(`SELECT * FROM nutrition_plans WHERE client_id = ?
              ORDER BY created_at DESC LIMIT 1`, [client.id]),
      // Today's meal logs (eaten only)
      db.q(`SELECT calories, protein, carbs, fat FROM meal_logs
             WHERE client_id = ? AND date = ? AND eaten = 1`,
        [client.id, today]),
      // Today's water
      db.q1(`SELECT litres FROM water_logs WHERE client_id = ? AND date = ?`,
        [client.id, today]),
      // Progress photos — this endpoint never fetched these at all, so a
      // TRAINER (as opposed to GYM_OWNER, who reads the client through the
      // separate /clients/:id/overview route) could never see a client's
      // transformation photos through their own client-detail page, even
      // right after uploading one themselves. See mapTrainerResponse() in
      // ClientProfile.jsx, which previously had no choice but to hardcode
      // `photos: []` because there was nothing here to map from.
      db.q('SELECT * FROM progress_photos WHERE client_id = ? ORDER BY taken_at', [client.id]),
      // Measurements — same gap, same fix.
      db.q('SELECT * FROM measurements WHERE client_id = ? ORDER BY taken_at DESC LIMIT 12', [client.id])
    ]);
    const { objectUrl } = await import('../storage.js');
    const photos = photoRows.map((p) => ({ ...p, imageUrl: objectUrl(p.storage_key) || p.data_url || null }));

    // ---- 4. Compute summary metrics ----

    // Weight change (absolute kg, not percentage)
    let weightChange7d = null;
    if (weightHistory.length >= 2) {
      const recent = weightHistory.filter(w => w.date >= sevenDaysAgo);
      if (recent.length >= 2) {
        weightChange7d = round1(recent[recent.length - 1].weight - recent[0].weight);
      } else if (weightHistory.length >= 2) {
        // Fallback: compare last available to 7-days-ago boundary
        weightChange7d = round1(
          weightHistory[weightHistory.length - 1].weight -
          weightHistory[Math.max(0, weightHistory.length - 2)].weight
        );
      }
    }

    // Workout completion rate (7 days)
    const workoutsCompleted7d = recentWorkouts7d.filter(w => w.status === 'completed').length;
    const workoutsScheduled7d = recentWorkouts7d.length;
    const completionRate7d = workoutsScheduled7d > 0
      ? round1((workoutsCompleted7d / workoutsScheduled7d) * 100)
      : null;

    // Today's nutrition totals
    const todayNutrition = todayMealLogs.reduce((acc, l) => ({
      calories: acc.calories + l.calories,
      protein: acc.protein + l.protein,
      carbs: acc.carbs + l.carbs,
      fat: acc.fat + l.fat
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const hasNutritionPlan = !!latestPlan;

    // ---- 5. Build response ----

    // Client info — only safe fields
    const clientInfo = {
      id: client.id,
      name: client.name,
      email: client.email,
      avatar: client.avatar || null,
      goal: client.goal,
      currentWeight: client.current_weight,
      targetWeight: client.target_weight,
      height: client.height_cm || null,
      age: client.age || null,
      sex: client.sex || null,
      startWeight: client.start_weight || null,
      goalDate: client.goal_date || null,
      // Was the raw `clients.status` DB column, which nothing in the
      // codebase ever updates after seed/creation — stale by definition.
      // `ev` (evaluateClient, above) is the same live rule engine the
      // trainer dashboard's attention list uses; reuse its result so this
      // page can't disagree with the dashboard about a client's status.
      status: ev.status
    };

    // Summary
    const summary = {
      status: ev.status,
      adherence: ev.adherence.score,
      weightChange7d,
      workoutsCompleted7d,
      workoutsScheduled7d,
      nutritionAdherence: ev.adherence.components.nutrition
    };

    // Weight
    const weight = {
      current: client.current_weight,
      target: client.target_weight,
      change7d: weightChange7d,
      history: weightHistory.map(w => ({ date: w.date, weight: w.weight }))
    };

    // Workouts
    const workouts = {
      today: todayWorkouts.length ? {
        name: todayWorkouts[0].name,
        status: todayWorkouts[0].status
      } : null,
      recent: recentWorkouts.map(w => ({
        date: w.scheduled_date,
        name: w.name,
        status: w.status
      })),
      completionRate7d
    };

    // Nutrition
    const nutrition = {
      today: {
        calories: todayNutrition.calories,
        targetCalories: latestPlan?.calories || null,
        protein: todayNutrition.protein,
        targetProtein: latestPlan?.protein || null,
        carbs: todayNutrition.carbs,
        targetCarbs: latestPlan?.carbs || null,
        fat: todayNutrition.fat,
        targetFat: latestPlan?.fat || null
      }
    };

    // Hydration
    const hydration = {
      today: waterLog?.litres || 0,
      target: profile?.water_target_l || 3
    };

    // Alerts — only rules from evaluation (no raw DB rows)
    const alerts = ev.rules.map(r => ({
      type: r.type,
      severity: r.severity,
      title: r.title
    }));

    // Recent activity — compact feed of recent events
    const recentActivity = recentWorkouts.slice(0, 5).map(w => ({
      type: w.status === 'completed' ? 'workout_completed' : 'workout_scheduled',
      date: w.scheduled_date,
      name: w.name,
      status: w.status
    }));

    res.json({
      client: clientInfo,
      summary,
      weight,
      workouts,
      nutrition,
      hydration,
      alerts,
      recentActivity,
      photos,
      measurements
    });
  });

  return r;
}
