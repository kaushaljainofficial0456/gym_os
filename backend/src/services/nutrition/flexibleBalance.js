// ============================================================
// FLEXIBLE CALORIE BALANCE — optional, opt-in redistribution of a day's
// calorie surplus across future days.
//
// ARCHITECTURE (mirrors this codebase's own existing target system, see
// backend/src/routes/me.js's GET/POST /nutrition/targets):
//   * `nutrition_plans` stays the ONE base-target store. This module never
//     writes to it and never invents a second target system — it reads the
//     latest row (the exact `ORDER BY created_at DESC LIMIT 1` query used
//     everywhere else in this codebase) and layers an ADJUSTMENT on top.
//   * calculateFlexibleCaloriePlan() is PURE — no db access, no mutation.
//     Every persistence path (apply / reconcile / recalculate) computes a
//     plan by calling this function, then writes the result. Calculation
//     and persistence are deliberately kept in separate functions.
//   * Protein is a protected floor, never proportionally scaled down with
//     calories (see redistributeMacros below) — the calorie cut comes out
//     of carbs first, then fat down to its own floor, matching this app's
//     existing macro-flexibility ordering (carbs is the variable macro,
//     protein and a fat minimum are the fixed ones).
//   * All numbers stay internally consistent with the app's canonical 4/4/9
//     rule (protein*4 + carbs*4 + fat*9 = calories) — the adjusted calorie
//     target is never stored independently of the macros it's derived from.
//
// RECONCILIATION MODEL (no cron exists anywhere in this codebase — see
// backend/scripts/db-check.js's own header and the wider project's
// lazy-recompute-on-read convention, e.g. useFetch's reload pattern on the
// frontend). reconcileActivePlan() catches the plan up by exactly ONE
// completed calendar day per call, anchored on `last_reconciled_date`. A
// client who opens the app roughly daily never notices; a client who is
// away for N days catches up progressively over their next N app opens
// rather than in one bulk backfill loop — EXCEPT that a plan gone stale
// for longer than MAX_PLAN_DURATION_DAYS is marked EXPIRED outright on
// the next touch instead of trying to catch up through ancient history
// (Section 11: "must not leave abandoned plans indefinitely active" —
// without this, a client who stopped opening the app would need dozens
// of future visits, one day settled per visit, before their plan ever
// resolved). Editing/deleting a food-log entry for an already-settled
// past date IS retroactively reflected — see recalculateForEditedDate.
// ============================================================
import { id, now } from '../../ids.js';
import { dayKey, addDays, daysBetween } from '../../utils/time.js';

const round1 = (n) => Math.round((n || 0) * 10) / 10;
const roundTo = (n, step) => Math.round(n / step) * step;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

// ---- Centralized safety config (Section 30: never scattered magic
// numbers). MIN_CALORIE_TARGET and the macro floors deliberately reuse the
// EXACT values already established elsewhere in this codebase (me.js's own
// TDEE floor and MACRO_BOUNDS) rather than inventing new ones. ----
export const BALANCE_CONFIG = Object.freeze({
  // Below this many kcal over base target, it's day-to-day noise, not a
  // real surplus worth interrupting the user about.
  SURPLUS_PROMPT_THRESHOLD: 150,
  // Absolute floor for any single adjusted day — the same 1200 kcal floor
  // GET /me/nutrition/targets already clamps its own suggestion to.
  MIN_CALORIE_TARGET: 1200,
  // No single day's cut may exceed this fraction of the BASE target,
  // whatever strategy or surplus size is involved.
  MAX_DAILY_ADJUSTMENT_FRACTION: 0.15,
  MIN_PLAN_DURATION_DAYS: 2,
  MAX_PLAN_DURATION_DAYS: 14,
  // Macro floors below which flexible reallocation stops cutting further —
  // the same bounds POST /me/nutrition/targets/confirm already enforces
  // (me.js's MACRO_BOUNDS.fat.min / .carbs.min).
  FAT_FLOOR_G: 15,
  CARBS_FLOOR_G: 20,
  ROUND_TO: 10, // nearest 10 kcal for a displayed daily adjustment
  STRATEGIES: {
    EASY: { label: 'Easy', minDays: 5, maxDays: 7 },
    MODERATE: { label: 'Moderate', minDays: 4, maxDays: 6 },
    AGGRESSIVE: { label: 'Aggressive', minDays: 3, maxDays: 5 },
    INTENSE: { label: 'Intense', minDays: 2, maxDays: 4 },
  },
});

