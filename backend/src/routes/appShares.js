// ============================================================
// IN-APP SHARING — send a workout or a meal straight to someone.
//
//   GET  /api/app-shares/people?q=      who I can share with (services/sharing.js)
//   POST /api/app-shares             send to 1..20 people
//   GET  /api/app-shares/inbox          what was sent to me, still to answer
//   GET  /api/app-shares/:id           one of mine (from the bell's link)
//   POST /api/app-shares/:id/accept     add it: today / planner / days, or meal
//   POST /api/app-shares/:id/dismiss    no thanks
//
// The share is the same snapshot a link uses, so it can only carry what the
// sender actually has, and the recipient's copy is built from the snapshot
// on the server -- never from anything the recipient's app sends back.
//
// No db.tx() with an org here: a friend community spans gyms, and a row
// for the recipient carries THEIR org (see rls.sql's scope note).
// ============================================================
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, orgScope } from '../auth.js';
import { validate } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { track } from '../services/events.js';
import { notify } from '../services/enterprise/notifications.js';
import {
  workoutPayload, storeWorkoutSnapshot, loadWorkoutSnapshot, importWorkout,
  mealItems, storeMealSnapshot, loadMealSnapshot, saveMealItem,
  shareAudience, allowedRecipients, senderName,
} from '../services/sharing.js';

const perUser = (req) => req.user?.sub || 'anon';
const MAX_RECIPIENTS = 20;

