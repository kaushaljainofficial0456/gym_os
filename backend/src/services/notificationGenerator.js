// ============================================================
// NOTIFICATION GENERATOR — creates smart in-app notifications
// from existing workout, water, nutrition, and schedule data.
//
// Called on-demand by POST /api/notifications/generate -- the
// notification bell triggers it when the app opens, when it comes back
// to the foreground, and every few minutes while it is open.
//
// Deduplication: each notification type uses a date-scoped
// dedup_key (e.g. "water_reminder:2026-09-02") to prevent
// duplicate reminders within the same day.
//
// Zero-cost: uses only existing DB data + browser timers.
// No paid APIs, no push notification services, no cron workers.
// ============================================================
import { id, now } from '../ids.js';
import { shiftDayKey, logDayKey, DEFAULT_DAY_START_HOUR } from '../utils/time.js';

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

/** Local wall-clock time in `tz` at instant `at`. */
function localTime(at, tz) {
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(at);
  const [h, m] = hm.split(':').map(Number);
  // en-GB renders midnight as "24" in some engines.
  const hour = h % 24;
  return { hour, mins: hour * 60 + m };
}

export function isQuietHours(prefs, orgTz, at = new Date()) {
  if (!prefs || prefs.quiet_hours_start == null || prefs.quiet_hours_end == null) return false;
  try {
    const { mins } = localTime(at, orgTz || 'UTC');

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

/** What a logging day added up to, as the recap's lines. */
async function dailyRecap(db, clientId, day) {
  const workout = await db.q1(
    `SELECT id, name, duration_min, estimated_active_kcal FROM workouts
      WHERE client_id = ? AND scheduled_date = ? AND status = 'completed'`, [clientId, day]);
  let workoutLine = 'No workout completed';
  if (workout) {
    const sets = await db.q1(
      `SELECT COUNT(*) AS cnt, COUNT(DISTINCT esl.exercise_id) AS ex,
              COALESCE(SUM(CASE WHEN esl.actual_weight > 0 THEN esl.actual_reps * esl.actual_weight ELSE 0 END), 0) AS vol
         FROM exercise_set_logs esl JOIN workout_logs wl ON wl.id = esl.workout_log_id
        WHERE wl.client_id = ? AND wl.date = ? AND esl.completed = 1`, [clientId, day]);
    const parts = [`🏋️ ${workout.name}`];
    if (Number(sets?.cnt)) parts.push(`${Number(sets.cnt)} sets`);
    if (Number(sets?.ex)) parts.push(`${Number(sets.ex)} exercises`);
    if (Number(sets?.vol) > 0) parts.push(`${Math.round(Number(sets.vol)).toLocaleString()} kg volume`);
    if (workout.duration_min) parts.push(`${Math.round(workout.duration_min)} min`);
    if (workout.estimated_active_kcal) parts.push(`${Math.round(workout.estimated_active_kcal)} kcal`);
    workoutLine = parts.join(' · ');
  }
  const water = await db.q1(`SELECT litres FROM water_logs WHERE client_id = ? AND date = ?`, [clientId, day]);
  const food = await db.q1(
    `SELECT SUM(calories) AS cal, SUM(protein) AS pro FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1`,
    [clientId, day]);
  const litres = Number(water?.litres) || 0;
  const cal = Number(food?.cal) || 0;
  return {
    hasActivity: !!workout || litres > 0 || cal > 0,
    body: [
      workoutLine,
      litres > 0 ? `${Math.round(litres * 10) / 10} L water` : 'No water logged',
      cal > 0 ? `${Math.round(cal)} kcal · ${Math.round(Number(food.pro) || 0)}g protein` : 'No nutrition logged',
    ].join('\n'),
  };
}

// ============================================================
// MAIN GENERATOR
// ============================================================
export async function generateNotifications(db, userId, orgId, { now: nowTs = new Date() } = {}) {
  const created = [];

  // Load user preferences
  let prefs = await db.q1(
    `SELECT * FROM notification_preferences WHERE user_id = ?`,
    [userId]
  );
  if (!prefs) {
    const ts = now();
    // org_id is NOT NULL: without it this insert failed, the route
    // swallowed the error, and anyone who had never opened Settings got
    // no reminders at all.
    await db.run(
      `INSERT INTO notification_preferences (user_id, org_id, updated_at) VALUES (?, ?, ?)`,
      [userId, orgId, ts]
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

  // Get client record
  const client = await db.q1(
    `SELECT c.id, cp.water_target_l, cp.day_start_hour
       FROM clients c LEFT JOIN client_profiles cp ON cp.client_id = c.id
      WHERE c.user_id = ?`, [userId]);
  if (!client) return created;
  const clientId = client.id;

  /* "Today" is the member's own logging day, the one every log in the app
     is filed under -- not the calendar date. With "my day starts at 4am",
     a 1am check still belongs to yesterday: reminding someone at 1am that
     they have not logged "today's" meals would be about a day that has
     barely begun. */
  const startHour = client.day_start_hour ?? DEFAULT_DAY_START_HOUR;
  const today = logDayKey(nowTs, orgTz, startHour);
  const { hour, mins: currentMins } = localTime(nowTs, orgTz);

  // Quiet hours were saved in Settings and never consulted. Inside them
  // only the daily recap is made (silently, see below); a reminder that is
  // due then arrives with the first check after they end -- each one is
  // keyed by day, so the later check still creates it.
  const quiet = isQuietHours(prefs, orgTz, nowTs);

  // ── 1. WATER REMINDERS ──
  // Against the member's own target (was a fixed 1.5 L for everyone), and
  // only when they are behind the pace a steady day from 7am to 10pm
  // would set -- someone on track is not nagged. One per interval window.
  if (!quiet && prefs.water_reminders && hour >= 9 && hour <= 21) {
    const waterLog = await db.q1(
      `SELECT litres FROM water_logs WHERE client_id = ? AND date = ?`,
      [clientId, today]
    );
    const currentWater = Number(waterLog?.litres) || 0;
    const target = Number(client.water_target_l) > 0 ? Number(client.water_target_l) : 3;
    const intervalH = Number(prefs.water_interval_h) > 0 ? Number(prefs.water_interval_h) : 2;
    const pace = target * Math.min(1, Math.max(0, (currentMins - 7 * 60) / (15 * 60)));
    if (currentWater < target && currentWater + 0.25 < pace) {
      const window = Math.floor((hour - 7) / intervalH);
      const notif = await upsertNotification(db, {
        userId, orgId, clientId,
        type: 'water_reminder',
        title: '💧 Hydration reminder',
        body: `${pickRandom(WATER_MESSAGES)} You're at ${Math.round(currentWater * 10) / 10} of ${target} L today.`,
        dedupKey: `water:${today}:${window}`,
      });
      if (notif) created.push(notif);
    }
  }

  // ── 2. WORKOUT REMINDER (assigned workout today) ──
  if (!quiet && prefs.workout_reminders) {
    const todayWorkout = await db.q1(
      `SELECT id, name FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned'`,
      [clientId, today]
    );
    if (todayWorkout) {
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
  if (!quiet && prefs.tomorrow_workout) {
    /* Tomorrow relative to the GYM's today, by plain calendar arithmetic
       on the day key -- not `new Date()` plus a day read back in UTC.
       This send window is the local evening, and west of UTC the local
       evening is already the next UTC day: at 21:00 in New York it is
       01:00 UTC tomorrow, so "tomorrow" came out as the day AFTER
       tomorrow. Nothing is scheduled for that date, so the evening
       reminder did not name the wrong workout -- it silently never
       arrived, for three hours of every evening, for every gym west of
       UTC. */
    const tomorrowKey = shiftDayKey(today, 1);

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
      } else if (prefs.rest_day_reminders) {
        // Rest day tomorrow -- only for someone who asked for rest-day
        // nudges; it was sent even with that switch off.
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
  if (!quiet && prefs.rest_day_reminders && hour >= 8) {
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
  if (!quiet && prefs.nutrition_reminders) {
    const mealCount = await db.q1(
      `SELECT COUNT(*) AS cnt FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1`,
      [clientId, today]
    );
    // Only remind after midday and if no meals logged. Number(): COUNT is
    // a bigint STRING on Postgres, and "0" === 0 is false -- the reminder
    // never fired there.
    if (hour >= 12 && !Number(mealCount?.cnt)) {
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
  if (!quiet && prefs.incomplete_workout) {
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

  // ── 7. DAILY RECAP ──
  // From the chosen time until the logging day ends, compared as positions
  // within the LOGGING day: 1am with a 4am start is still the evening
  // before, and a 00:30 recap time is not mistaken for early that same
  // evening. This used to be a 30-minute window -- and reminders are only
  // made while the app is open, so it needed the app open in exactly those
  // 30 minutes and in practice never came. An evening the app was not
  // opened is caught up the next day, if that day had anything to report.
  if (prefs.daily_summary) {
    const [summaryH, summaryM] = (prefs.daily_summary_time || '23:30').split(':').map(Number);
    const sinceDayStart = (m) => (m - startHour * 60 + 1440) % 1440;
    const afterTarget = sinceDayStart(currentMins) >= sinceDayStart(summaryH * 60 + summaryM);
    const yesterday = shiftDayKey(today, -1);
    const recapDay = afterTarget ? today : yesterday;
    const dedupKey = `daily_summary:${recapDay}`;
    const existing = await db.q1(`SELECT id FROM notifications WHERE user_id = ? AND dedup_key = ?`, [userId, dedupKey]);
    if (!existing) {
      const recap = await dailyRecap(db, clientId, recapDay);
      if (afterTarget || recap.hasActivity) {
        const notif = await upsertNotification(db, {
          userId, orgId, clientId,
          type: 'daily_summary',
          title: recapDay === today ? '📊 Your Barbell day' : '📊 Yesterday on Barbell',
          body: recap.body,
          dedupKey,
          dataJson: JSON.stringify({ date: recapDay }),
        });
        // Inside quiet hours the recap still lands in the bell, but
        // silently: nothing should buzz a phone at night.
        if (notif) created.push(quiet ? { ...notif, silent: true } : notif);
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
