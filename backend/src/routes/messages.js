import { Router } from 'express';
import { requireAuth, orgScope } from '../auth.js';
import { validate, schemas } from '../validate.js';
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
    const rows = await db.q(
      `SELECT m.*, fu.name AS from_name, tu.name AS to_name
         FROM messages m
         JOIN users fu ON fu.id = m.from_user
         LEFT JOIN users tu ON tu.id = m.to_user
        WHERE m.client_id = ? ORDER BY m.created_at ASC LIMIT 200`, [client_id]);
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
    await db.run(
      `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'inapp', 0, ?)`,
      [msgId, client.org_id, fromUser, toUser, client_id, type, body, now()]);
    // Mirror to the recipient's notification center.
    if (toUser) {
      await db.run(
        `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, read, created_at)
         VALUES (?, ?, ?, ?, ?, 'message', ?, ?, 0, ?)`,
        [id('ntf'), client.org_id, toUser, client_id, type, body.slice(0, 80), now()]);
    }
    res.status(201).json({ id: msgId });
  });

  return r;
}
