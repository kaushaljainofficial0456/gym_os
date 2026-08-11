import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { evaluateOrg } from '../services/atRisk.js';

export default function alertRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);

  r.get('/', async (req, res) => {
    // Refresh alerts against current client data before listing (idempotent).
    try {
      await evaluateOrg(db, req.orgId, req.user.sub);
    } catch (e) {
      // never fail the list because evaluation hit an edge case
      console.error('alert evaluation failed', e?.message);
    }
    const { status } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    let rows;
    if (status) {
      rows = await db.q(
        `SELECT a.*, u.name AS client_name FROM alerts a
           JOIN clients c ON c.id = a.client_id
           JOIN users u ON u.id = c.user_id
          WHERE a.org_id = ? AND a.status = ? ORDER BY a.created_at DESC LIMIT ?`,
        [req.orgId, status, limit]);
    } else {
      rows = await db.q(
        `SELECT a.*, u.name AS client_name FROM alerts a
           JOIN clients c ON c.id = a.client_id
           JOIN users u ON u.id = c.user_id
          WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`,
        [req.orgId, limit]);
    }
    res.json({ alerts: rows });
  });

  r.post('/:id/action', validate(schemas.alertAction), async (req, res) => {
    const alert = await db.q1('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'No access to this alert' });
    }
    const status = req.body.action === 'follow_up' ? 'followed_up' : req.body.action;
    await db.run(
      `UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?`,
      [status, new Date().toISOString(), alert.id]);
    res.json({ ok: true, status });
  });

  return r;
}
