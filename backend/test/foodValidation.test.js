// ============================================================
// Unit tests for the foods-table write-path validator (Phase 12 of the SK
// OS Indian Nutrition Engine upgrade). These assert CORRECT behavior
// against known-good and known-bad inputs, not "whatever the code
// currently returns".
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFoodRecord } from '../src/services/foodValidation.js';

test('a normal, well-formed record is valid with no warnings', () => {
  const r = validateFoodRecord({ name: 'Chapati', energy_kcal: 297, protein_g: 7.9, carb_g: 60.9, fat_g: 3.7, fiber_g: 1.8 });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('missing name is rejected', () => {
  const r = validateFoodRecord({ energy_kcal: 100 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /name/i.test(e)));
});

test('blank/whitespace-only name is rejected', () => {
  const r = validateFoodRecord({ name: '   ', energy_kcal: 100 });
  assert.equal(r.valid, false);
});

test('negative values are rejected for every macro field, not just energy', () => {
  for (const field of ['energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg']) {
    const r = validateFoodRecord({ name: 'Test food', [field]: -1 });
    assert.equal(r.valid, false, `${field} = -1 should be rejected`);
    assert.ok(r.errors.some((e) => e.includes(field)), `error should name ${field}, got: ${r.errors}`);
  }
});

test('non-numeric macro values are rejected, not coerced to 0 or NaN', () => {
  const r = validateFoodRecord({ name: 'Test food', energy_kcal: 'a lot' });
  assert.equal(r.valid, false);
});

test('a zero value is valid (zero-calorie foods like water are real)', () => {
  const r = validateFoodRecord({ name: 'Water', energy_kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0 });
  assert.equal(r.valid, true);
});

test('absent fields are treated as "not measured", never as invalid or as zero', () => {
  const r = validateFoodRecord({ name: 'Partial data food', energy_kcal: 100 });
  assert.equal(r.valid, true, 'missing protein/carb/fat must not fail validation');
});

test('macro grams summing past 100 is NOT rejected -- protein+carbs+fat is not required to equal any reference weight', () => {
  // Regression test for the removed "impossible" check: this function has
  // no way to know what quantity the caller's numbers describe (a Custom
  // Macros entry for a 40g chapati legitimately has protein+carbs+fat far
  // below 40; a converted-to-per-100g concentrated food can legitimately
  // read well above 100 without being physically impossible). Never
  // reinstate an equality/upper-bound check between macro grams and a
  // serving/reference weight -- see foodValidation.js's own comment.
  const r = validateFoodRecord({ name: 'Concentrated food', energy_kcal: 780, protein_g: 50, carb_g: 40, fat_g: 20 });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('the 40g chapati Custom Macros example is valid: protein+carbs+fat (23g) need not equal the 40g reference weight', () => {
  // protein 3 * 4 + carbs 18 * 4 + fat 2 * 9 = 12 + 72 + 18 = 102 kcal.
  const r = validateFoodRecord({ name: 'Chapati (custom)', energy_kcal: 102, protein_g: 3, carb_g: 18, fat_g: 2 });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('energy wildly inconsistent with its own macros is flagged as a warning, not silently accepted or auto-corrected', () => {
  // 10 g protein + 10 g carb + 10 g fat = 170 kcal by Atwater; declaring 900 kcal is off by >400%.
  const r = validateFoodRecord({ name: 'Mislabeled food', energy_kcal: 900, protein_g: 10, carb_g: 10, fat_g: 10 });
  assert.equal(r.valid, true, 'a warning must not by itself reject the record');
  assert.ok(r.warnings.length >= 1, 'inconsistency must be surfaced, not hidden');
});

test('energy consistent with macros within rounding tolerance produces no warning', () => {
  // Real IFCT chapati-like values: protein 7.9*4 + carb 60.9*4 + fat 3.7*9 = 308 kcal vs declared 297 -- ~3.7% off.
  const r = validateFoodRecord({ name: 'Chapati', energy_kcal: 297, protein_g: 7.9, carb_g: 60.9, fat_g: 3.7 });
  assert.deepEqual(r.warnings, []);
});
