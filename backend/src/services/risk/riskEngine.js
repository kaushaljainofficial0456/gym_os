// ============================================================
// FRAUD / RISK MONITORING (Phase 3b) -- confirmed a complete blank
// slate before this pass. Scoped to detectors this codebase can
// HONESTLY run from data it already collects; deliberately does NOT
// include "multiple accounts from the same device/IP" (the original
// spec's own example) because no IP/device fingerprinting exists
// anywhere in this codebase -- inventing that signal from data that
// isn't collected would be exactly the fabrication the hardening spec
// forbids elsewhere.
//
// No cron infrastructure exists in this codebase -- runRiskScan() is
// an ADMIN-TRIGGERED sweep, matching the same established pattern as
// reconciliation.js, not a background worker.
//
// HARD RULE (spec): "Do NOT automatically ban users based solely on
// risk score." Every detector here only ever INSERTS a risk_events row
// for a human to review -- nothing in this file ever suspends an
// account, revokes a token, or blocks a payment.
// ============================================================
import { id, now } from '../../ids.js';

const RAPID_QR_THRESHOLD = Number(process.env.RISK_RAPID_QR_THRESHOLD) || 10;
const RAPID_QR_WINDOW_MS = Number(process.env.RISK_RAPID_QR_WINDOW_MS) || 60 * 60_000; // 1 hour
const FAILED_PAYMENTS_THRESHOLD = Number(process.env.RISK_FAILED_PAYMENTS_THRESHOLD) || 5;
const FAILED_PAYMENTS_WINDOW_MS = Number(process.env.RISK_FAILED_PAYMENTS_WINDOW_MS) || 24 * 60 * 60_000; // 24h
const REFUND_VOLUME_THRESHOLD = Number(process.env.RISK_REFUND_VOLUME_THRESHOLD) || 5;
const REFUND_VOLUME_WINDOW_MS = Number(process.env.RISK_REFUND_VOLUME_WINDOW_MS) || 7 * 24 * 60 * 60_000; // 7 days

async function alreadyOpen(db, { entityType, entityId, reason }) {
  return db.q1(`SELECT id FROM risk_events WHERE entity_type = ? AND entity_id = ? AND reason = ? AND status IN ('OPEN', 'REVIEWING')`, [entityType, entityId, reason]);
}

// A crude 0-100 severity heuristic (how far past the threshold, capped)
// -- NOT a calibrated fraud-scoring model. Shown as a rough sort order
// for admin triage, never presented as a precise probability.
function severity(count, threshold) {
  return Math.min(100, Math.round((count / threshold) * 50));
}

