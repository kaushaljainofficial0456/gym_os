// ============================================================
// AI FOOD ESTIMATE FEEDBACK — user corrections as accumulating evidence,
// never a direct write to the shared cache.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: one user's correction is an
// OBSERVATION, not a fact. estimateFoodAI()/foodAICache.js already give
// every user the SAME cached estimate for a canonical dish (that's the
// whole point of the cache -- one AI call per concept, ever). If a single
// edit could overwrite that cache, the very NEXT user would see THAT
// user's opinion presented as the shared answer. This file accumulates
// corrections instead, and only updates the shared estimate once there's
// enough independent, mutually-consistent evidence -- see
// aggregateAndMaybePromote() below.
//
// VALIDATION STATES (ai_food_estimates.validation_status):
//   AI_ESTIMATED               -- a single AI response, cached, unreviewed
//   COMMUNITY_VALIDATED_CANDIDATE -- >= MIN_FEEDBACK_COUNT independent,
//                                    mutually-consistent corrections agreed
//                                    the AI's original number was off, and
//                                    the aggregate replaced it
//   VERIFIED_SHARED_FOOD       -- reserved for a future, separate human/
//                                    admin verification step. NEVER set
//                                    automatically by this file -- an
//                                    aggregate of user guesses is still a
//                                    community estimate, not lab data.
// ============================================================

import { id, now } from '../../ids.js';
import { atwaterConsistent } from './foodAI.js';

// Configurable rather than hard-coded at every call site (spec's own
// requirement) -- how many independent feedback observations are needed
// before an aggregate is even considered for promotion. Kept modest by
// default (this is a "enough people said the same thing" bar, not the
// spec's own illustrative "100 users" example, which was illustrative,
// not a mandated minimum) but real deployments can tune it without a
// code change.
export const MIN_FEEDBACK_COUNT = Number(process.env.FOOD_AI_MIN_FEEDBACK_COUNT) || 5;

/** Per-100g normalization -- see the file header on why this must happen
 *  before two corrections logged at different quantities are comparable. */
function per100g(value, grams) {
  const g = Number(grams);
  const v = Number(value);
  if (!(g > 0) || !Number.isFinite(v)) return null;
  return (v / g) * 100;
}

/**
 * Record one user's correction as a feedback OBSERVATION. Never touches
 * ai_food_estimates itself directly -- see aggregateAndMaybePromote(),
 * called right after, for the only path that can update the shared value,
 * and only once there's enough evidence.
 *
 * original/adjusted: { calories, protein_g, carbs_g, fat_g } at `grams`.
 * Returns { ok: true } or { ok: false, reason } -- never throws; feedback
 * collection must never break the logging flow that triggered it.
 */