export const STRATEGY_KEYS = Object.keys(BALANCE_CONFIG.STRATEGIES);

// ---- PURE calculation — no db access, no mutation. ----
// Given a base target + a total surplus + a starting strategy preference,
// returns the safest feasible daily adjustment, auto-extending duration
// past the strategy's own preferred range (and even past MAX_PLAN_DURATION
// if that's still not enough) whenever needed to respect the safety
// floors. Never lets a strategy choice bypass the floors.
export function calculateFlexibleCaloriePlan({
  baseCalorieTarget, proteinTarget, carbsTarget, fatTarget, surplusCalories, strategy,
}) {
  const cfg = BALANCE_CONFIG;
  if (!cfg.STRATEGIES[strategy]) throw new Error(`Unknown strategy: ${strategy}`);
  const surplus = Math.max(0, round1(surplusCalories));
  if (surplus <= 0) {
    return {
      feasible: true, strategy, plannedDays: 0, dailyAdjustmentCalories: 0,
      adjustedCalorieTarget: baseCalorieTarget,
      macros: { protein: round1(proteinTarget), carbs: round1(carbsTarget), fat: round1(fatTarget) },
      extended: false,
    };
  }

  // Edge case (Section 30's own list: "very low base target"): a base
  // target already at or below the safety floor has zero room to cut
  // from at all -- distinct from "the surplus is too large" (the
  // feasible=false path further down). Checked BEFORE computing
  // safeDailyCutCeiling, which would otherwise divide/compare against a
  // negative "distance to the floor" and clamp to a meaningless 1 kcal
  // ceiling -- every strategy would then report infeasible for the same
  // underlying reason with no way for the caller to tell "this surplus
  // is huge" apart from "your target itself needs attention first".
  if (baseCalorieTarget <= cfg.MIN_CALORIE_TARGET) {
    return {
      feasible: false, strategy, plannedDays: 0, dailyAdjustmentCalories: 0,
      adjustedCalorieTarget: baseCalorieTarget,
      macros: { protein: round1(proteinTarget), carbs: round1(carbsTarget), fat: round1(fatTarget) },
      extended: false, baseTargetTooLow: true,
      message: "Your daily target is already at or below a safe minimum, so there's no room to reduce it further. Review your target before using flexible adjustment.",
    };
  }

  // Safe ceiling for a single day's cut: the tighter of "% of base target"
  // and "distance down to the absolute floor".
  const safeDailyCutCeiling = Math.max(1, Math.min(
    Math.floor(baseCalorieTarget * cfg.MAX_DAILY_ADJUSTMENT_FRACTION),
    baseCalorieTarget - cfg.MIN_CALORIE_TARGET,
  ));

  let plannedDays = cfg.STRATEGIES[strategy].minDays;
  let extended = false;
  while (plannedDays < cfg.MAX_PLAN_DURATION_DAYS && Math.ceil(surplus / plannedDays) > safeDailyCutCeiling) {
    plannedDays += 1;
    extended = true;
  }
  plannedDays = clampNum(plannedDays, cfg.MIN_PLAN_DURATION_DAYS, cfg.MAX_PLAN_DURATION_DAYS);

  let dailyAdjustment = roundTo(surplus / plannedDays, cfg.ROUND_TO);
  dailyAdjustment = clampNum(dailyAdjustment, cfg.ROUND_TO, Math.max(cfg.ROUND_TO, safeDailyCutCeiling));

  const feasible = safeDailyCutCeiling > 0 && Math.ceil(surplus / plannedDays) <= safeDailyCutCeiling;
  if (!feasible) {
    // Even MAX_PLAN_DURATION_DAYS at the safe ceiling can't absorb this —
    // an enormous surplus. Don't force extreme compensation (Section 30):
    // record it, but leave the base target alone.
    return {
      feasible: false, strategy, plannedDays: 0, dailyAdjustmentCalories: 0,
      adjustedCalorieTarget: baseCalorieTarget,
      macros: { protein: round1(proteinTarget), carbs: round1(carbsTarget), fat: round1(fatTarget) },
      extended: false,
      message: 'Your balance is larger than we can safely redistribute through daily targets. Your normal target will continue while the balance is recorded.',
    };
  }

  let adjustedCalorieTarget = Math.max(cfg.MIN_CALORIE_TARGET, baseCalorieTarget - dailyAdjustment);
  let macros = redistributeMacros({ proteinG: proteinTarget, carbsG: carbsTarget, fatG: fatTarget, adjustedCalories: adjustedCalorieTarget, cfg });
  // Protein protection can outrank the target arithmetic itself in a rare
  // extreme case (a protein target whose own calories, plus both floors,
  // exceed the computed adjusted target) — never reduce protein to make
  // the numbers fit; widen the adjusted target to whatever protein +
  // floors actually require instead.
  const minFeasibleCalories = proteinTarget * KCAL_PER_G.protein + cfg.FAT_FLOOR_G * KCAL_PER_G.fat + cfg.CARBS_FLOOR_G * KCAL_PER_G.carbs;
  if (adjustedCalorieTarget < minFeasibleCalories) {
    adjustedCalorieTarget = round1(minFeasibleCalories);
    macros = { protein: round1(proteinTarget), carbs: cfg.CARBS_FLOOR_G, fat: cfg.FAT_FLOOR_G };
    dailyAdjustment = Math.max(0, round1(baseCalorieTarget - adjustedCalorieTarget));
  }

  return { feasible: true, strategy, plannedDays, dailyAdjustmentCalories: dailyAdjustment, adjustedCalorieTarget: round1(adjustedCalorieTarget), macros, extended };
}

