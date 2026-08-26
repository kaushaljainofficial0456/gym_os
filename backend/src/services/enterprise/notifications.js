// ============================================================
// ENTERPRISE NOTIFICATIONS — thin wrapper around the EXISTING
// `notifications` table (messages.js/reports.js already write to it;
// see database/schema.sql's comment on that table). Delivery channel is
// 'in_app' only -- no email/SMS provider is configured in this
// environment (see the Enterprise report's "remaining manual
// configuration" section). Every call here is best-effort: a
// notification failing to write must never break the request that
// triggered it, the same philosophy as track()/events.
// ============================================================

import { id, now } from '../../ids.js';

export async function notify(db, { orgId, userId, type, title, body = null, data = null }) {
  try {
    await db.run(
      `INSERT INTO notifications (id, org_id, user_id, type, title, body, data_json, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'in_app', ?)`,
      [id('ntf'), orgId, userId, type, title, body, data ? JSON.stringify(data) : null, now()]);
  } catch { /* notifications are best-effort, never fatal to the caller */ }
}

/** Notifies every GYM_OWNER/SUPER_ADMIN of an org -- used for owner-facing
 *  events (client joined, payment received, capacity low, ...) where the
 *  caller doesn't already have a specific user id in hand. */
export async function notifyOwners(db, orgId, { type, title, body = null, data = null }) {
  const owners = await db.q(`SELECT id FROM users WHERE org_id = ? AND role = 'GYM_OWNER' AND active = 1`, [orgId]);
  for (const owner of owners) {
    await notify(db, { orgId, userId: owner.id, type, title, body, data });
  }
}
