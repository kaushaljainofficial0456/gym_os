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
