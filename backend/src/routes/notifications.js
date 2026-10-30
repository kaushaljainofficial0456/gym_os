// ============================================================
// NOTIFICATION CENTER — client- and trainer-facing.
//
//   * GET/PATCH /preferences  -- the toggles Settings.jsx's
//     NotificationSettingsCard already calls (see that component's own
//     comment: it fails gracefully when this route isn't mounted, which is
//     exactly what happened from manavi-progress-enhancements-v2's merge
//     until this file existed).
//   * GET /                   -- list this user's own notifications
//   * PATCH /:id/read         -- mark one read
//   * POST /read-all          -- mark every unread one read
//
// Every row this reads/writes is scoped to req.user.sub (never another
// user's), and preferences are additionally scoped to req.user.org on
// creation so a lazily-created row always carries the right org_id.
//
// REMINDERS are made by POST /generate (services/notificationGenerator.js),
// which the notification bell calls when the app opens, when it returns to
// the foreground, and every few minutes while open. They land in this list
// and, where the browser allows it, as a system notification on the device.
// Delivery while the app is fully closed would need a push provider and a
// scheduler, which this deployment does not have.
// ============================================================
import { Router } from 'express';
import { generateNotifications } from '../services/notificationGenerator.js';
import { requireAuth } from '../auth.js';
import { now } from '../ids.js';

