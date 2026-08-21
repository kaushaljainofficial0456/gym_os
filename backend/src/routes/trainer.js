// ============================================================
// TRAINER-SPECIFIC ROUTES
//   * Client detail dashboard — drill-down view for a single client
// ============================================================
import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { evaluateClient } from '../services/atRisk.js';
import { daysAgoIso, todayKey, round1 } from '../utils/time.js';

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
      waterLog
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
        [client.id, today])
    ]);

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
      recentActivity
    });
  });

  return r;
}
