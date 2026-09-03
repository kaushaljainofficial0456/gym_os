// ============================================================
// calculateFlexibleCaloriePlan() — pure-function unit tests. No db, no
// app, no fixtures: this is the safety-critical core of the Flexible
// Calorie Balance feature (backend/src/services/nutrition/
// flexibleBalance.js), so it gets tested in complete isolation from
// persistence. Integration/endpoint behavior is covered separately in
// flexibleBalanceRoutes.test.js.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFlexibleCaloriePlan, BALANCE_CONFIG } from '../src/services/nutrition/flexibleBalance.js';

const kcalFromMacros = (m) => m.protein * 4 + m.carbs * 4 + m.fat * 9;

test('zero/negative surplus is a no-op — base target untouched', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 65,
    surplusCalories: 0, strategy: 'EASY',
  });
  assert.equal(r.feasible, true);
  assert.equal(r.plannedDays, 0);
  assert.equal(r.dailyAdjustmentCalories, 0);
  assert.equal(r.adjustedCalorieTarget, 2000);
});

test('EASY strategy spreads a modest surplus over its own minimum days, protein untouched', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 65,
    surplusCalories: 500, strategy: 'EASY',
  });
  assert.equal(r.feasible, true);
  assert.equal(r.plannedDays, BALANCE_CONFIG.STRATEGIES.EASY.minDays);
  assert.equal(r.dailyAdjustmentCalories, 100);
  assert.equal(r.adjustedCalorieTarget, 1900);
  assert.equal(r.macros.protein, 150); // protein floor: never reduced
  assert.equal(r.extended, false);
});

test('every strategy stays internally consistent with the 4/4/9 rule', () => {
  for (const strategy of Object.keys(BALANCE_CONFIG.STRATEGIES)) {
    const r = calculateFlexibleCaloriePlan({
      baseCalorieTarget: 2200, proteinTarget: 160, carbsTarget: 220, fatTarget: 70,
      surplusCalories: 400, strategy,
    });
    assert.equal(r.feasible, true, strategy);
    const derived = kcalFromMacros(r.macros);
    assert.ok(Math.abs(derived - r.adjustedCalorieTarget) <= 1,
      `${strategy}: macros (${derived} kcal) must match adjustedCalorieTarget (${r.adjustedCalorieTarget})`);
  }
});

test('a large surplus auto-extends duration past the strategy\'s own max, never below MIN_CALORIE_TARGET', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 1400, proteinTarget: 100, carbsTarget: 150, fatTarget: 45,
    surplusCalories: 900, strategy: 'INTENSE',
  });
  assert.equal(r.feasible, true);
  assert.ok(r.plannedDays > BALANCE_CONFIG.STRATEGIES.INTENSE.maxDays,
    `expected extension past INTENSE's own max (${BALANCE_CONFIG.STRATEGIES.INTENSE.maxDays}), got ${r.plannedDays}`);
  assert.equal(r.extended, true);
  assert.ok(r.adjustedCalorieTarget >= BALANCE_CONFIG.MIN_CALORIE_TARGET);
});

test('no single day\'s cut exceeds MAX_DAILY_ADJUSTMENT_FRACTION of the base target', () => {
  for (const strategy of Object.keys(BALANCE_CONFIG.STRATEGIES)) {
    for (const surplus of [200, 600, 1200, 3000]) {
      const r = calculateFlexibleCaloriePlan({
        baseCalorieTarget: 2000, proteinTarget: 140, carbsTarget: 200, fatTarget: 60,
        surplusCalories: surplus, strategy,
      });
      if (!r.feasible) continue;
      assert.ok(r.dailyAdjustmentCalories <= 2000 * BALANCE_CONFIG.MAX_DAILY_ADJUSTMENT_FRACTION + 1e-9,
        `${strategy}/${surplus}: daily cut ${r.dailyAdjustmentCalories} exceeds the safe ceiling`);
      assert.ok(r.adjustedCalorieTarget >= BALANCE_CONFIG.MIN_CALORIE_TARGET,
        `${strategy}/${surplus}: adjusted target ${r.adjustedCalorieTarget} below the safety floor`);
    }
  }
});

test('an enormous surplus against a near-floor base target is reported infeasible, not force-compensated', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 1250, proteinTarget: 90, carbsTarget: 130, fatTarget: 40,
    surplusCalories: 5000, strategy: 'MODERATE',
  });
  assert.equal(r.feasible, false);
  assert.equal(r.adjustedCalorieTarget, 1250); // base target left untouched
  assert.match(r.message, /larger than we can safely redistribute/);
});

test('protein protection can override the naive target arithmetic rather than ever reducing protein', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 1400, proteinTarget: 285, carbsTarget: 100, fatTarget: 40,
    surplusCalories: 300, strategy: 'EASY',
  });
  assert.equal(r.feasible, true);
  assert.equal(r.macros.protein, 285); // exactly the input protein target -- never reduced
  assert.ok(r.adjustedCalorieTarget >= r.macros.protein * 4 + BALANCE_CONFIG.FAT_FLOOR_G * 9 + BALANCE_CONFIG.CARBS_FLOOR_G * 4 - 1);
});

