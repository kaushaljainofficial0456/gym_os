// ============================================================
// NOTIFICATION GENERATOR — creates smart in-app notifications
// from existing workout, water, nutrition, and schedule data.
//
// Called on-demand by POST /api/notifications/generate (frontend
// triggers this on app load and periodically via browser timers).
//
// Deduplication: each notification type uses a date-scoped
// dedup_key (e.g. "water_reminder:2026-09-02") to prevent
// duplicate reminders within the same day.
//
// Zero-cost: uses only existing DB data + browser timers.
// No paid APIs, no push notification services, no cron workers.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, getOrgTz } from '../utils/time.js';

const WATER_MESSAGES = [
  'Time for some water 💧',
  "You've been going for a while — don't forget to hydrate.",
  'Keep your hydration on track today 💧',
  'Hydration check! Take a sip of water.',
  'Water break 💧 Your body will thank you.',
];

const REST_DAY_MESSAGES = [
  'Rest day 🌙 Recovery is part of progress.',
  "Today is your rest day. Take it easy and recover.",
  "Rest day — come back stronger tomorrow 💪",
];

const NUTRITION_MESSAGES = [
  "You haven't logged today's meals yet 🍽️",
  "Don't forget to log your nutrition for today.",
  'Keep your nutrition tracking consistent 🍽️',
];

