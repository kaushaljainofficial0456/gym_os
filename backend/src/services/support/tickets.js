// ============================================================
// SUPPORT TICKETS (Phase 3b) — gym owners raise tickets against their
// own org; SUPER_ADMIN (Admin Console) sees and works every ticket
// platform-wide. Confirmed a complete blank slate before this pass
// (no placeholder table, no partial route existed anywhere).
//
// The one thing this module exists to get right: an `internal` message
// (an admin-only note) must NEVER reach a gym-owner-facing read, not
// just be hidden by the frontend. listMessages() takes an explicit
// `includeInternal` flag; the owner-facing route (admin.js) always
// passes false, the console route (console.js) always passes true —
// there is no third caller that could get this wrong by omission.
// ============================================================
import { id, now } from '../../ids.js';
import { track } from '../events.js';

export async function createTicket(db, { orgId, createdBy, category, priority = 'MEDIUM', subject, body }) {
  const ticketId = id('tkt');
  const nowIso = now();
  await db.tx(async (tx) => {
    await tx.run(
      `INSERT INTO support_tickets (id, org_id, created_by, category, priority, status, subject, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      [ticketId, orgId, createdBy, category, priority, subject, nowIso, nowIso]);
    await tx.run(
      `INSERT INTO support_messages (id, ticket_id, author_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      [id('tmsg'), ticketId, createdBy, body, nowIso]);
  });
  await track(db, { type: 'support_ticket_created', orgId, userId: createdBy, data: { ticketId, category, priority } }).catch(() => {});
  return db.q1('SELECT * FROM support_tickets WHERE id = ?', [ticketId]);
}

/** Owner-facing: this org's own tickets only. */
export async function listTicketsForOrg(db, { orgId, status = null }) {
  const conds = ['org_id = ?']; const params = [orgId];
  if (status) { conds.push('status = ?'); params.push(status); }
  return db.q(`SELECT * FROM support_tickets WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params);
}

/** Console-facing: platform-wide, with the gym name joined in since an
 *  admin is triaging across every org at once. */
export async function listTicketsPlatformWide(db, { status = null, priority = null } = {}) {
  const conds = []; const params = [];
  if (status) { conds.push('t.status = ?'); params.push(status); }
  if (priority) { conds.push('t.priority = ?'); params.push(priority); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db.q(
    `SELECT t.*, o.name AS org_name FROM support_tickets t JOIN organizations o ON o.id = t.org_id ${where} ORDER BY t.created_at DESC LIMIT 200`,
    params);
}

/** orgId: pass the caller's own org for an owner-facing lookup (returns
 *  null if the ticket belongs to someone else's org -- tenant isolation
 *  enforced here, not left to the caller to remember); omit for a
 *  platform-scoped (SUPER_ADMIN) lookup. */
export async function getTicket(db, { ticketId, orgId = null }) {
  return orgId
    ? db.q1('SELECT * FROM support_tickets WHERE id = ? AND org_id = ?', [ticketId, orgId])
    : db.q1('SELECT * FROM support_tickets WHERE id = ?', [ticketId]);
}

export async function listMessages(db, { ticketId, includeInternal }) {
  const rows = await db.q(
    `SELECT m.*, u.name AS author_name, u.role AS author_role
       FROM support_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = ? ${includeInternal ? '' : 'AND m.internal = 0'}
      ORDER BY m.created_at ASC`, [ticketId]);
  return rows;
}

export async function addMessage(db, { ticketId, authorId, body, internal = false }) {
  const messageId = id('tmsg');
  const nowIso = now();
  await db.run(
    `INSERT INTO support_messages (id, ticket_id, author_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [messageId, ticketId, authorId, body, internal ? 1 : 0, nowIso]);
  // A reply (not an internal note) nudges a ticket out of a terminal
  // "closed" state back into the active queue -- an admin replying to a
  // resolved ticket almost always means the gym re-opened the
  // conversation, not that it should stay silently marked done.
  if (!internal) {
    await db.run(`UPDATE support_tickets SET status = CASE WHEN status IN ('RESOLVED','CLOSED') THEN 'IN_PROGRESS' ELSE status END, updated_at = ? WHERE id = ?`, [nowIso, ticketId]);
  }
  return db.q1('SELECT * FROM support_messages WHERE id = ?', [messageId]);
}

export async function updateTicketStatus(db, { ticketId, status }) {
  const result = await db.run(`UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?`, [status, now(), ticketId]);
  return result.changes === 1;
}

export async function updateTicketPriority(db, { ticketId, priority }) {
  const result = await db.run(`UPDATE support_tickets SET priority = ?, updated_at = ? WHERE id = ?`, [priority, now(), ticketId]);
  return result.changes === 1;
}

export async function assignTicket(db, { ticketId, adminId }) {
  const result = await db.run(`UPDATE support_tickets SET assigned_admin_id = ?, updated_at = ? WHERE id = ?`, [adminId, now(), ticketId]);
  return result.changes === 1;
}
