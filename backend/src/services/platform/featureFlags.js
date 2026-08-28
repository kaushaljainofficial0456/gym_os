// ============================================================
// FEATURE FLAGS (Phase 3c) -- confirmed a complete blank slate before
// this pass. Global on/off + optional percentage rollout + an explicit
// per-org allow-list that always wins regardless of rollout bucket
// (spec: "Enabled globally | Disabled globally | Percentage rollout |
// Specific gym").
//
// SCOPE, honestly stated: this pass builds the flag store and the
// evaluation function (isFeatureEnabled) -- it does NOT wire any
// EXISTING feature in frontend/ or backend/ to actually check a flag.
// Adoption is opportunistic, matching how requirePermission() (Phase 2)
// was built the same way: the capability exists and is tested; using it
// to gate a specific real feature is separate, future work.
// ============================================================
import { id, now } from '../../ids.js';
import { track } from '../events.js';

function safeParseArray(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// A stable, non-cryptographic string hash (FNV-1a) -- deterministic
// bucketing only needs to be STABLE (the same org+key always lands in
// the same bucket) and roughly uniform, never unpredictable-by-design.
function stableBucket(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 100;
}

export async function listFeatureFlags(db) {
  const rows = await db.q('SELECT * FROM feature_flags ORDER BY key ASC');
  return rows.map((r) => ({ ...r, enabled_org_ids: safeParseArray(r.enabled_org_ids_json) }));
}

export async function getFeatureFlag(db, { key }) {
  const row = await db.q1('SELECT * FROM feature_flags WHERE key = ?', [key]);
  return row ? { ...row, enabled_org_ids: safeParseArray(row.enabled_org_ids_json) } : null;
}

export async function createFeatureFlag(db, { key, name, description, createdBy }) {
  const existing = await db.q1('SELECT id FROM feature_flags WHERE key = ?', [key]);
  if (existing) return { ok: false, reason: 'key_already_exists' };
  const flagId = id('flag');
  const nowIso = now();
  await db.run(
    `INSERT INTO feature_flags (id, key, name, description, enabled, rollout_percentage, enabled_org_ids_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 100, '[]', ?, ?, ?)`,
    [flagId, key, name, description || null, createdBy || null, nowIso, nowIso]);
  return { ok: true, id: flagId };
}

export async function updateFeatureFlag(db, { id: flagId, enabled, rolloutPercentage, enabledOrgIds }) {
  const existing = await db.q1('SELECT * FROM feature_flags WHERE id = ?', [flagId]);
  if (!existing) return { ok: false, reason: 'not_found' };
  const nextEnabled = enabled != null ? (enabled ? 1 : 0) : existing.enabled;
  const nextRollout = rolloutPercentage != null ? rolloutPercentage : existing.rollout_percentage;
  const nextOrgIds = enabledOrgIds != null ? JSON.stringify(enabledOrgIds) : existing.enabled_org_ids_json;
  await db.run(
    `UPDATE feature_flags SET enabled = ?, rollout_percentage = ?, enabled_org_ids_json = ?, updated_at = ? WHERE id = ?`,
    [nextEnabled, nextRollout, nextOrgIds, now(), flagId]);
  return { ok: true, before: existing, after: await db.q1('SELECT * FROM feature_flags WHERE id = ?', [flagId]) };
}

export async function deleteFeatureFlag(db, { id: flagId }) {
  const result = await db.run('DELETE FROM feature_flags WHERE id = ?', [flagId]);
  return result.changes === 1;
}

/** The one evaluation function real call sites would use. Order:
 *  disabled globally -> always false; org on the explicit allow-list ->
 *  always true; otherwise -> deterministic percentage rollout bucketed
 *  on (key, orgId) so the SAME org always gets the SAME answer for a
 *  given flag+rollout, never a coin-flip per request. */
export async function isFeatureEnabled(db, key, { orgId = null } = {}) {
  const flag = await getFeatureFlag(db, { key });
  if (!flag) return false;
  if (!flag.enabled) return false;
  if (orgId && flag.enabled_org_ids.includes(orgId)) return true;
  if (flag.rollout_percentage >= 100) return true;
  if (flag.rollout_percentage <= 0) return false;
  if (!orgId) return false; // no org context -- can't bucket, only an explicit allow-list or 100% applies
  return stableBucket(`${key}:${orgId}`) < flag.rollout_percentage;
}