test('fat and carbs never drop below their configured floors', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 1600, proteinTarget: 130, carbsTarget: 250, fatTarget: 70,
    surplusCalories: 2000, strategy: 'INTENSE',
  });
  if (r.feasible) {
    assert.ok(r.macros.carbs >= BALANCE_CONFIG.CARBS_FLOOR_G - 1e-9);
    assert.ok(r.macros.fat >= BALANCE_CONFIG.FAT_FLOOR_G - 1e-9);
  }
});

test('an unknown strategy throws rather than silently defaulting', () => {
  assert.throws(() => calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 65,
    surplusCalories: 300, strategy: 'YOLO',
  }));
});

// A base target already at/below MIN_CALORIE_TARGET (e.g. a client-edited
// target of P20/C45/F15 = 395 kcal, well under the 1200 floor) has zero
// room to redistribute at all -- distinct from "the surplus is too big"
// (caught live: every strategy reported the generic "balance is larger
// than we can safely redistribute" message with no way to tell the two
// cases apart, for a surplus that was actually a completely normal size).
test('a base target already at or below MIN_CALORIE_TARGET is reported with its own distinct reason, for every strategy', () => {
  for (const strategy of Object.keys(BALANCE_CONFIG.STRATEGIES)) {
    const r = calculateFlexibleCaloriePlan({
      baseCalorieTarget: 395, proteinTarget: 20, carbsTarget: 45, fatTarget: 15,
      surplusCalories: 500, strategy,
    });
    assert.equal(r.feasible, false, strategy);
    assert.equal(r.baseTargetTooLow, true, strategy);
    assert.equal(r.adjustedCalorieTarget, 395); // base target left completely untouched
    assert.match(r.message, /already at or below a safe minimum/);
  }
});

test('a base target exactly at MIN_CALORIE_TARGET also reports baseTargetTooLow (boundary is inclusive)', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: BALANCE_CONFIG.MIN_CALORIE_TARGET, proteinTarget: 100, carbsTarget: 150, fatTarget: 40,
    surplusCalories: 300, strategy: 'EASY',
  });
  assert.equal(r.baseTargetTooLow, true);
});

test('a base target just above MIN_CALORIE_TARGET is NOT flagged baseTargetTooLow', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: BALANCE_CONFIG.MIN_CALORIE_TARGET + 50, proteinTarget: 100, carbsTarget: 150, fatTarget: 40,
    surplusCalories: 200, strategy: 'EASY',
  });
  assert.equal(r.baseTargetTooLow, undefined);
});

// ---- CUSTOM strategy: user-chosen duration + protein target ----

test('CUSTOM respects the requested day count when it is safely feasible', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 160, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 600, strategy: 'CUSTOM', customDays: 6, customProteinTarget: 160,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.plannedDays, 6);
  assert.equal(r.extended, false);
});

test('CUSTOM auto-extends past the requested day count when it would otherwise violate the safety ceiling -- a custom choice is still just a preference, never a bypass', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2000, proteinTarget: 150, carbsTarget: 200, fatTarget: 65,
    surplusCalories: 2000, strategy: 'CUSTOM', customDays: 2, customProteinTarget: 150,
  });
  assert.equal(r.feasible, true);
  assert.ok(r.plannedDays > 2, `expected extension past the requested 2 days, got ${r.plannedDays}`);
  assert.equal(r.extended, true);
  assert.ok(r.adjustedCalorieTarget >= BALANCE_CONFIG.MIN_CALORIE_TARGET);
});

test('CUSTOM protects exactly the user-chosen protein target, not the client\'s existing one', () => {
  const r = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 130, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 500, strategy: 'CUSTOM', customDays: 5, customProteinTarget: 200,
  });
  assert.equal(r.feasible, true);
  assert.equal(r.macros.protein, 200, 'must use the CUSTOM value, not the passed-in proteinTarget of 130');
});

test('CUSTOM protein target is clamped to the same floor/ceiling the app already enforces on manual target edits', () => {
  const tooLow = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 130, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 400, strategy: 'CUSTOM', customDays: 5, customProteinTarget: 1, // absurdly low
  });
  assert.equal(tooLow.macros.protein, BALANCE_CONFIG.MIN_PROTEIN_TARGET_G, 'clamped up to the floor, not accepted as-is');

  const tooHigh = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 130, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 400, strategy: 'CUSTOM', customDays: 5, customProteinTarget: 9999,
  });
  assert.equal(tooHigh.macros.protein, BALANCE_CONFIG.MAX_PROTEIN_TARGET_G, 'clamped down to the ceiling, not accepted as-is');
});

test('CUSTOM day count is clamped within MIN/MAX_PLAN_DURATION_DAYS even when requested outside that range', () => {
  const tooFew = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 130, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 300, strategy: 'CUSTOM', customDays: 0, customProteinTarget: 130,
  });
  assert.ok(tooFew.plannedDays >= BALANCE_CONFIG.MIN_PLAN_DURATION_DAYS);

  const tooMany = calculateFlexibleCaloriePlan({
    baseCalorieTarget: 2200, proteinTarget: 130, carbsTarget: 220, fatTarget: 70,
    surplusCalories: 300, strategy: 'CUSTOM', customDays: 100, customProteinTarget: 130,
  });
  assert.ok(tooMany.plannedDays <= BALANCE_CONFIG.MAX_PLAN_DURATION_DAYS);
});