async function raiseRiskEvent(db, { orgId, entityType, entityId, reason, riskScore, detail }) {
  // Never duplicate an already-open flag for the same (entity, reason)
  // -- an admin already has one to review; re-raising on every sweep
  // would be noise, not new information.
  const existing = await alreadyOpen(db, { entityType, entityId, reason });
  if (existing) return null;
  const eventId = id('risk');
  await db.run(
    `INSERT INTO risk_events (id, org_id, entity_type, entity_id, reason, risk_score, detail_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
    [eventId, orgId, entityType, entityId, reason, riskScore, JSON.stringify(detail || {}), now()]);
  return eventId;
}

/** The same account generating an unusual number of enrollment QR
 *  tokens in a short window -- could be legitimate bulk onboarding, or
 *  QR spamming/abuse. Flagged for review only. */
async function detectRapidQrGeneration(db, { orgId = null } = {}) {
  const since = new Date(Date.now() - RAPID_QR_WINDOW_MS).toISOString();
  const conds = ['created_at >= ?']; const params = [since];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  const rows = await db.q(
    `SELECT created_by, org_id, COUNT(*) AS n FROM enrollment_tokens WHERE ${conds.join(' AND ')} GROUP BY created_by, org_id HAVING COUNT(*) >= ?`,
    [...params, RAPID_QR_THRESHOLD]);
  const raised = [];
  for (const row of rows) {
    const n = Number(row.n);
    const eid = await raiseRiskEvent(db, {
      orgId: row.org_id, entityType: 'user', entityId: row.created_by, reason: 'RAPID_QR_GENERATION',
      riskScore: severity(n, RAPID_QR_THRESHOLD),
      detail: { count: n, windowMs: RAPID_QR_WINDOW_MS, threshold: RAPID_QR_THRESHOLD },
    });
    if (eid) raised.push(eid);
  }
  return raised;
}

/** Multiple failed payments for one org -- could indicate an expired/
 *  compromised payment method being retried, or card-testing abuse
 *  against the checkout. */
async function detectMultipleFailedPayments(db, { orgId = null } = {}) {
  const since = new Date(Date.now() - FAILED_PAYMENTS_WINDOW_MS).toISOString();
  const conds = [`status = 'FAILED'`, 'created_at >= ?']; const params = [since];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  const rows = await db.q(
    `SELECT org_id, COUNT(*) AS n FROM payment_orders WHERE ${conds.join(' AND ')} GROUP BY org_id HAVING COUNT(*) >= ?`,
    [...params, FAILED_PAYMENTS_THRESHOLD]);
  const raised = [];
  for (const row of rows) {
    const n = Number(row.n);
    const eid = await raiseRiskEvent(db, {
      orgId: row.org_id, entityType: 'org', entityId: row.org_id, reason: 'MULTIPLE_FAILED_PAYMENTS',
      riskScore: severity(n, FAILED_PAYMENTS_THRESHOLD),
      detail: { count: n, windowMs: FAILED_PAYMENTS_WINDOW_MS, threshold: FAILED_PAYMENTS_THRESHOLD },
    });
    if (eid) raised.push(eid);
  }
  return raised;
}

/** Unusual refund volume for one org -- a real fraud vector (a
 *  compromised owner account issuing rapid refunds to an accomplice)
 *  as well as a legitimate-but-worth-reviewing pattern (a systemic
 *  service problem at one gym). */
async function detectUnusualRefundVolume(db, { orgId = null } = {}) {
  const since = new Date(Date.now() - REFUND_VOLUME_WINDOW_MS).toISOString();
  const conds = [`status = 'SUCCESS'`, 'created_at >= ?']; const params = [since];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  const rows = await db.q(
    `SELECT org_id, COUNT(*) AS n FROM refunds WHERE ${conds.join(' AND ')} GROUP BY org_id HAVING COUNT(*) >= ?`,
    [...params, REFUND_VOLUME_THRESHOLD]);
  const raised = [];
  for (const row of rows) {
    const n = Number(row.n);
    const eid = await raiseRiskEvent(db, {
      orgId: row.org_id, entityType: 'org', entityId: row.org_id, reason: 'UNUSUAL_REFUND_VOLUME',
      riskScore: severity(n, REFUND_VOLUME_THRESHOLD),
      detail: { count: n, windowMs: REFUND_VOLUME_WINDOW_MS, threshold: REFUND_VOLUME_THRESHOLD },
    });
    if (eid) raised.push(eid);
  }
  return raised;
}

/** Runs every detector once -- admin-triggered, matching this
 *  codebase's established "no cron, sweep-triggered" pattern (see
 *  reconciliation.js). An existing OPEN/REVIEWING event for the same
 *  entity+reason is never duplicated. */
export async function runRiskScan(db, { orgId = null } = {}) {
  const [rapidQr, failedPayments, refundVolume] = await Promise.all([
    detectRapidQrGeneration(db, { orgId }),
    detectMultipleFailedPayments(db, { orgId }),
    detectUnusualRefundVolume(db, { orgId }),
  ]);
  return {
    rapidQrGeneration: rapidQr.length,
    multipleFailedPayments: failedPayments.length,
    unusualRefundVolume: refundVolume.length,
    totalRaised: rapidQr.length + failedPayments.length + refundVolume.length,
  };
}

export async function listRiskEvents(db, { orgId = null, status = null, limit = 200 } = {}) {
  const conds = []; const params = [];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  if (status) { conds.push('status = ?'); params.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db.q(`SELECT * FROM risk_events ${where} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
}

export async function markReviewing(db, { eventId }) {
  const result = await db.run(`UPDATE risk_events SET status = 'REVIEWING' WHERE id = ? AND status = 'OPEN'`, [eventId]);
  return result.changes === 1;
}

/** Resolving/dismissing is the only state change a human makes here --
 *  never an automatic ban/suspend/revoke (spec: "Do NOT automatically
 *  ban users based solely on risk score"). */
export async function resolveRiskEvent(db, { eventId, resolvedBy, note, dismiss = false }) {
  const result = await db.run(
    `UPDATE risk_events SET status = ?, resolved_at = ?, resolved_by = ?, note = COALESCE(?, note) WHERE id = ? AND status IN ('OPEN', 'REVIEWING')`,
    [dismiss ? 'DISMISSED' : 'RESOLVED', now(), resolvedBy, note || null, eventId]);
  return result.changes === 1;
}