// Cut calories from carbs first (the flexible macro), protecting protein
// fully and fat down to its own floor — never proportional scaling.
function redistributeMacros({ proteinG, carbsG, fatG, adjustedCalories, cfg }) {
  const proteinKcal = proteinG * KCAL_PER_G.protein;
  let newFatG = fatG;
  let remaining = adjustedCalories - proteinKcal - newFatG * KCAL_PER_G.fat;
  let newCarbsG = remaining / KCAL_PER_G.carbs;
  if (newCarbsG < cfg.CARBS_FLOOR_G) {
    const carbsDeficitKcal = (cfg.CARBS_FLOOR_G - newCarbsG) * KCAL_PER_G.carbs;
    const fatReductionG = Math.min(Math.max(0, newFatG - cfg.FAT_FLOOR_G), carbsDeficitKcal / KCAL_PER_G.fat);
    newFatG = Math.max(cfg.FAT_FLOOR_G, newFatG - fatReductionG);
    remaining = adjustedCalories - proteinKcal - newFatG * KCAL_PER_G.fat;
    newCarbsG = Math.max(cfg.CARBS_FLOOR_G, remaining / KCAL_PER_G.carbs);
  }
  return { protein: round1(proteinG), carbs: round1(newCarbsG), fat: round1(newFatG) };
}

// ---- db helpers (shared by the routes + the functions below) ----

export async function getBaseTargets(db, clientId) {
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [clientId]);
  if (!plan) return null;
  return { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat };
}

export async function sumEatenForDate(db, clientId, date) {
  const rows = await db.q('SELECT calories FROM meal_logs WHERE client_id = ? AND date = ? AND eaten = 1', [clientId, date]);
  return round1(rows.reduce((s, r) => s + (Number(r.calories) || 0), 0));
}

