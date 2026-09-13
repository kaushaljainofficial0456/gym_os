import { Router } from 'express';
import { requireAuth, orgScope } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { z } from 'zod';
import { id, now } from '../ids.js';

export default function messageRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  // Thread between the requesting user and a client (trainer side) or trainer (client side).
  r.get('/', async (req, res) => {
    const { client_id } = req.query;
    if (!client_id) return res.status(422).json({ error: 'client_id required' });
    const client = await db.q1('SELECT * FROM clients WHERE id = ?', [client_id]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const userIsTrainer = req.user.role !== 'CLIENT';
    if (userIsTrainer) {
      if (client.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'No access' });
      }
      if (req.user.role === 'TRAINER' && client.trainer_id !== req.user.sub) {
        return res.status(403).json({ error: 'Not your client' });
      }
    } else {
      if (client.user_id !== req.user.sub) return res.status(403).json({ error: 'No access' });
    }
    // Most-recent-200, re-ordered oldest-first for display -- ORDER BY ...
    // ASC LIMIT 200 alone always returns the SAME oldest 200 rows no matter
    // how many more have been sent since, so any thread that outlives 200
    // total messages would silently freeze: every message after the 200th
    // ever sent becomes permanently invisible to both sides.
    const rows = await db.q(
      `SELECT * FROM (
         SELECT m.*, fu.name AS from_name, tu.name AS to_name
           FROM messages m
           JOIN users fu ON fu.id = m.from_user
           LEFT JOIN users tu ON tu.id = m.to_user
          WHERE m.client_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 200
       ) recent ORDER BY recent.created_at ASC, recent.id ASC`, [client_id]);
    res.json({ messages: rows });
  });

  r.post('/', validate(schemas.message), async (req, res) => {
    const { client_id, type, body } = req.body;
    const client = await db.q1('SELECT * FROM clients WHERE id = ?', [client_id]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let fromUser, toUser;
    if (req.user.role === 'CLIENT') {
      if (client.user_id !== req.user.sub) return res.status(403).json({ error: 'No access' });
      fromUser = req.user.sub;
      toUser = client.trainer_id || null;
    } else {
      if (client.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'No access' });
      if (req.user.role === 'TRAINER' && client.trainer_id !== req.user.sub) return res.status(403).json({ error: 'Not your client' });
      fromUser = req.user.sub;
      toUser = client.user_id;
    }

    const msgId = id('msg');
    try {
      await db.run(
        `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inapp', 0, ?)`,
        [msgId, client.org_id, fromUser, toUser, client_id, type, body, now()]);
    } catch (msgErr) {
      console.error('[messages] INSERT failed:', msgErr.message, 'sql params:', [msgId, client.org_id, fromUser, toUser, client_id, type, body, now()].length);
      throw msgErr;
    }
    // Mirror to the recipient's notification center (best-effort — must never
    // break message delivery if the notifications table schema differs).
    if (toUser) {
      try {
        await db.run(
          `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, created_at)
           VALUES (?, ?, ?, ?, ?, 'message', ?, ?)`,
          [id('ntf'), client.org_id, toUser, client_id, type, body.slice(0, 80), now()]);
      } catch (notifErr) {
        console.error('[messages] notification mirror failed:', notifErr.message);
      }
    }
    res.status(201).json({ id: msgId });
  });

  /* ---- unread ----
   *
   * `messages.read` has been written as 0 on every insert since the table
   * was created and read by nothing, updated by nothing. So the column
   * that exists to answer "has anyone replied to me?" could only ever say
   * no, and the workspace had no unread count, no badge, and no way to
   * tell a new message from one you answered last week.
   *
   * Unread is defined from the RECIPIENT's side: a message counts when it
   * was addressed to you and you have not opened that thread since. Your
   * own outgoing messages are never unread to you, which sounds obvious
   * and is exactly what a naive `WHERE read = 0` would get wrong.
   */
  r.get('/unread', async (req, res) => {
    const rows = await db.q(
      `SELECT client_id, COUNT(*) AS n
         FROM messages
        WHERE to_user = ? AND read = 0
        GROUP BY client_id`, [req.user.sub]);
    const byClient = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.n) || 0;
      byClient[row.client_id] = n;
      total += n;
    }
    res.json({ total, byClient });
  });

  /* Opening a thread is the read receipt. Scoped to messages addressed to
   * the caller, so reading a thread never marks the OTHER side's messages
   * read on their behalf -- which would quietly clear their badge and
   * lose them a reply. */
  r.post('/read', validate(z.object({ client_id: z.string().min(1).max(60) })), async (req, res) => {
    const client = await db.q1('SELECT * FROM clients WHERE id = ?', [req.body.client_id]);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Same access rules as reading the thread itself -- otherwise this
    // becomes an oracle for which client ids exist in other gyms.
    if (req.user.role === 'CLIENT') {
      if (client.user_id !== req.user.sub) return res.status(403).json({ error: 'No access' });
    } else {
      if (client.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'No access' });
      }
      if (req.user.role === 'TRAINER' && client.trainer_id !== req.user.sub) {
        return res.status(403).json({ error: 'Not your client' });
      }
    }

    const r1 = await db.run(
      'UPDATE messages SET read = 1 WHERE client_id = ? AND to_user = ? AND read = 0',
      [req.body.client_id, req.user.sub]);
    res.json({ ok: true, marked: r1.changes || 0 });
  });

  return r;
}
