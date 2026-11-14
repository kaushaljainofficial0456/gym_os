// ============================================================
// USAGE REPORT -- for the founder: what each calling mode, campaign and gym
// used in a billing period, what it earned and what it cost.
//
// Money and minutes come ONLY from followup_ledger 'usage' rows, which are
// unique per job (ux_followup_ledger_job_reason): a provider retrying its
// webhook can never be counted twice here. Attempts and connections come
// from followup_jobs; call backs from followup_callbacks. A period is a
// calendar month in UTC ('YYYY-MM').
//
//   mode         unit prefix   what it is
//   prerecorded  voice:*       one-way call: recording / read-out message
//   interactive  agent:*       two-way AI conversation (speech recognition,
//                              language model and speech are one provider
//                              minute price; the provider's own breakdown is
//                              kept per conversation in cost_json when sent)
//   sms, whatsapp
// ============================================================

const MODE_OF_UNIT = (unit) => {
  const p = String(unit || '').split(':')[0];
  return p === 'voice' ? 'prerecorded' : p === 'agent' ? 'interactive' : p;
};
const MODE_OF_CHANNEL = { call: 'prerecorded', agent: 'interactive', sms: 'sms', whatsapp: 'whatsapp' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function periodBounds(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  const now = new Date();
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) : now.getUTCMonth() + 1;
  const from = new Date(Date.UTC(y, mo - 1, 1));
  const to = new Date(Date.UTC(y, mo, 1));
  return { period: `${y}-${String(mo).padStart(2, '0')}`, from: from.toISOString(), to: to.toISOString() };
}

const blank = () => ({ attempts: 0, connected: 0, units: 0, revenue: 0, cost: 0 });

