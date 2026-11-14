// ============================================================
// CALLER LINES -- which of the gym's numbers a member is called from.
//
// A gym calls from its own registered numbers while it has paid line
// capacity (wallet.lineCapacity) -- its primary numbers first, then by age --
// otherwise from the platform's shared line. A member is matched to their
// branch's numbers when the gym has any, and is PINNED to one number
// (followup_member_prefs.number_id) so they always see the same caller and
// can save it. New members go to the least-loaded line.
//
// A member moves to another line only when theirs is retired, flagged, or
// outside paid capacity -- never because they blocked or ignored it.
// Suppression (consent.js) is per gym, so no number can reach a member who
// stopped calls.
// ============================================================
import { now } from '../../ids.js';
import { exotelEnv, elevenEnv } from './config.js';
import { lineCapacity } from './wallet.js';

export async function usableNumbers(db, orgId) {
  const cap = await lineCapacity(db, orgId);
  if (cap.lines <= 0) return [];
  const rows = await db.q(
    `SELECT * FROM followup_numbers WHERE org_id = ? AND status = 'active' AND health = 'ok'
      ORDER BY is_primary DESC, created_at, id`, [orgId]);
  return rows.slice(0, cap.lines);
}

export function platformLine() {
  const ex = exotelEnv();
  return ex.callerId ? { numberId: null, number: ex.callerId, agentPhoneId: elevenEnv().agentPhoneId || null, shared: true } : null;
}

/**
 * The line for one member: { numberId, number, agentPhoneId, shared }, or
 * null when there is none (test mode gets a placeholder).
 */
export async function lineFor(db, orgId, { clientId = null, branchId = null, test = false } = {}) {
  const usable = await usableNumbers(db, orgId);
  if (!usable.length) return platformLine() || (test ? { numberId: null, number: '+910000000000', agentPhoneId: null, shared: true } : null);
  const branchLines = branchId ? usable.filter((n) => n.branch_id === branchId) : [];
  const general = usable.filter((n) => !n.branch_id);
  const pool = branchLines.length ? branchLines : (general.length ? general : usable);
  const pref = clientId ? await db.q1('SELECT number_id FROM followup_member_prefs WHERE client_id = ?', [clientId]) : null;
  let pick = pool.find((n) => n.id === pref?.number_id);
  if (!pick) {
    const counts = await db.q(`SELECT number_id, COUNT(*) AS n FROM followup_member_prefs WHERE org_id = ? AND number_id IS NOT NULL GROUP BY number_id`, [orgId]);
    const load = new Map(counts.map((r) => [r.number_id, Number(r.n)]));
    pick = [...pool].sort((a, b) => (Number(b.is_primary) - Number(a.is_primary)) || ((load.get(a.id) || 0) - (load.get(b.id) || 0)))[0];
    if (clientId) await db.run('UPDATE followup_member_prefs SET number_id = ?, updated_at = ? WHERE client_id = ?', [pick.id, now(), clientId]);
  }
  return { numberId: pick.id, number: pick.number, agentPhoneId: pick.agent_phone_id || null, shared: false };
}