export async function submitFeedback(db, { canonicalKey, originalGrams, adjustedGrams, original, adjusted, aiProvider, aiModel, clientId }) {
  if (!canonicalKey || !(Number(originalGrams) > 0) || !(Number(adjustedGrams) > 0)) return { ok: false, reason: 'invalid_input' };
  const o100 = {
    calories: per100g(original?.calories, originalGrams), protein: per100g(original?.protein_g, originalGrams),
    carbs: per100g(original?.carbs_g, originalGrams), fat: per100g(original?.fat_g, originalGrams),
  };
  const a100 = {
    calories: per100g(adjusted?.calories, adjustedGrams), protein: per100g(adjusted?.protein_g, adjustedGrams),
    carbs: per100g(adjusted?.carbs_g, adjustedGrams), fat: per100g(adjusted?.fat_g, adjustedGrams),
  };
  // Nothing to learn from a correction that didn't actually change
  // anything meaningful (e.g. a 1-calorie rounding difference).
  if (o100.calories != null && a100.calories != null && Math.abs(o100.calories - a100.calories) < 5) {
    return { ok: true, recorded: false, reason: 'no_meaningful_change' };
  }
  try {
    await db.run(
      `INSERT INTO ai_food_feedback
         (id, canonical_key, original_calories, original_protein, original_carbs, original_fat,
          adjusted_calories, adjusted_protein, adjusted_carbs, adjusted_fat,
          quantity_g, ai_provider, ai_model, client_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id('aff'), canonicalKey, o100.calories, o100.protein, o100.carbs, o100.fat,
       a100.calories, a100.protein, a100.carbs, a100.fat,
       Number(adjustedGrams), aiProvider || null, aiModel || null, clientId || null, now()]);
  } catch {
    return { ok: false, reason: 'write_failed' }; // feedback is best-effort, never fatal to the caller
  }
  const promotion = await aggregateAndMaybePromote(db, canonicalKey);
  return { ok: true, recorded: true, promotion };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Recomputes the aggregate correction for one canonical dish and, ONLY if
 * there is now enough evidence (>= MIN_FEEDBACK_COUNT observations) AND
 * the aggregate itself is physically plausible (same Atwater check a
 * fresh AI response has to pass), promotes ai_food_estimates to the
 * median-corrected value. Median, not a plain mean -- one wildly wrong
 * correction must not drag the shared value toward it (spec: "outliers
 * must not dominate").
 *
 * Never regresses an already-promoted estimate back to AI_ESTIMATED, and
 * never sets VERIFIED_SHARED_FOOD -- that status is reserved for a
 * separate human review step this file does not perform.
 */
export async function aggregateAndMaybePromote(db, canonicalKey) {
  /* ONE PERSON, ONE VOICE. Counting feedback ROWS let a single user submit
     MIN_FEEDBACK_COUNT corrections (the route allows 10 a minute) and
     rewrite a value every gym shares. Each person now counts once, with
     their most recent correction; anonymous rows (deleted accounts) do not
     count at all. */
  const all = await db.q(
    `SELECT client_id, adjusted_calories, adjusted_protein, adjusted_carbs, adjusted_fat, created_at
       FROM ai_food_feedback
      WHERE canonical_key = ? AND adjusted_calories IS NOT NULL AND client_id IS NOT NULL
      ORDER BY created_at DESC`,
    [canonicalKey]);
  const latestPerPerson = new Map();
  for (const r of all) if (!latestPerPerson.has(r.client_id)) latestPerPerson.set(r.client_id, r);
  const rows = [...latestPerPerson.values()];
  const sampleCount = rows.length;
  if (sampleCount < MIN_FEEDBACK_COUNT) {
    return { promoted: false, queued: false, reason: 'insufficient_evidence', sampleCount, required: MIN_FEEDBACK_COUNT };
  }

  const agg = {
    calories: median(rows.map((r) => r.adjusted_calories).filter((v) => v != null)),
    protein_g: median(rows.map((r) => r.adjusted_protein).filter((v) => v != null)),
    carbs_g: median(rows.map((r) => r.adjusted_carbs).filter((v) => v != null)),
    fat_g: median(rows.map((r) => r.adjusted_fat).filter((v) => v != null)),
  };

  if (!atwaterConsistent(agg.calories, agg.protein_g, agg.carbs_g, agg.fat_g)) {
    // Enough people disagreed with the AI, but their OWN aggregate doesn't
    // hold together physically either -- flag, don't propose.
    return { promoted: false, queued: false, reason: 'aggregate_failed_plausibility_check', sampleCount };
  }

  const estimate = await db.q1('SELECT * FROM ai_food_estimates WHERE canonical_key = ?', [canonicalKey]);
  if (!estimate) return { promoted: false, queued: false, reason: 'estimate_not_found', sampleCount };
  if (estimate.validation_status === 'VERIFIED_SHARED_FOOD') {
    return { promoted: false, queued: false, reason: 'already_verified_leave_untouched', sampleCount };
  }

  /* NEVER APPLIED AUTOMATICALLY. The aggregate becomes a PROPOSAL in
     food_data_reviews; the shared value changes only when a platform
     operator approves it (approveFoodReview). One open proposal per food:
     a newer aggregate supersedes the older pending one. */
  const proposed = {
    calories: Math.round(agg.calories), protein: Math.round(agg.protein_g * 10) / 10,
    carbs: Math.round(agg.carbs_g * 10) / 10, fat: Math.round(agg.fat_g * 10) / 10,
  };
  await db.run(`UPDATE food_data_reviews SET status = 'superseded'
                 WHERE target_type = 'ai_estimate' AND target_key = ? AND status = 'pending'`, [canonicalKey]);
  const reviewId = id('fdr');
  await db.run(
    `INSERT INTO food_data_reviews (id, target_type, target_key, proposed_json, current_json, distinct_contributors, status, created_at)
     VALUES (?, 'ai_estimate', ?, ?, ?, ?, 'pending', ?)`,
    [reviewId, canonicalKey, JSON.stringify(proposed), estimate.nutrition_json || null, sampleCount, now()]);

  return { promoted: false, queued: true, reviewId, sampleCount, aggregate: agg };
}

/** Pending (or other) shared-data proposals, oldest first. */
export async function listFoodReviews(db, { status = 'pending', limit = 100 } = {}) {
  return db.q(
    `SELECT r.*, e.canonical_name, e.validation_status AS current_status
       FROM food_data_reviews r LEFT JOIN ai_food_estimates e ON e.canonical_key = r.target_key
      WHERE r.status = ? ORDER BY r.created_at ASC LIMIT ?`,
    [status, Math.min(500, Math.max(1, Number(limit) || 100))]);
}

/**
 * A platform operator's decision on a proposal. Approval is the ONLY path
 * by which community corrections change a shared AI estimate; it is
 * recorded (who, when, note) and the estimate is marked VERIFIED_SHARED_FOOD,
 * this codebase's existing "human-reviewed" status -- still a community
 * estimate, not lab data.
 */
export async function decideFoodReview(db, reviewId, { approve, reviewerId, note = null }) {
  const review = await db.q1('SELECT * FROM food_data_reviews WHERE id = ?', [reviewId]);
  if (!review) return { ok: false, reason: 'not_found' };
  if (review.status !== 'pending') return { ok: false, reason: `already_${review.status}` };
  const at = now();
  if (!approve) {
    await db.run(`UPDATE food_data_reviews SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
      [reviewerId, at, note, reviewId]);
    return { ok: true, status: 'rejected' };
  }
  await db.tx(async (tx) => {
    await tx.run(
      `UPDATE ai_food_estimates
          SET nutrition_json = ?, validation_status = 'VERIFIED_SHARED_FOOD', version = version + 1, updated_at = ?
        WHERE canonical_key = ?`,
      [review.proposed_json, at, review.target_key]);
    await tx.run(`UPDATE food_data_reviews SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
      [reviewerId, at, note, reviewId]);
  });
  return { ok: true, status: 'approved' };
}