const PREF_BOOL_FIELDS = [
  'enabled', 'workout_reminders', 'water_reminders', 'nutrition_reminders',
  'daily_summary', 'tomorrow_workout', 'rest_day_reminders', 'incomplete_workout',
];
const PREF_TIME_FIELDS = ['daily_summary_time', 'quiet_hours_start', 'quiet_hours_end'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_PREFS = {
  enabled: 1, workout_reminders: 1, water_reminders: 1, water_interval_h: 2,
  nutrition_reminders: 1, daily_summary: 1, daily_summary_time: '23:30',
  tomorrow_workout: 1, rest_day_reminders: 0, incomplete_workout: 1,
  quiet_hours_start: '23:45', quiet_hours_end: '07:00',
};

/** COUNT() comes back as a bigint STRING on Postgres, and "0" is
 *  truthy -- an unread badge would render permanently. */
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export default function notificationRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  // Lazily creates a default row on first read -- a user who has never
  // opened Settings has no row yet, and that's fine; this is the ONE
  // place that gap is closed, rather than every caller re-deriving
  // defaults from thin air.
  const getOrCreatePrefs = async (userId, orgId) => {
    const existing = await db.q1('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
    if (existing) return existing;
    await db.run(
      `INSERT INTO notification_preferences
         (user_id, org_id, enabled, workout_reminders, water_reminders, water_interval_h,
          nutrition_reminders, daily_summary, daily_summary_time, tomorrow_workout,
          rest_day_reminders, incomplete_workout, quiet_hours_start, quiet_hours_end, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, orgId, DEFAULT_PREFS.enabled, DEFAULT_PREFS.workout_reminders, DEFAULT_PREFS.water_reminders,
       DEFAULT_PREFS.water_interval_h, DEFAULT_PREFS.nutrition_reminders, DEFAULT_PREFS.daily_summary,
       DEFAULT_PREFS.daily_summary_time, DEFAULT_PREFS.tomorrow_workout, DEFAULT_PREFS.rest_day_reminders,
       DEFAULT_PREFS.incomplete_workout, DEFAULT_PREFS.quiet_hours_start, DEFAULT_PREFS.quiet_hours_end, now()]);
    return db.q1('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
  };

  r.get('/preferences', async (req, res) => {
    const preferences = await getOrCreatePrefs(req.user.sub, req.user.org);
    res.json({ preferences });
  });

  r.patch('/preferences', async (req, res) => {
    // Ensures a row exists before UPDATE -- a PATCH before any GET (e.g. a
    // client who toggles "All notifications" off before this card has
    // ever fetched once) must still work, not silently no-op on zero
    // matched rows.
    await getOrCreatePrefs(req.user.sub, req.user.org);
    const body = req.body || {};
    const sets = [];
    const params = [];
    for (const key of PREF_BOOL_FIELDS) {
      if (body[key] === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(body[key] ? 1 : 0);
    }
    if (body.water_interval_h !== undefined) {
      const v = Number(body.water_interval_h);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'water_interval_h must be a positive number' });
      sets.push('water_interval_h = ?');
      params.push(v);
    }
    // What the browser answered when asked for notification permission.
    // NotificationPermissionPrompt and Settings have always sent it; it was
    // not on this list, so every save came back 400 and was dropped.
    if (body.browser_permission !== undefined) {
      if (!['default', 'granted', 'denied'].includes(body.browser_permission)) {
        return res.status(400).json({ error: 'browser_permission must be default, granted or denied' });
      }
      sets.push('browser_permission = ?');
      params.push(body.browser_permission);
    }
    if (body.prompted_at !== undefined) {
      if (Number.isNaN(Date.parse(body.prompted_at))) return res.status(400).json({ error: 'prompted_at must be a timestamp' });
      sets.push('prompted_at = ?');
      params.push(new Date(body.prompted_at).toISOString());
    }
    for (const key of PREF_TIME_FIELDS) {
      if (body[key] === undefined) continue;
      if (!TIME_RE.test(String(body[key]))) return res.status(400).json({ error: `${key} must be an "HH:MM" time` });
      sets.push(`${key} = ?`);
      params.push(String(body[key]));
    }
    if (!sets.length) return res.status(400).json({ error: 'No recognized preference fields in request body' });
    sets.push('updated_at = ?');
    params.push(now());
    params.push(req.user.sub);
    await db.run(`UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = ?`, params);
    const preferences = await db.q1('SELECT * FROM notification_preferences WHERE user_id = ?', [req.user.sub]);
    res.json({ preferences });
  });

  // ---- notification list (NotificationBell) ----
  r.get('/', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const [notifications, unreadRow] = await Promise.all([
      db.q('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [req.user.sub, limit]),
      db.q1('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', [req.user.sub]),
    ]);
    res.json({
      notifications: notifications.map((n) => ({ ...n, data: n.data_json ? JSON.parse(n.data_json) : null })),
      /* BOTH SPELLINGS, deliberately and temporarily.
         This route returned snake_case `unread_count` while the sibling
         /unread-count route returns camelCase `unreadCount` -- the two
         disagreed about the name of the same number, which is how the
         merge surfaced it (tests written against one spelling failed
         against the other). camelCase is the spelling the rest of this
         API uses and the one new code should read; unread_count stays so
         the existing NotificationBell keeps working rather than silently
         rendering a badge of 0 the moment this deploys. Remove it once
         that component reads the camelCase key. */
      unreadCount: int(unreadRow?.n),
      unread_count: int(unreadRow?.n),
    });
  });

  /* IDEMPOTENT ON PURPOSE -- this used to 404 on an id it could not find.
     "Mark as read" is an action a client fires optimistically and may
     retry: the row may already be read, or already gone, and in both
     cases the caller's intent is satisfied. Erroring gives them nothing
     to do about it.

     The UPDATE is still scoped by user_id, so this cannot touch another
     user's notification -- and because it no longer reads first, it also
     no longer distinguishes "not yours" from "does not exist", which is
     the right answer to give either way. */
  r.patch('/:id/read', async (req, res) => {
    await db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.sub]);
    res.json({ ok: true });
  });

  r.post('/read-all', async (req, res) => {
    await db.run('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0', [req.user.sub]);
    res.json({ ok: true });
  });

  /* ---- brought in from the notification-permissions branch ----
     Both are additive; neither existed on this side. unread-count is the
     cheap poll the bell uses instead of pulling the whole list, and
     generate is what the client calls to materialise smart
     notifications. */

  r.get('/unread-count', async (req, res) => {
    const row = await db.q1(
      'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read = 0',
      [req.user.sub]);
    res.json({ unreadCount: int(row?.cnt) });
  });

  // Never fails the request: a generator error must not stop the app
  // loading, so it is logged and an empty list returned.
  r.post('/generate', async (req, res) => {
    try {
      const notifications = await generateNotifications(db, req.user.sub, req.user.org);
      res.json({ ok: true, notifications });
    } catch (err) {
      console.error('[notifications] generate error:', err.message);
      res.json({ ok: true, notifications: [] });
    }
  });

  return r;
}