export default function appShareRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);
  const sendLimit = rateLimit({ windowMs: 60_000, max: 12, keyFn: perUser });
  const actLimit = rateLimit({ windowMs: 60_000, max: 40, keyFn: perUser });

  const client = async (req, res) => {
    if (req.user.role !== 'CLIENT') { res.status(403).json({ error: 'Members only' }); return null; }
    const c = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!c) { res.status(404).json({ error: 'No client profile linked to this account' }); return null; }
    return c;
  };

  const canPlan = async (c) => {
    const s = await db.q1('SELECT workout_mode_default FROM gym_settings WHERE org_id = ?', [c.org_id]);
    return (s?.workout_mode_default || 'hybrid') !== 'prescribed';
  };

  /** One inbox row with what it carries, for the popup. */
  const view = async (row) => {
    const base = {
      id: row.id, kind: row.kind, title: row.title, message: row.message || null,
      from: row.sender_name || 'A member', status: row.status, outcome: row.outcome || null,
      created_at: row.created_at,
    };
    if (row.kind === 'workout') {
      const snap = await loadWorkoutSnapshot(db, row.snapshot_id);
      if (!snap) return { ...base, expired: true };
      const exs = snap.payload.exercises || [];
      return {
        ...base,
        workout: {
          name: snap.payload.name,
          exercises: exs.map((e) => ({ name: e.name, sets: e.sets, reps: e.reps, weight: e.weight, superset_group: e.superset_group || null })),
        },
      };
    }
    const snap = await loadMealSnapshot(db, row.snapshot_id);
    if (!snap) return { ...base, expired: true };
    return {
      ...base,
      meal: {
        items: snap.items.map((it) => ({
          type: it.type, name: it.name, unit: it.unit,
          calories: Math.round(it.calories || 0), protein: Math.round(it.protein || 0),
          carbs: Math.round(it.carbs || 0), fat: Math.round(it.fat || 0),
          components: (it.components || []).map((c) => c.name).slice(0, 8),
        })),
      },
    };
  };

  /** The bell entry for this share is answered once the share is. */
  const markNotificationRead = async (userId, shareId) => {
    try {
      await db.run(
        `UPDATE notifications SET read = 1 WHERE user_id = ? AND type = 'share_received' AND data_json LIKE ?`,
        [userId, `%"share_id":"${shareId}"%`]);
    } catch { /* best effort */ }
  };

  // ---- who can I share with ----
  r.get('/people', async (req, res) => {
    const c = await client(req, res); if (!c) return;
    res.json(await shareAudience(db, c, { q: req.query.q, limit: 40 }));
  });

  // ---- send ----
  r.post('/', sendLimit, validate(z.object({
    kind: z.enum(['workout', 'meal']),
    workout_id: z.string().min(1).max(64).optional(),
    exercise_ids: z.array(z.string().min(1).max(64)).max(50).optional(),
    meal_ids: z.array(z.string().min(1).max(64)).max(30).optional(),
    food_ids: z.array(z.string().min(1).max(64)).max(30).optional(),
    recipients: z.array(z.string().min(1).max(64)).min(1).max(MAX_RECIPIENTS),
    message: z.string().max(200).optional(),
  })), async (req, res) => {
    const c = await client(req, res); if (!c) return;
    const { kind, recipients, message } = req.body;

    const allowed = await allowedRecipients(db, c, recipients);
    const to = [...new Set(recipients)].filter((x) => allowed.has(x));
    if (!to.length) return res.status(422).json({ error: 'Pick someone from your gym, friends or communities' });

    let snapshotId; let title;
    if (kind === 'workout') {
      if (!req.body.workout_id) return res.status(400).json({ error: 'workout_id is required' });
      const built = await workoutPayload(db, c, { workoutId: req.body.workout_id, exerciseIds: req.body.exercise_ids });
      if (built.error) return res.status(built.status).json({ error: built.error });
      snapshotId = (await storeWorkoutSnapshot(db, c, built.payload)).id;
      title = built.payload.name;
    } else {
      const items = await mealItems(db, c, { mealIds: req.body.meal_ids || [], foodIds: req.body.food_ids || [] });
      if (!items.length) return res.status(400).json({ error: 'Select at least one saved meal or food to share' });
      snapshotId = (await storeMealSnapshot(db, c, items)).id;
      title = items.length === 1 ? items[0].name : `${items[0].name} +${items.length - 1} more`;
    }

    const from = (await senderName(db, c)) || 'A member';
    const recips = await db.q(
      `SELECT c.id, c.org_id, c.user_id FROM clients c WHERE c.id IN (${to.map(() => '?').join(',')})`, to);
    const note = message ? String(message).trim().slice(0, 200) : null;
    const sent = [];
    for (const rc of recips) {
      const shareId = id('ash');
      await db.run(
        `INSERT INTO app_shares (id, kind, snapshot_id, title, message, sender_client_id, sender_name, sender_org_id,
                                 recipient_client_id, recipient_org_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`,
        [shareId, kind, snapshotId, String(title).slice(0, 120), note, c.id, from, c.org_id, rc.id, rc.org_id, now()]);
      await notify(db, {
        orgId: rc.org_id, userId: rc.user_id, type: 'share_received',
        title: `${from} shared ${kind === 'workout' ? 'a workout' : 'a meal'} with you`,
        body: note ? `${title} — “${note}”` : title,
        data: { share_id: shareId, kind, link: `/app/client?share=${shareId}` },
      });
      sent.push(shareId);
    }
    track(db, 'app_share_sent', req.user.org, req.user.sub, { client_id: c.id, kind, recipients: sent.length });
    res.status(201).json({ ok: true, sent: sent.length, ids: sent });
  });

  // ---- my inbox ----
  r.get('/inbox', async (req, res) => {
    const c = await client(req, res); if (!c) return;
    const rows = await db.q(
      `SELECT * FROM app_shares WHERE recipient_client_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 20`, [c.id]);
    const items = (await Promise.all(rows.map(view))).filter((x) => !x.expired);
    res.json({ shares: items, can_plan: await canPlan(c) });
  });

  r.get('/:id', async (req, res) => {
    const c = await client(req, res); if (!c) return;
    const row = await db.q1('SELECT * FROM app_shares WHERE id = ? AND recipient_client_id = ?', [req.params.id, c.id]);
    if (!row) return res.status(404).json({ error: 'That share was not found' });
    res.json({ share: await view(row), can_plan: await canPlan(c) });
  });

  // ---- answer one ----
  r.post('/:id/accept', actLimit, validate(z.object({
    action: z.enum(['today', 'planner', 'days', 'meal']),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })), async (req, res) => {
    const c = await client(req, res); if (!c) return;
    const row = await db.q1('SELECT * FROM app_shares WHERE id = ? AND recipient_client_id = ?', [req.params.id, c.id]);
    if (!row) return res.status(404).json({ error: 'That share was not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: row.status === 'accepted' ? 'Already added' : 'You dismissed this one' });
    const { action, days } = req.body;

    let result;
    try {
      if (row.kind === 'workout') {
        if (action === 'meal') return res.status(400).json({ error: 'This is a workout' });
        if (action !== 'today' && !(await canPlan(c))) {
          return res.status(403).json({ error: 'Your gym follows your coach’s plan, so saving workouts is turned off' });
        }
        if (action === 'days' && !(days || []).length) return res.status(400).json({ error: 'Pick at least one day' });
        const snap = await loadWorkoutSnapshot(db, row.snapshot_id);
        if (!snap) return res.status(410).json({ error: 'This share has expired' });
        result = await importWorkout(db, c, snap.payload, { destination: action, days, tz: req.tz });
      } else {
        if (action !== 'meal') return res.status(400).json({ error: 'This is a meal' });
        const snap = await loadMealSnapshot(db, row.snapshot_id);
        if (!snap) return res.status(410).json({ error: 'This share has expired' });
        const saved = [];
        for (const item of snap.items) saved.push(await saveMealItem(db, c, item));
        result = { destination: 'meal', saved };
      }
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.error });
      return res.status(500).json({ error: 'Could not add it. Please try again.' });
    }

    await db.run(`UPDATE app_shares SET status = 'accepted', outcome = ?, acted_at = ? WHERE id = ? AND status = 'pending'`,
      [action, now(), row.id]);
    await markNotificationRead(req.user.sub, row.id);
    track(db, 'app_share_accepted', req.user.org, req.user.sub, { client_id: c.id, kind: row.kind, action });
    res.json({ ok: true, ...result });
  });

  r.post('/:id/dismiss', actLimit, async (req, res) => {
    const c = await client(req, res); if (!c) return;
    const out = await db.run(
      `UPDATE app_shares SET status = 'dismissed', acted_at = ? WHERE id = ? AND recipient_client_id = ? AND status = 'pending'`,
      [now(), req.params.id, c.id]);
    if (!out.changes) {
      const row = await db.q1('SELECT status FROM app_shares WHERE id = ? AND recipient_client_id = ?', [req.params.id, c.id]);
      if (!row) return res.status(404).json({ error: 'That share was not found' });
    }
    await markNotificationRead(req.user.sub, req.params.id);
    res.json({ ok: true });
  });

  return r;
}