const INCOMPLETE_MESSAGES = [
  "Your workout is still unfinished 🏋️",
  "Want to finish your session? Pick up where you left off.",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isQuietHours(prefs, orgTz) {
  if (!prefs || prefs.quiet_hours_start == null || prefs.quiet_hours_end == null) return false;
  try {
    const now = new Date();
    // Use org timezone if available, otherwise fall back to UTC
    const tz = orgTz || 'UTC';
    const fmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const hm = fmt.format(now); // "HH:MM"
    const [h, m] = hm.split(':').map(Number);
    const mins = h * 60 + m;

    const [sh, sm] = (prefs.quiet_hours_start || '23:45').split(':').map(Number);
    const [eh, em] = (prefs.quiet_hours_end || '07:00').split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;

    if (startMins > endMins) {
      // Spans midnight: e.g. 23:45 → 07:00
      return mins >= startMins || mins < endMins;
    }
    return mins >= startMins && mins < endMins;
  } catch {
    return false;
  }
}

async function upsertNotification(db, { userId, orgId, clientId, type, title, body, dedupKey, dataJson }) {
  // Deduplication: skip if a notification with the same dedup_key already exists today
  if (dedupKey) {
    const existing = await db.q1(
      `SELECT id FROM notifications WHERE user_id = ? AND dedup_key = ?`,
      [userId, dedupKey]
    );
    if (existing) return null;
  }

  const notifId = id('ntf');
  const ts = now();
  await db.run(
    `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, data_json, dedup_key, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [notifId, orgId, userId, clientId || null, type, title, body, dataJson || null, dedupKey || null, ts]
  );
  return { id: notifId, type, title, body, created_at: ts, read: 0 };
}

// ============================================================
// MAIN GENERATOR
// ============================================================
export async function generateNotifications(db, userId, orgId) {
  const created = [];

  // Load user preferences
  let prefs = await db.q1(
    `SELECT * FROM notification_preferences WHERE user_id = ?`,
    [userId]
  );
  if (!prefs) {
    const ts = now();
    await db.run(
      `INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?)`,
      [userId, ts]
    );
    prefs = await db.q1(
      `SELECT * FROM notification_preferences WHERE user_id = ?`,
      [userId]
    );
  }

  // Master toggle: all notifications disabled
  if (!prefs || !prefs.enabled) return created;

  // Get org timezone for time-based logic
  const org = await db.q1(`SELECT timezone FROM organizations WHERE id = ?`, [orgId]);
  const orgTz = org?.timezone || 'UTC';
  const today = dayKey(new Date(), orgTz);
  const nowTs = new Date();

  // Get client record
  const client = await db.q1(`SELECT id FROM clients WHERE user_id = ?`, [userId]);
  if (!client) return created;
  const clientId = client.id;

  // ── 1. WATER REMINDERS ──
  if (prefs.water_reminders) {
    const waterLog = await db.q1(
      `SELECT litres FROM water_logs WHERE client_id = ? AND date = ?`,
      [clientId, today]
    );
    const currentWater = waterLog?.litres || 0;
    const intervalH = prefs.water_interval_h || 2;

    // Check when water was last logged (approximate: check the log's existence)
    // We create a water reminder if:
    // - Water hasn't been logged today yet, OR
    // - It's been a reasonable time since start of day and water is below a basic threshold
    const hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));

    // Only remind during waking hours (7am–11pm) and if water is low
    if (hour >= 7 && hour <= 23 && currentWater < 1.5) {
      // Approximate: one reminder per interval hours
      const hoursSinceMorning = hour - 7;
      const expectedReminders = Math.floor(hoursSinceMorning / intervalH);
      const dedupKey = `water:${today}:${expectedReminders}`;

      const notif = await upsertNotification(db, {
        userId, orgId, clientId,
        type: 'water_reminder',
        title: '💧 Hydration reminder',
        body: pickRandom(WATER_MESSAGES),
        dedupKey,
      });
      if (notif) created.push(notif);
    }
  }

  // ── 2. WORKOUT REMINDER (assigned workout today) ──
  if (prefs.workout_reminders) {
    const todayWorkout = await db.q1(
      `SELECT id, name FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned'`,
      [clientId, today]
    );
    if (todayWorkout) {
      const hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));
      // Remind during reasonable hours (8am–6pm) only once
      if (hour >= 8 && hour <= 18) {
        const dedupKey = `workout_reminder:${today}:${todayWorkout.id}`;
        const notif = await upsertNotification(db, {
          userId, orgId, clientId,
          type: 'workout_reminder',
          title: '💪 Workout reminder',
          body: `Your ${todayWorkout.name} is waiting. Let's get started!`,
          dedupKey,
          dataJson: JSON.stringify({ workout_id: todayWorkout.id }),
        });
        if (notif) created.push(notif);
      }
    }
  }

  // ── 3. TOMORROW'S WORKOUT ──
  if (prefs.tomorrow_workout) {
    const tomorrow = new Date(nowTs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = tomorrow.toISOString().slice(0, 10);

    const hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));

    // Send in the evening (6pm–11pm) only once
    if (hour >= 18 && hour <= 23) {
      const tomorrowWorkout = await db.q1(
        `SELECT id, name FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned'`,
        [clientId, tomorrowKey]
      );

      const dedupKey = `tomorrow_workout:${tomorrowKey}`;

      if (tomorrowWorkout) {
        const notif = await upsertNotification(db, {
          userId, orgId, clientId,
          type: 'tomorrow_workout',
          title: "Tomorrow's workout 💪",
          body: `Tomorrow is ${tomorrowWorkout.name}. Get ready!`,
          dedupKey,
          dataJson: JSON.stringify({ workout_id: tomorrowWorkout.id, date: tomorrowKey }),
        });
        if (notif) created.push(notif);
      } else {
        // Rest day tomorrow
        const notif = await upsertNotification(db, {
          userId, orgId, clientId,
          type: 'rest_day',
          title: 'Rest day tomorrow 🌙',
          body: pickRandom(REST_DAY_MESSAGES),
          dedupKey,
        });
        if (notif) created.push(notif);
      }
    }
  }

  // ── 4. REST DAY (today) ──
  if (prefs.rest_day_reminders) {
    const todayWorkout = await db.q1(
      `SELECT id FROM workouts WHERE client_id = ? AND scheduled_date = ?`,
      [clientId, today]
    );
    if (!todayWorkout) {
      const dedupKey = `rest_day:${today}`;
      const notif = await upsertNotification(db, {
        userId, orgId, clientId,
        type: 'rest_day',
        title: 'Rest day 🌙',
        body: pickRandom(REST_DAY_MESSAGES),
        dedupKey,
      });
      if (notif) created.push(notif);
    }
  }

  // ── 5. NUTRITION REMINDER ──
  if (prefs.nutrition_reminders) {
    const mealCount = await db.q1(
      `SELECT COUNT(*) AS cnt FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1`,
      [clientId, today]
    );
    const hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));

    // Only remind after midday and if no meals logged
    if (hour >= 12 && (!mealCount || mealCount.cnt === 0)) {
      const dedupKey = `nutrition:${today}`;
      const notif = await upsertNotification(db, {
        userId, orgId, clientId,
        type: 'nutrition_reminder',
        title: '🍽️ Nutrition reminder',
        body: pickRandom(NUTRITION_MESSAGES),
        dedupKey,
      });
      if (notif) created.push(notif);
    }
  }

  // ── 6. INCOMPLETE WORKOUT ──
  if (prefs.incomplete_workout) {
    // Check if there's a workout that was started but not completed today
    const incompleteWorkout = await db.q1(
      `SELECT id, name, started_at, progress_json FROM workouts
       WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned' AND started_at IS NOT NULL`,
      [clientId, today]
    );
    if (incompleteWorkout && incompleteWorkout.progress_json) {
      const dedupKey = `incomplete:${today}:${incompleteWorkout.id}`;
      const notif = await upsertNotification(db, {
        userId, orgId, clientId,
        type: 'incomplete_workout',
        title: 'Incomplete workout',
        body: `Your ${incompleteWorkout.name} is still unfinished. Want to finish your session?`,
        dedupKey,
        dataJson: JSON.stringify({ workout_id: incompleteWorkout.id }),
      });
      if (notif) created.push(notif);
    }
  }

  // ── 7. END-OF-DAY SUMMARY (nightly) ──
  if (prefs.daily_summary) {
    // Determine target hour/minute from preferences
    const [summaryH, summaryM] = (prefs.daily_summary_time || '23:30').split(':').map(Number);
    const currentH = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));
    const currentM = parseInt(new Intl.DateTimeFormat('en-GB', { minute: '2-digit', hour12: false, timeZone: orgTz }).format(nowTs));

    // Send within a 30-minute window of the target time
    const currentMins = currentH * 60 + currentM;
    const targetMins = summaryH * 60 + summaryM;

    if (currentMins >= targetMins && currentMins < targetMins + 30) {
      const dedupKey = `daily_summary:${today}`;
      const existingSummary = await db.q1(
        `SELECT id FROM notifications WHERE user_id = ? AND dedup_key = ?`,
        [userId, dedupKey]
      );

      if (!existingSummary) {
        // Build summary from real data
        const todayWorkout = await db.q1(
          `SELECT id, name, duration_min, estimated_active_kcal FROM workouts
           WHERE client_id = ? AND scheduled_date = ? AND status = 'completed'`,
          [clientId, today]
        );

        let workoutSummary = 'No workout completed today';
        if (todayWorkout) {
          const setsDone = await db.q1(
            `SELECT COUNT(*) AS cnt FROM exercise_set_logs esl
             JOIN workout_logs wl ON wl.id = esl.workout_log_id
             WHERE wl.client_id = ? AND wl.date = ? AND esl.completed = 1`,
            [clientId, today]
          );
          const exercises = await db.q1(
            `SELECT COUNT(DISTINCT exercise_id) AS cnt FROM exercise_set_logs esl
             JOIN workout_logs wl ON wl.id = esl.workout_log_id
             WHERE wl.client_id = ? AND wl.date = ?`,
            [clientId, today]
          );
          const volume = await db.q1(
            `SELECT COALESCE(SUM(esl.actual_reps * esl.actual_weight), 0) AS vol
             FROM exercise_set_logs esl
             JOIN workout_logs wl ON wl.id = esl.workout_log_id
             WHERE wl.client_id = ? AND wl.date = ? AND esl.completed = 1 AND esl.actual_weight IS NOT NULL AND esl.actual_weight > 0`,
            [clientId, today]
          );

          const parts = [`🏋️ ${todayWorkout.name}`];
          if (setsDone?.cnt) parts.push(`${setsDone.cnt} sets`);
          if (exercises?.cnt) parts.push(`${exercises.cnt} exercises`);
          if (volume?.vol > 0) parts.push(`${Math.round(volume.vol).toLocaleString()} kg volume`);
          if (todayWorkout.duration_min) parts.push(`${Math.round(todayWorkout.duration_min)} min`);
          if (todayWorkout.estimated_active_kcal) parts.push(`${Math.round(todayWorkout.estimated_active_kcal)} kcal`);
          workoutSummary = parts.join(' · ');
        }

        const waterLog = await db.q1(
          `SELECT litres FROM water_logs WHERE client_id = ? AND date = ?`,
          [clientId, today]
        );
        const waterSummary = waterLog ? `${waterLog.litres} L water` : 'No water logged';

        const nutritionLog = await db.q1(
          `SELECT SUM(calories) AS cal, SUM(protein) AS pro
           FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1`,
          [clientId, today]
        );
        const nutritionSummary = nutritionLog?.cal
          ? `${Math.round(nutritionLog.cal)} kcal · ${Math.round(nutritionLog.pro || 0)}g protein`
          : 'No nutrition logged';

        const summaryBody = [
          workoutSummary,
          waterSummary,
          nutritionSummary,
        ].join('\n');

        const notif = await upsertNotification(db, {
          userId, orgId, clientId,
          type: 'daily_summary',
          title: '📊 Your Gym OS day',
          body: summaryBody,
          dedupKey,
          dataJson: JSON.stringify({ date: today }),
        });
        if (notif) created.push(notif);
      }
    }
  }

  // Cleanup: prune notifications older than 30 days (keep DB lean)
  const thirtyDaysAgo = new Date(nowTs);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const pruneTs = thirtyDaysAgo.toISOString();
  await db.run(
    `DELETE FROM notifications WHERE user_id = ? AND created_at < ?`,
    [userId, pruneTs]
  ).catch(() => {});

  return created;
}
