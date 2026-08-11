import { Router } from 'express';
import { requireAuth, requireRole, orgScope, resolveClient } from '../auth.js';
import { id, now } from '../ids.js';
import { generateWeeklyReport } from '../services/weeklyReport.js';
import { track } from '../services/events.js';

export default function reportRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);

  r.get('/clients/:id/weekly-report', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    res.json({ report: await generateWeeklyReport(db, client.id) });
  });

  // "Send" = persist a client notification + in-app message (WhatsApp stays a
  // planned integration — see messages table channel column).
  r.post('/clients/:id/weekly-report/send', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const report = await generateWeeklyReport(db, client.id);
    const title = `${report.clientName} — weekly progress report`;
    await db.run(
      `INSERT INTO notifications (id, org_id, user_id, client_id, type, title, body, read, created_at)
       VALUES (?, ?, ?, ?, 'weekly_report', ?, ?, 0, ?)`,
      [id('ntf'), client.org_id, client.user_id, client.id, title, report.coachSummary, now()]);
    await db.run(
      `INSERT INTO messages (id, org_id, from_user, to_user, client_id, type, body, channel, read, created_at)
       VALUES (?, ?, ?, ?, ?, 'message', ?, 'inapp', 0, ?)`,
      [id('msg'), client.org_id, req.user.sub, client.user_id, client.id,
       `Your weekly report is ready — ${report.coachSummary}`, now()]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'report_generated', data: { clientId: client.id } });
    res.status(201).json({ ok: true, reportId: id('rpt') });
  });

  return r;
}