export async function getActivePlan(db, clientId) {
  return db.q1(`SELECT * FROM nutrition_balance_adjustments WHERE client_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [clientId]);
}

// Does the plan's base-target snapshot still match the client's LIVE base
// target? If not, the frontend must prompt to recalculate rather than
// silently drift (Section 17).
export function baseTargetChanged(plan, liveBase) {
  if (!plan || !liveBase) return false;
  return plan.base_calorie_target !== liveBase.calories
    || plan.base_protein_target !== liveBase.protein
    || plan.base_carbs_target !== liveBase.carbs
    || plan.base_fat_target !== liveBase.fat;
}

// Has yesterday's (or any not-yet-considered day's) surplus already been
// asked about and declined? Only checked when there's no active plan —
// once a plan exists, new surplus auto-merges instead (see reconcile).
export async function isDeclined(db, clientId, sourceDate) {
  const row = await db.q1(`SELECT 1 as x FROM nutrition_balance_prompts WHERE client_id = ? AND source_date = ? AND decision = 'DECLINED'`, [clientId, sourceDate]);
  return !!row;
}

// Is there an eligible surplus for the most recently COMPLETED day
// (yesterday, in the org's timezone)? Only meaningful when no active plan
// exists — an active plan absorbs new surplus automatically via
// reconcileActivePlan instead of re-prompting.
//
// A DECLINED day still comes back here (with `declined: true`) rather
// than as a flat null — declining only turns off the AUTOMATIC prompt
// (Section 20: "the same surplus event must not re-prompt repeatedly"),
// it is never a dead end. The spec explicitly requires "the user can
// manually start a plan later via an explicit entry point" — a caller
// that returned null on decline would have no way to satisfy that: once
// the surplus is gone from the response, there is nothing left for a
// manual entry point to act on. The frontend uses `declined` to choose
// between the auto-shown prompt card and a quiet manual "reconsider" row.
export async function checkSurplusPrompt(db, client, tz, liveBase) {
  if (!liveBase) return null;
  const today = dayKey(new Date(), tz);
  const yesterday = dayKey(addDays(new Date(), -1), tz);
  if (yesterday >= today) return null; // defensive; addDays(-1) always precedes today
  const actual = await sumEatenForDate(db, client.id, yesterday);
  const surplus = round1(actual - liveBase.calories);
  if (surplus <= BALANCE_CONFIG.SURPLUS_PROMPT_THRESHOLD) return null;
  const declined = await isDeclined(db, client.id, yesterday);
  return { sourceDate: yesterday, surplusCalories: surplus, declined };
}

// Advance an ACTIVE plan by exactly one completed calendar day (if one is
// due). Settles that day's planned paydown, folds in any NEW surplus that
// day itself generated (Section 9's dynamic rebalancing), and recomputes
// a fresh schedule for whatever balance remains via the same pure
// calculation used at plan-creation time. Returns
// { plan, justCompleted, justExpired }.
export async function reconcileActivePlan(db, client, tz) {
  const active = await getActivePlan(db, client.id);
  if (!active) return { plan: null, justCompleted: false, justExpired: false };

  const today = dayKey(new Date(), tz);

  // Safety valve: a plan untouched for longer than the longest any plan
  // is ever allowed to run has been abandoned (see this module's header
  // comment). Expire it outright rather than trying to catch it up one
  // day at a time, or leaving it ACTIVE forever.
  if (daysBetween(active.last_reconciled_date, today) > BALANCE_CONFIG.MAX_PLAN_DURATION_DAYS) {
    await db.run(`UPDATE nutrition_balance_adjustments SET status = 'EXPIRED', updated_at = ? WHERE id = ?`, [now(), active.id]);
    return { plan: null, justCompleted: false, justExpired: true };
  }

  const nextDay = dayKey(addDays(active.last_reconciled_date + 'T00:00:00Z', 1), tz);
  if (nextDay >= today) return { plan: active, justCompleted: false, justExpired: false };

  const dayTotal = await sumEatenForDate(db, client.id, nextDay);
  const settle = Math.min(active.remaining_surplus_calories, active.daily_adjustment_calories);
  let remaining = Math.max(0, round1(active.remaining_surplus_calories - settle));
  const newSurplus = round1(dayTotal - active.base_calorie_target);
  let sourceDate = active.source_date;
  // originalSurplusCalories tracks the CUMULATIVE total this plan has ever
  // absorbed (merges included) -- must grow here too, not just in
  // applyFlexibleCaloriePlan's own merge branch, or a plan that
  // auto-absorbs a second day's surplus via reconcile (Section 9's
  // "merge automatically, no re-prompt" path) would silently under-report
  // its own history/total.
  let originalTotal = active.original_surplus_calories;
  if (newSurplus > BALANCE_CONFIG.SURPLUS_PROMPT_THRESHOLD) {
    remaining = round1(remaining + newSurplus);
    originalTotal = round1(originalTotal + newSurplus);
    sourceDate = nextDay;
  }

  // Record what was actually observed for nextDay -- this is what lets a
  // LATER edit/delete of a food log on this exact date retroactively
  // correct the plan (recalculateForEditedDate below), instead of the
  // balance silently drifting from what the client already saw.
  await recordSettledDay(db, active.id, nextDay, active.base_calorie_target, settle, newSurplus > BALANCE_CONFIG.SURPLUS_PROMPT_THRESHOLD ? newSurplus : 0, dayTotal);

  if (remaining <= 0) {
    await db.run(
      `UPDATE nutrition_balance_adjustments SET status = 'COMPLETED', remaining_surplus_calories = 0, remaining_days = 0, last_reconciled_date = ?, updated_at = ? WHERE id = ?`,
      [nextDay, now(), active.id],
    );
    return { plan: null, justCompleted: true, justExpired: false };
  }

  const recalced = calculateFlexibleCaloriePlan({
    baseCalorieTarget: active.base_calorie_target, proteinTarget: active.base_protein_target,
    carbsTarget: active.base_carbs_target, fatTarget: active.base_fat_target,
    surplusCalories: remaining, strategy: active.strategy,
  });
  await db.run(
    `UPDATE nutrition_balance_adjustments SET
       original_surplus_calories = ?, remaining_surplus_calories = ?, planned_days = ?, remaining_days = ?, daily_adjustment_calories = ?,
       adjusted_calorie_target = ?, adjusted_protein_target = ?, adjusted_carbs_target = ?, adjusted_fat_target = ?,
       source_date = ?, last_reconciled_date = ?, updated_at = ?
     WHERE id = ?`,
    [originalTotal, remaining, recalced.plannedDays, recalced.plannedDays, recalced.dailyAdjustmentCalories,
      recalced.adjustedCalorieTarget, recalced.macros.protein, recalced.macros.carbs, recalced.macros.fat,
      sourceDate, nextDay, now(), active.id],
  );
  const plan = await db.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [active.id]);
  return { plan, justCompleted: false, justExpired: false };
}

async function recordSettledDay(db, adjustmentId, date, baseTarget, settledAmount, daySurplus, actualCalories) {
  const ts = now();
  await db.run(
    `INSERT INTO nutrition_balance_adjustment_days (id, adjustment_id, date, base_target, settled_amount, day_surplus, actual_calories, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(adjustment_id, date) DO UPDATE SET
       settled_amount = excluded.settled_amount, day_surplus = excluded.day_surplus,
       actual_calories = excluded.actual_calories, updated_at = excluded.updated_at`,
    [id('nbad'), adjustmentId, date, baseTarget, settledAmount, daySurplus, actualCalories, ts, ts],
  );
}

// Retroactive correction: called after a food-log entry is created,
// edited, or deleted for `date`. If `date` was already settled under an
// ACTIVE plan (a row exists in nutrition_balance_adjustment_days), the
// plan's remaining balance is corrected by exactly the delta between what
// was observed then and what's true now, then a fresh schedule is
// computed for the corrected balance -- the same pure calculation used
// everywhere else in this module, never a bespoke one-off adjustment.
//
// Deliberately scoped to ACTIVE plans only: a COMPLETED/CANCELLED/
// DECLINED plan has no forward-looking effect on anything the client will
// see next, so "recalculating" one would just rewrite history with no
// observable consequence -- not worth the risk of quietly resurrecting a
// plan a client already moved past. A safe, near-zero-cost no-op for the
// overwhelmingly common case (editing today's own log, which was never
// "settled" in the first place, since only PAST completed days get a
// nutrition_balance_adjustment_days row).
export async function recalculateForEditedDate(db, client, date) {
  const dayRow = await db.q1(
    `SELECT d.*, a.id as plan_id, a.remaining_surplus_calories, a.original_surplus_calories,
            a.base_calorie_target, a.base_protein_target, a.base_carbs_target, a.base_fat_target, a.strategy
       FROM nutrition_balance_adjustment_days d
       JOIN nutrition_balance_adjustments a ON a.id = d.adjustment_id
      WHERE d.date = ? AND a.client_id = ? AND a.status = 'ACTIVE'
      ORDER BY d.created_at DESC LIMIT 1`,
    [date, client.id],
  );
  if (!dayRow) return null;

  const newActual = await sumEatenForDate(db, client.id, date);
  if (newActual === dayRow.actual_calories) return null;

  const newDaySurplus = round1(newActual - dayRow.base_target) > BALANCE_CONFIG.SURPLUS_PROMPT_THRESHOLD
    ? round1(newActual - dayRow.base_target) : 0;
  const delta = round1(newDaySurplus - dayRow.day_surplus);
  if (delta === 0) {
    await db.run('UPDATE nutrition_balance_adjustment_days SET actual_calories = ?, updated_at = ? WHERE id = ?', [newActual, now(), dayRow.id]);
    return null;
  }

  const remaining = Math.max(0, round1(dayRow.remaining_surplus_calories + delta));
  // A downward correction (food removed/reduced) isn't "less surplus was
  // ever absorbed" -- it's "this day's contribution was overstated" --
  // so original_surplus_calories (a historical high-water mark) only
  // grows on a genuine increase, never shrinks on a deletion.
  const originalTotal = delta > 0 ? round1(dayRow.original_surplus_calories + delta) : dayRow.original_surplus_calories;

  await db.run('UPDATE nutrition_balance_adjustment_days SET day_surplus = ?, actual_calories = ?, updated_at = ? WHERE id = ?',
    [newDaySurplus, newActual, now(), dayRow.id]);

  if (remaining <= 0) {
    await db.run(`UPDATE nutrition_balance_adjustments SET status = 'COMPLETED', remaining_surplus_calories = 0, remaining_days = 0, updated_at = ? WHERE id = ?`, [now(), dayRow.plan_id]);
    return { planId: dayRow.plan_id, closed: true };
  }

  const recalced = calculateFlexibleCaloriePlan({
    baseCalorieTarget: dayRow.base_calorie_target, proteinTarget: dayRow.base_protein_target,
    carbsTarget: dayRow.base_carbs_target, fatTarget: dayRow.base_fat_target,
    surplusCalories: remaining, strategy: dayRow.strategy,
  });
  await db.run(
    `UPDATE nutrition_balance_adjustments SET
       original_surplus_calories = ?, remaining_surplus_calories = ?, planned_days = ?, remaining_days = ?, daily_adjustment_calories = ?,
       adjusted_calorie_target = ?, adjusted_protein_target = ?, adjusted_carbs_target = ?, adjusted_fat_target = ?, updated_at = ?
     WHERE id = ?`,
    [originalTotal, remaining, recalced.plannedDays, recalced.plannedDays, recalced.dailyAdjustmentCalories,
      recalced.adjustedCalorieTarget, recalced.macros.protein, recalced.macros.carbs, recalced.macros.fat, now(), dayRow.plan_id],
  );
  return { planId: dayRow.plan_id, closed: false };
}

// Persist a confirmed plan. Merges into an existing ACTIVE plan instead of
// creating a second one (Section 9/21) — the check-then-write happens
// inside one transaction so two concurrent apply calls can't both create a
// row. This is the ONLY function in this module that mutates
// nutrition_balance_adjustments outside of reconcileActivePlan.
export async function applyFlexibleCaloriePlan(db, { orgId, clientId, sourceDate, surplusCalories, strategy, baseTargets }) {
  return db.tx(async (tx) => {
    const existing = await tx.q1(`SELECT * FROM nutrition_balance_adjustments WHERE client_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [clientId]);
    const totalSurplus = round1((existing ? existing.remaining_surplus_calories : 0) + surplusCalories);
    const calc = calculateFlexibleCaloriePlan({
      baseCalorieTarget: baseTargets.calories, proteinTarget: baseTargets.protein,
      carbsTarget: baseTargets.carbs, fatTarget: baseTargets.fat,
      surplusCalories: totalSurplus, strategy,
    });
    const ts = now();
    if (existing) {
      await tx.run(
        `UPDATE nutrition_balance_adjustments SET
           original_surplus_calories = original_surplus_calories + ?, remaining_surplus_calories = ?,
           strategy = ?, planned_days = ?, remaining_days = ?, daily_adjustment_calories = ?,
           base_calorie_target = ?, base_protein_target = ?, base_carbs_target = ?, base_fat_target = ?,
           adjusted_calorie_target = ?, adjusted_protein_target = ?, adjusted_carbs_target = ?, adjusted_fat_target = ?,
           source_date = ?, updated_at = ?
         WHERE id = ?`,
        [surplusCalories, totalSurplus, strategy, calc.plannedDays, calc.plannedDays, calc.dailyAdjustmentCalories,
          baseTargets.calories, baseTargets.protein, baseTargets.carbs, baseTargets.fat,
          calc.adjustedCalorieTarget, calc.macros.protein, calc.macros.carbs, calc.macros.fat,
          sourceDate, ts, existing.id],
      );
      return tx.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [existing.id]);
    }
    const rowId = id('nba');
    await tx.run(
      `INSERT INTO nutrition_balance_adjustments (
         id, org_id, client_id, source_date, original_surplus_calories, remaining_surplus_calories,
         strategy, planned_days, remaining_days, daily_adjustment_calories,
         base_calorie_target, base_protein_target, base_carbs_target, base_fat_target,
         adjusted_calorie_target, adjusted_protein_target, adjusted_carbs_target, adjusted_fat_target,
         status, last_reconciled_date, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rowId, orgId, clientId, sourceDate, totalSurplus, totalSurplus,
        strategy, calc.plannedDays, calc.plannedDays, calc.dailyAdjustmentCalories,
        baseTargets.calories, baseTargets.protein, baseTargets.carbs, baseTargets.fat,
        calc.adjustedCalorieTarget, calc.macros.protein, calc.macros.carbs, calc.macros.fat,
        'ACTIVE', sourceDate, ts, ts],
    );
    return tx.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [rowId]);
  });
}

// Idempotent — a retried decline for the same day is a no-op, not an error.
export async function declineSurplus(db, { orgId, clientId, sourceDate }) {
  if (await isDeclined(db, clientId, sourceDate)) return;
  try {
    await db.run(
      `INSERT INTO nutrition_balance_prompts (id, org_id, client_id, source_date, decision, created_at) VALUES (?,?,?,?,?,?)`,
      [id('nbp'), orgId, clientId, sourceDate, 'DECLINED', now()],
    );
  } catch {
    // Unique index (client_id, source_date) race — another concurrent
    // decline for the same day already won. Fine, same end state.
  }
}

export async function cancelActivePlan(db, clientId) {
  await db.run(`UPDATE nutrition_balance_adjustments SET status = 'CANCELLED', updated_at = ? WHERE client_id = ? AND status = 'ACTIVE'`, [now(), clientId]);
}

// Rebuild an active plan's schedule against the client's NEW live base
// target, keeping the remaining balance and strategy (the "Recalculate"
// side of Section 17's target-changed prompt; "Cancel adjustment" reuses
// cancelActivePlan above instead).
export async function recalculatePlanForNewBaseTargets(db, clientId, liveBase) {
  const active = await getActivePlan(db, clientId);
  if (!active) return null;
  const calc = calculateFlexibleCaloriePlan({
    baseCalorieTarget: liveBase.calories, proteinTarget: liveBase.protein,
    carbsTarget: liveBase.carbs, fatTarget: liveBase.fat,
    surplusCalories: active.remaining_surplus_calories, strategy: active.strategy,
  });
  await db.run(
    `UPDATE nutrition_balance_adjustments SET
       base_calorie_target = ?, base_protein_target = ?, base_carbs_target = ?, base_fat_target = ?,
       planned_days = ?, remaining_days = ?, daily_adjustment_calories = ?,
       adjusted_calorie_target = ?, adjusted_protein_target = ?, adjusted_carbs_target = ?, adjusted_fat_target = ?,
       updated_at = ?
     WHERE id = ?`,
    [liveBase.calories, liveBase.protein, liveBase.carbs, liveBase.fat,
      calc.plannedDays, calc.plannedDays, calc.dailyAdjustmentCalories,
      calc.adjustedCalorieTarget, calc.macros.protein, calc.macros.carbs, calc.macros.fat,
      now(), active.id],
  );
  return db.q1('SELECT * FROM nutrition_balance_adjustments WHERE id = ?', [active.id]);
}

// "A simple view listing Completed/Declined/Active plans" -- Active is
// handled separately by GET /me/nutrition/balance's own `activePlan`;
// this covers Completed/Cancelled/Expired (real rows in
// nutrition_balance_adjustments) AND Declined, which deliberately never
// becomes a row in that table (see schema.sql's own comment on why
// nutrition_balance_prompts is kept separate) -- so a client's full
// history needs both sources merged, not just the first.
export async function getPlanHistory(db, clientId, limit = 20) {
  const cap = Math.max(1, Math.min(100, limit));
  const [plans, declines] = await Promise.all([
    db.q(`SELECT * FROM nutrition_balance_adjustments WHERE client_id = ? AND status != 'ACTIVE' ORDER BY updated_at DESC LIMIT ?`, [clientId, cap]),
    db.q(`SELECT * FROM nutrition_balance_prompts WHERE client_id = ? AND decision = 'DECLINED' ORDER BY created_at DESC LIMIT ?`, [clientId, cap]),
  ]);
  const items = [
    ...plans.map((p) => ({ ...serializePlan(p), type: 'plan' })),
    ...declines.map((d) => ({
      id: d.id, type: 'declined', status: 'DECLINED', sourceDate: d.source_date,
      strategy: null, originalSurplusCalories: null, remainingSurplusCalories: null,
      plannedDays: null, remainingDays: null, dailyAdjustmentCalories: null,
      baseCalorieTarget: null, baseProteinTarget: null, baseCarbsTarget: null, baseFatTarget: null,
      adjustedCalorieTarget: null, adjustedProteinTarget: null, adjustedCarbsTarget: null, adjustedFatTarget: null,
      createdAt: d.created_at, updatedAt: d.created_at,
    })),
  ];
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return items.slice(0, cap);
}

// Shape a raw db row for API responses (snake_case columns -> camelCase).
export function serializePlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceDate: row.source_date,
    status: row.status,
    strategy: row.strategy,
    originalSurplusCalories: row.original_surplus_calories,
    remainingSurplusCalories: row.remaining_surplus_calories,
    plannedDays: row.planned_days,
    remainingDays: row.remaining_days,
    dailyAdjustmentCalories: row.daily_adjustment_calories,
    baseCalorieTarget: row.base_calorie_target,
    baseProteinTarget: row.base_protein_target,
    baseCarbsTarget: row.base_carbs_target,
    baseFatTarget: row.base_fat_target,
    adjustedCalorieTarget: row.adjusted_calorie_target,
    adjustedProteinTarget: row.adjusted_protein_target,
    adjustedCarbsTarget: row.adjusted_carbs_target,
    adjustedFatTarget: row.adjusted_fat_target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
