// ============================================================
// PAYMENT RECONCILIATION — compares SK OS's own payment_orders against
// the provider's own records for orders that have been stuck in a
// non-terminal state for a while, and recovers or flags what it finds.
//
// No cron/scheduled-job infrastructure exists in this codebase -- this
// is an ADMIN-TRIGGERED sweep (see routes/admin.js's own
// POST /reconciliation/run), matching the lazy-check pattern already
// used elsewhere (e.g. subscriptionLifecycle.js's lazy EXPIRED
// transition) rather than a background worker.
//
// Two things this deliberately does NOT do:
//   - Never silently rewrites a financial record to make a mismatch
//     disappear -- a genuine mismatch (amount/currency) is logged to
//     reconciliation_issues for a human to look at, never auto-"fixed".
//   - Never treats "provider still shows CREATED/pending" as a problem
//     to fix -- a checkout a client simply never completed is normal,
//     not a bug; it's flagged for visibility only, never force-failed.
// ============================================================

import { id, now } from '../../ids.js';
import { fetchProviderOrderStatus } from './paymentProvider.js';
import { recoverOrderFromProvider } from './paymentActivation.js';
import { track } from '../events.js';

const DEFAULT_STALE_AFTER_MS = 15 * 60_000; // 15 min -- long enough a client mid-checkout right now is never falsely flagged

async function logIssue(db, { orderId, orgId, issueType, expected, actual, note }) {
  await db.run(
    `INSERT INTO reconciliation_issues (id, payment_order_id, org_id, issue_type, expected_json, actual_json, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
    [id('rcon'), orderId, orgId, issueType, JSON.stringify(expected ?? null), JSON.stringify(actual ?? null), note || null, now()]);
}

/**
 * Sweeps stale non-terminal payment_orders (CREATED/PENDING/PROCESSING
 * for longer than staleAfterMs), fetches the provider's own view of
 * each, and either:
 *   - recovers it (provider confirms SUCCESS/FAILED/CANCELLED but SK OS
 *     never heard about it -- runs the SAME idempotent finalize path a
 *     webhook would have, via recoverOrderFromProvider), or
 *   - flags a genuine disagreement (amount/currency mismatch) for
 *     review, or
 *   - flags a still-pending order past the staleness window for
 *     visibility (never auto-failed -- an abandoned checkout is normal).
 * `orgId: null` sweeps platform-wide -- callers MUST pass their own
 * orgId unless they are a genuinely platform-scoped caller (the
 * gym-owner-facing route below always scopes to req.orgId).
 * Returns a summary: { checked, recovered, flagged, unchanged }.
 */
export async function runReconciliationSweep(db, { orgId = null, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const conds = [`status IN ('CREATED','PENDING','PROCESSING')`, `created_at <= ?`];
  const params = [cutoff];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  const stuck = await db.q(`SELECT * FROM payment_orders WHERE ${conds.join(' AND ')} ORDER BY created_at ASC LIMIT 200`, params);

  const summary = { checked: stuck.length, recovered: 0, flagged: 0, unchanged: 0 };

  for (const order of stuck) {
    if (!order.provider_order_id) { summary.unchanged++; continue; } // never even reached the provider -- nothing to reconcile against

    let remote;
    try {
      remote = await fetchProviderOrderStatus(order.provider_order_id);
    } catch (e) {
      // A provider API failure is OUR problem to retry later, never a
      // reason to flag the ORDER itself as suspect.
      await track(db, { type: 'reconciliation_fetch_failed', orgId: order.org_id, data: { orderId: order.id, error: String(e.message || e) } }).catch(() => {});
      summary.unchanged++;
      continue;
    }
    if (!remote.found) { summary.unchanged++; continue; } // provider genuinely never saw this order either -- nothing to recover

    if (remote.status === 'SUCCESS') {
      const mismatchAmount = remote.amount != null && Math.abs(remote.amount - order.amount) > 0.01;
      const mismatchCurrency = remote.currency != null && remote.currency !== order.currency;
      if (mismatchAmount || mismatchCurrency) {
        await logIssue(db, {
          orderId: order.id, orgId: order.org_id,
          issueType: mismatchAmount ? 'AMOUNT_MISMATCH' : 'CURRENCY_MISMATCH',
          expected: { amount: order.amount, currency: order.currency },
          actual: { amount: remote.amount, currency: remote.currency },
          note: 'provider reports SUCCESS but amount/currency disagrees with our order -- not auto-recovered',
        });
        summary.flagged++;
        continue;
      }
      await recoverOrderFromProvider(db, order, {
        providerPaymentId: remote.providerPaymentId, amount: remote.amount, currency: remote.currency, status: 'SUCCESS',
      });
      await logIssue(db, {
        orderId: order.id, orgId: order.org_id, issueType: 'RECOVERED',
        expected: { status: order.status }, actual: { status: remote.status },
        note: 'provider confirmed SUCCESS; our order was stuck -- finalize+activate re-run by reconciliation',
      });
      summary.recovered++;
    } else if (['FAILED', 'CANCELLED'].includes(remote.status)) {
      // The provider definitively gave up on this order too -- converge
      // our stale record to match, through the SAME finalize path (which
      // also fires the release handler, e.g. freeing a reserved capacity
      // slot) rather than a bespoke UPDATE here.
      await recoverOrderFromProvider(db, order, {
        providerPaymentId: remote.providerPaymentId, amount: remote.amount, currency: remote.currency, status: remote.status,
      });
      summary.recovered++;
    } else {
      // Still genuinely pending at the provider too (e.g. an abandoned
      // checkout) -- not a bug, just flagged so an owner can see it.
      await logIssue(db, {
        orderId: order.id, orgId: order.org_id, issueType: 'STUCK_NON_TERMINAL',
        expected: { status: order.status }, actual: { status: remote.status },
        note: 'still non-terminal at the provider after the staleness window -- likely an abandoned checkout, not auto-failed',
      });
      summary.flagged++;
    }
  }
  return summary;
}

/** orgId: null lists platform-wide (the future Admin Console's own
 *  Reconciliation Center) -- every owner-facing caller MUST pass their
 *  own orgId; only a genuinely platform-scoped caller omits it. */
export async function listReconciliationIssues(db, { orgId = null, status = null, limit = 200 } = {}) {
  const conds = []; const params = [];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  if (status) { conds.push('status = ?'); params.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return db.q(`SELECT * FROM reconciliation_issues ${where} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
}

/** Marks an OPEN issue resolved (a human looked at it, took whatever
 *  action was appropriate outside this system) or dismissed (a false
 *  positive) -- this table itself is never mutated to "fix" a financial
 *  record, only to record that a human reviewed the discrepancy.
 *  orgId: null = platform-scoped caller (Admin Console, SUPER_ADMIN
 *  only), matching listReconciliationIssues' same convention -- every
 *  owner-facing caller MUST still pass their own orgId. */
export async function resolveReconciliationIssue(db, { orgId = null, issueId, resolvedBy, note, dismiss = false }) {
  const conds = ['id = ?', `status = 'OPEN'`]; const params = [issueId];
  if (orgId) { conds.push('org_id = ?'); params.push(orgId); }
  const result = await db.run(
    `UPDATE reconciliation_issues SET status = ?, resolved_at = ?, resolved_by = ?, note = COALESCE(?, note) WHERE ${conds.join(' AND ')}`,
    [dismiss ? 'DISMISSED' : 'RESOLVED', now(), resolvedBy, note || null, ...params]);
  return result.changes === 1;
}
