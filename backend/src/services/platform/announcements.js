// ============================================================
// PLATFORM ANNOUNCEMENTS (Phase 3c) -- confirmed a complete blank slate
// before this pass. An admin-authored message with an audience and an
// optional active window; "active right now" is derived from
// starts_at/ends_at at READ time (same lazy-check philosophy as
// subscriptionLifecycle.js's own expiry handling -- no cron exists in
// this codebase to flip a status column on a schedule).
//
// SCOPE, honestly stated: this builds the CRUD + the "what's active
// right now" read used by the public endpoint below -- it does NOT add
// a banner UI to frontend/ (the gym-owner/trainer/client app). The
// data is real and consumable; displaying it there is separate, future
// frontend work.
// ============================================================
import { id, now } from '../../ids.js';

export async function listAnnouncements(db) {
  return db.q('SELECT * FROM platform_announcements ORDER BY created_at DESC LIMIT 200');
}

/** Currently active: within its start/end window (either bound may be
 *  NULL, meaning open-ended on that side) and matching the requested
 *  audience (ALL always matches). Used by the public consumption
 *  endpoint every other app in this codebase could call. */
export async function listActiveAnnouncements(db, { audience = 'ALL' } = {}) {
  const nowIso = now();
  const rows = await db.q(
    `SELECT * FROM platform_announcements
      WHERE (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
        AND (audience = 'ALL' OR audience = ?)
      ORDER BY CASE priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at DESC`,
    [nowIso, nowIso, audience]);
  return rows;
}

export async function createAnnouncement(db, { title, message, audience = 'ALL', priority = 'NORMAL', startsAt, endsAt, createdBy }) {
  const announcementId = id('ann');
  const nowIso = now();
  await db.run(
    `INSERT INTO platform_announcements (id, title, message, audience, priority, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [announcementId, title, message, audience, priority, startsAt || null, endsAt || null, createdBy || null, nowIso, nowIso]);
  return announcementId;
}

export async function updateAnnouncement(db, { id: announcementId, title, message, audience, priority, startsAt, endsAt }) {
  const existing = await db.q1('SELECT * FROM platform_announcements WHERE id = ?', [announcementId]);
  if (!existing) return null;
  await db.run(
    `UPDATE platform_announcements SET title = ?, message = ?, audience = ?, priority = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`,
    [
      title ?? existing.title, message ?? existing.message, audience ?? existing.audience, priority ?? existing.priority,
      startsAt !== undefined ? startsAt : existing.starts_at, endsAt !== undefined ? endsAt : existing.ends_at,
      now(), announcementId,
    ]);
  return db.q1('SELECT * FROM platform_announcements WHERE id = ?', [announcementId]);
}

export async function deleteAnnouncement(db, { id: announcementId }) {
  const result = await db.run('DELETE FROM platform_announcements WHERE id = ?', [announcementId]);
  return result.changes === 1;
}
