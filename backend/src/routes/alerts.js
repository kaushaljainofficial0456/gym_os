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
    // Alerts are gym-wide on purpose (see alerts.test.js), but a trainer can
    // only OPEN their own clients, so each row says whose client it is: the
    // page links to who it can open and names the trainer for the rest.
    const conds = ['a.org_id = ?'];
    const params = [req.orgId];
    // 'dismiss' is what this route used to store (the raw action word),
    // so the Dismissed tab, which asks for 'dismissed', never showed a
    // single dismissed alert. Writes now store 'dismissed'; reads accept
    // both so older rows are not lost.
    if (status === 'dismissed') conds.push("a.status IN ('dismissed', 'dismiss')");
    else if (status) { conds.push('a.status = ?'); params.push(status); }
    const rows = await db.q(
      `SELECT a.*, u.name AS client_name, c.trainer_id AS client_trainer_id, tu.name AS client_trainer_name
         FROM alerts a
         JOIN clients c ON c.id = a.client_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users tu ON tu.id = c.trainer_id
        WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`,
      [...params, limit]);
    // Totals by status for the whole gym, independent of the tab being
    // viewed: the page's "N open" badge used to count only the rows of the
    // current tab, so it read "0 open" on every tab but Open and All.
    const byStatus = await db.q('SELECT status, COUNT(*) AS n FROM alerts WHERE org_id = ? GROUP BY status', [req.orgId]);
    const counts = { open: 0, read: 0, followed_up: 0, dismissed: 0 };
    for (const r of byStatus) {
      const k = r.status === 'dismiss' ? 'dismissed' : r.status;
      if (k in counts) counts[k] += Number(r.n);
    }
    res.json({ alerts: rows.map((a) => (a.status === 'dismiss' ? { ...a, status: 'dismissed' } : a)), counts });
  });

  r.post('/:id/action', validate(schemas.alertAction), async (req, res) => {
    const alert = await db.q1('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'No access to this alert' });
    }
    const status = { read: 'read', follow_up: 'followed_up', dismiss: 'dismissed' }[req.body.action];
    await db.run(
      `UPDATE alerts SET status = ?, resolved_at = ? WHERE id = ?`,
      [status, new Date().toISOString(), alert.id]);
    res.json({ ok: true, status });
  });

  return r;
}
