import { Router } from 'express';
import { requireAuth, requireRole, orgScope } from '../auth.js';
import { computeAdherence } from '../services/adherence.js';
import { evaluateClient } from '../services/atRisk.js';
import { daysAgoIso, todayKey, lastNDays, round1 } from '../utils/time.js';

export default function dashboardRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);

  // ---- /api/dashboard/overview ----
  r.get('/overview', async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);

    let onTrack = 0, atRisk = 0, needs = 0, inactive = 0;
    const adherenceScores = [];
    let workoutCompletion = [], nutritionAdherence = [], weightChanges = [];
    let evaluated = [];

    for (const c of clients) {
      const ev = await evaluateClient(db, c);
      evaluated.push(ev);
      if (ev.status === 'ON_TRACK') onTrack++;
      else if (ev.status === 'AT_RISK') atRisk++;
      else if (ev.status === 'NEEDS_ATTENTION') needs++;
      else inactive++;
      adherenceScores.push(ev.adherence.score);
      if (ev.adherence.components.workout !== null) workoutCompletion.push(ev.adherence.components.workout);
      if (ev.adherence.components.nutrition !== null) nutritionAdherence.push(ev.adherence.components.nutrition);
      // weight change over last 7 days
      const w = await db.q(
        'SELECT date, weight FROM weight_logs WHERE client_id = ? AND date >= ? ORDER BY date', [c.id, daysAgoIso(7)]);
      if (w.length >= 2) {
        weightChanges.push(((w[w.length - 1].weight - w[0].weight) / w[0].weight) * 100);
      }
    }

    const avg = (arr) => arr.length ? round1(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
    const newClients = clients.filter(c => c.created_at >= daysAgoIso(30)).length;

    // business numbers for owners
    const subs = await db.q(
      `SELECT * FROM subscriptions WHERE org_id = ? AND status = 'active'`, [orgId]);
    const renewalsDue = subs.filter(s => s.renewal_date && s.renewal_date <= daysAgoIso(-30)).length;
    const monthStart = todayKey().slice(0, 7) + '-01';
    const payments = await db.q(
      `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE org_id = ? AND paid_at >= ?`,
      [orgId, monthStart]);

    res.json({
      kpis: {
        activeClients: clients.filter(c => c.status !== 'INACTIVE').length || (clients.length - inactive),
        newClients,
        onTrack, atRisk, needsAttention: needs, inactive,
        avgAdherence: avg(adherenceScores),
        avgWeightChange: weightChanges.length ? round1(avg(weightChanges)) : 0,
        workoutCompletion: avg(workoutCompletion),
        nutritionAdherence: avg(nutritionAdherence),
        renewalsDue, monthlyRevenue: Number(payments[0]?.total || 0)
      },
      clients: evaluated.map((e, i) => ({
        clientId: clients[i].id,
        status: e.status,
        adherence: e.adherence.score,
        rules: e.rules
      }))
    });
  });

  // ---- /api/dashboard/attention — clients needing the trainer's focus ----
  r.get('/attention', async (req, res) => {
    const orgId = req.orgId;
    const clients = await db.q('SELECT * FROM clients WHERE org_id = ?', [orgId]);
    const out = [];
    for (const c of clients) {
      const ev = await evaluateClient(db, c);
      if (ev.status === 'ON_TRACK' || ev.status === 'INACTIVE') continue;
      const user = await db.q1('SELECT name FROM users WHERE id = ?', [c.user_id]);
      out.push({
        clientId: c.id, name: user?.name || 'Client',
        status: ev.status, adherence: ev.adherence.score,
        goal: c.goal, currentWeight: c.current_weight, targetWeight: c.target_weight,
        rules: ev.rules
      });
    }
    out.sort((a, b) => b.rules.length - a.rules.length || a.adherence - b.adherence);
    res.json({ clients: out });
  });

  // ---- /api/dashboard/adherence-trend — avg adherence per day, 14 days ----
  r.get('/adherence-trend', async (req, res) => {
    const orgId = req.orgId;
    const days = lastNDays(14);
    const records = await db.q(
      `SELECT ar.date, ar.score FROM adherence_records ar
        JOIN clients c ON c.id = ar.client_id
       WHERE c.org_id = ? AND ar.date >= ?`, [orgId, days[0]]);
    const perDay = days.map(d => {
      const rows = records.filter(r => r.date === d);
      return { date: d, avg: rows.length ? round1(rows.reduce((s, x) => s + x.score, 0) / rows.length) : null };
    });
    res.json({ trend: perDay });
  });

  return r;
}
