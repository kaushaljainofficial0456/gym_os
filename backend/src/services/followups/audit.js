// ============================================================
// AI COMMUNICATION -- OWNER AUDIT TRAIL
//
// Who changed the gym's AI Communication setup, when, from what to what:
// settings (hours, caps, spending cap, sender details), the compliance
// checklist, campaigns (create / edit / start / pause / delete) and caller
// number labels. Written in the SAME transaction as the change, so a change
// is never saved without its record.
//
// Founder actions live in admin_audit_logs (routes/console.js); consent
// changes live in followup_consent_log (consent.js). Values pass through the
// shared redactor (services/access/audit.js) so nothing secret-shaped is kept.
// ============================================================
import { id, now } from '../../ids.js';
import { redactState } from '../access/audit.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(redactState(v)).slice(0, 4000));

export async function auditOwner(db, req, { action, entityType = null, entityId = null, before = null, after = null }) {
  await db.run(
    `INSERT INTO followup_audit (id, org_id, actor_id, actor_role, action, entity_type, entity_id, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('fau'), req.orgId, req.user?.sub || null, req.user?.role || null, action, entityType, entityId, json(before), json(after), now()]);
}

/** Only the keys a request changed, with their values before it. */
export const changedFrom = (current, patch) => Object.fromEntries(Object.keys(patch || {}).map((k) => [k, current?.[k] ?? null]));

export async function recentOwnerChanges(db, orgId, limit = 50) {
  const rows = await db.q(
    `SELECT a.action, a.entity_type, a.entity_id, a.before_json, a.after_json, a.actor_role, a.created_at, u.name AS actor_name
       FROM followup_audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`, [orgId, limit]);
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return rows.map((r) => ({ ...r, before: parse(r.before_json), after: parse(r.after_json), before_json: undefined, after_json: undefined }));
}
