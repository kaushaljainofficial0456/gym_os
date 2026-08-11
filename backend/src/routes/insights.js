import { Router } from 'express';
import { requireAuth, requireRole, orgScope, resolveClient } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { id, now } from '../ids.js';
import { analyzeClientProgress } from '../services/aiCoach.js';
import { track } from '../services/events.js';

export default function insightRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);

  r.get('/clients/:id', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const insights = await db.q(
      'SELECT * FROM coach_insights WHERE client_id = ? ORDER BY created_at DESC', [client.id]);
    res.json({ insights });
  });

  // Run the AI analysis; persist as a pending insight the trainer can act on.
  r.post('/clients/:id/analyze', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const result = await analyzeClientProgress(db, client.id);
    if (!result) return res.status(404).json({ error: 'Client not found' });
    const insightId = id('ins');
    await db.run(
      `INSERT INTO coach_insights (id, org_id, client_id, trainer_id, type, summary, recommendation, data_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [insightId, client.org_id, client.id, req.user.sub, result.type, result.summary,
       result.recommendation, JSON.stringify(result.data), now()]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'ai_insight_generated', data: { clientId: client.id, insightType: result.type } });
    res.status(201).json({ insight: { id: insightId, ...result, status: 'pending' } });
  });

  r.post('/:id/action', validate(schemas.insightAction), async (req, res) => {
    const ins = await db.q1('SELECT * FROM coach_insights WHERE id = ?', [req.params.id]);
    if (!ins) return res.status(404).json({ error: 'Insight not found' });
    if (ins.org_id !== req.orgId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'No access to this insight' });
    }
    const b = req.body;
    if (b.action === 'accept') {
      await db.run(`UPDATE coach_insights SET status = 'accepted' WHERE id = ?`, [ins.id]);
    } else if (b.action === 'modify') {
      await db.run(
        `UPDATE coach_insights SET status = 'modified', summary = ?, recommendation = ? WHERE id = ?`,
        [b.summary || ins.summary, b.recommendation || ins.recommendation, ins.id]);
    } else if (b.action === 'dismiss') {
      await db.run(`UPDATE coach_insights SET status = 'dismissed' WHERE id = ?`, [ins.id]);
    }
    await track(db, { orgId: ins.org_id, userId: req.user.sub, type: 'ai_insight_actioned', data: { insightId: ins.id, action: b.action } });
    res.json({ ok: true, status: b.action === 'modify' ? 'modified' : b.action });
  });

  return r;
}
