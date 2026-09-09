// ============================================================
// CLIENT NOTIFICATIONS — in-app notification center
//   * list / mark-read / mark-all-read
//   * unread count (polled by the frontend bell)
//   * notification preferences (per-user toggle + frequency)
//   * generate — on-demand smart notification creation from existing data
// ============================================================
import { Router } from 'express';
import { requireAuth, orgScope } from '../auth.js';
import { id, now } from '../ids.js';
import { dayKey, getOrgTz } from '../utils/time.js';
import { generateNotifications } from '../services/notificationGenerator.js';

export default function notificationRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  // ── GET /api/notifications — list recent notifications ──
  r.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const rows = await db.q(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.user.sub, limit, offset]
    );
    const unread = await db.q1(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read = 0`,
      [req.user.sub]
    );
    res.json({ notifications: rows, unreadCount: unread?.cnt || 0 });
  });

  // ── GET /api/notifications/unread-count — lightweight poll for the bell ──
  r.get('/unread-count', async (req, res) => {
    const row = await db.q1(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read = 0`,
      [req.user.sub]
    );
    res.json({ unreadCount: row?.cnt || 0 });
  });

  // ── PATCH /api/notifications/:id/read — mark one as read ──
  r.patch('/:id/read', async (req, res) => {
    await db.run(
      `UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.sub]
    );
    res.json({ ok: true });
  });

  // ── POST /api/notifications/read-all — mark all as read ──
  r.post('/read-all', async (req, res) => {
    await db.run(
      `UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`,
      [req.user.sub]
    );
    res.json({ ok: true });
  });

  // ── GET /api/notifications/preferences — get user's notification prefs ──
  r.get('/preferences', async (req, res) => {
    let prefs = await db.q1(
      `SELECT * FROM notification_preferences WHERE user_id = ?`,
      [req.user.sub]
    );
    // Auto-create defaults if none exist yet
    if (!prefs) {
      const nowTs = now();
      await db.run(
        `INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?)`,
        [req.user.sub, nowTs]
      );
      prefs = await db.q1(
        `SELECT * FROM notification_preferences WHERE user_id = ?`,
        [req.user.sub]
      );
    }
    res.json({ preferences: prefs });
  });

  // ── PATCH /api/notifications/preferences — update user's notification prefs ──
  r.patch('/preferences', async (req, res) => {
    const allowed = [
      'enabled', 'workout_reminders', 'water_reminders', 'water_interval_h',
      'nutrition_reminders', 'daily_summary', 'daily_summary_time',
      'tomorrow_workout', 'rest_day_reminders', 'incomplete_workout',
      'quiet_hours_start', 'quiet_hours_end',
      'browser_permission', 'prompted_at',
    ];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key]);
      }
    }
    if (sets.length === 0) return res.json({ ok: true });

    // Ensure row exists
    const existing = await db.q1(
      `SELECT user_id FROM notification_preferences WHERE user_id = ?`,
      [req.user.sub]
    );
    if (!existing) {
      await db.run(
        `INSERT INTO notification_preferences (user_id, updated_at) VALUES (?, ?)`,
        [req.user.sub, now()]
      );
    }

    sets.push('updated_at = ?');
    vals.push(now());
    vals.push(req.user.sub);
    await db.run(
      `UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = ?`,
      vals
    );
    const prefs = await db.q1(
      `SELECT * FROM notification_preferences WHERE user_id = ?`,
      [req.user.sub]
    );
    res.json({ preferences: prefs });
  });

  // ── POST /api/notifications/generate — trigger smart notification generation ──
  // Called by the frontend on app load and periodically by client-side timers.
  // Returns any newly created notifications so the UI can show them immediately.
  r.post('/generate', async (req, res) => {
    try {
      const newNotifs = await generateNotifications(db, req.user.sub, req.user.org);
      res.json({ ok: true, notifications: newNotifs });
    } catch (err) {
      console.error('[notifications] generate error:', err.message);
      res.json({ ok: true, notifications: [] });
    }
  });

  return r;
}