/** The report for one gym (orgId) or the whole platform (orgId null). */
export async function usageReport(db, { orgId = null, period = null } = {}) {
  const { period: p, from, to } = periodBounds(period);
  const scope = orgId ? ' AND l.org_id = ?' : '';
  const jscope = orgId ? ' AND j.org_id = ?' : '';
  const args = (...a) => (orgId ? [...a, orgId] : a);

  const ledger = await db.q(
    `SELECT l.org_id, l.unit, l.rule_id, SUM(-l.delta) AS units, SUM(l.charge_inr) AS revenue, SUM(COALESCE(l.cost_estimate, 0)) AS cost, COUNT(*) AS n
       FROM followup_ledger l WHERE l.reason = 'usage' AND l.created_at >= ? AND l.created_at < ?${scope}
      GROUP BY l.org_id, l.unit, l.rule_id`, args(from, to));
  const jobs = await db.q(
    `SELECT j.org_id, j.rule_id, j.channel, COUNT(*) AS attempts,
            SUM(CASE WHEN j.status IN ('completed','delivered','read') THEN 1 ELSE 0 END) AS connected,
            SUM(CASE WHEN j.callback_id IS NOT NULL THEN 1 ELSE 0 END) AS callback_attempts
       FROM followup_jobs j WHERE j.is_test = 0 AND j.created_at >= ? AND j.created_at < ?${jscope}
      GROUP BY j.org_id, j.rule_id, j.channel`, args(from, to));

  const byMode = { prerecorded: blank(), interactive: blank(), sms: blank(), whatsapp: blank() };
  const byGym = new Map();
  const byCampaign = new Map();
  const gymRow = (id) => { if (!byGym.has(id)) byGym.set(id, { org_id: id, modes: { prerecorded: blank(), interactive: blank(), sms: blank(), whatsapp: blank() } }); return byGym.get(id); };
  const campRow = (orgIdOf, ruleId) => {
    const k = `${orgIdOf}:${ruleId || '-'}`;
    if (!byCampaign.has(k)) byCampaign.set(k, { org_id: orgIdOf, rule_id: ruleId || null, modes: new Set(), ...blank() });
    return byCampaign.get(k);
  };
  for (const row of ledger) {
    const mode = MODE_OF_UNIT(row.unit);
    if (!byMode[mode]) continue;
    for (const target of [byMode[mode], gymRow(row.org_id).modes[mode], campRow(row.org_id, row.rule_id)]) {
      target.units += Number(row.units) || 0;
      target.revenue += Number(row.revenue) || 0;
      target.cost += Number(row.cost) || 0;
    }
    campRow(row.org_id, row.rule_id).modes.add(mode);
  }
  let callbackAttempts = 0;
  for (const row of jobs) {
    const mode = MODE_OF_CHANNEL[row.channel];
    if (!byMode[mode]) continue;
    for (const target of [byMode[mode], gymRow(row.org_id).modes[mode], campRow(row.org_id, row.rule_id)]) {
      target.attempts += Number(row.attempts) || 0;
      target.connected += Number(row.connected) || 0;
    }
    campRow(row.org_id, row.rule_id).modes.add(mode);
    callbackAttempts += Number(row.callback_attempts) || 0;
  }

  const conv = await db.q(
    `SELECT c.org_id, COUNT(*) AS n, SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN c.callback_id IS NOT NULL THEN 1 ELSE 0 END) AS booked, SUM(c.human_escalation) AS escalated,
            SUM(COALESCE(c.duration_secs, 0)) AS secs
       FROM followup_conversations c WHERE c.simulated = 0 AND c.created_at >= ? AND c.created_at < ?${orgId ? ' AND c.org_id = ?' : ''} GROUP BY c.org_id`, args(from, to));
  const cb = await db.q(
    `SELECT c.mode, c.status, COUNT(*) AS n FROM followup_callbacks c WHERE c.created_at >= ? AND c.created_at < ?${orgId ? ' AND c.org_id = ?' : ''} GROUP BY c.mode, c.status`, args(from, to));
  const callbacks = { scheduled: 0, executed: 0, failed: 0, cancelled: 0, expired: 0, waiting: 0, staff_open: 0, staff_done: 0, attempts: callbackAttempts };
  for (const row of cb) {
    const k = Number(row.n) || 0;
    if (row.mode === 'human') {
      if (['new', 'assigned', 'in_progress'].includes(row.status)) callbacks.staff_open += k; else callbacks.staff_done += k;
      continue;
    }
    callbacks.scheduled += k;                                            // every automated call back booked in the period
    if (row.status === 'completed') callbacks.executed += k;
    else if (row.status === 'failed') callbacks.failed += k;
    else if (row.status === 'cancelled') callbacks.cancelled += k;
    else if (row.status === 'expired') callbacks.expired += k;
    else callbacks.waiting += k;                                          // scheduled / processing
  }

  const names = new Map((await db.q(`SELECT id, name FROM organizations WHERE id IN (${[...byGym.keys()].map(() => '?').join(',') || "''"})`, [...byGym.keys()])).map((o) => [o.id, o.name]));
  const ruleIds = [...byCampaign.values()].map((c) => c.rule_id).filter(Boolean);
  const rules = new Map((ruleIds.length ? await db.q(`SELECT id, name, kind FROM followup_rules WHERE id IN (${ruleIds.map(() => '?').join(',')})`, ruleIds) : []).map((x) => [x.id, x]));
  const finish = (m) => ({ ...m, units: r2(m.units), revenue: r2(m.revenue), cost: r2(m.cost), margin: r2(m.revenue - m.cost) });
  const interactiveConv = conv.reduce((s, c) => s + (Number(c.completed) || 0), 0);
  const interactive = finish(byMode.interactive);
  return {
    period: p, from, to,
    modes: {
      prerecorded: finish(byMode.prerecorded),
      interactive: { ...interactive, conversations: conv.reduce((s, c) => s + (Number(c.n) || 0), 0), completed: interactiveConv, cost_per_conversation: interactiveConv ? r2(interactive.cost / interactiveConv) : null },
      sms: finish(byMode.sms), whatsapp: finish(byMode.whatsapp),
    },
    callbacks,
    gyms: [...byGym.values()].map((g) => ({ org_id: g.org_id, name: names.get(g.org_id) || g.org_id, modes: Object.fromEntries(Object.entries(g.modes).map(([k, v]) => [k, finish(v)])) }))
      .sort((a, b) => Object.values(b.modes).reduce((s, m) => s + m.revenue, 0) - Object.values(a.modes).reduce((s, m) => s + m.revenue, 0)),
    campaigns: [...byCampaign.values()].map((c) => ({
      org_id: c.org_id, gym: names.get(c.org_id) || c.org_id, rule_id: c.rule_id,
      name: c.rule_id ? rules.get(c.rule_id)?.name || 'Deleted campaign' : 'Call backs and tests', kind: rules.get(c.rule_id)?.kind || null,
      ...finish(c), modes: [...c.modes],
    })).sort((a, b) => b.revenue - a.revenue),
  };
}

/** Totals for the last `months` months, oldest first, for a trend line. */
export async function usageTrend(db, { orgId = null, months = 6 } = {}) {
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const r = await usageReport(db, { orgId, period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` });
    out.push({ period: r.period, revenue: r2(Object.values(r.modes).reduce((s, m) => s + m.revenue, 0)), cost: r2(Object.values(r.modes).reduce((s, m) => s + m.cost, 0)), prerecorded: r.modes.prerecorded.units, interactive: r.modes.interactive.units });
  }
  return out;
}
