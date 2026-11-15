// ============================================================
// NUTRITION TARGETS — equations unchanged for typical adults, plus the
// safeguards added by the nutrition overhaul (services/nutrition/targets.js).
// ============================================================
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTargets, TARGETS_DISCLAIMER } from '../src/services/nutrition/targets.js';
import { mifflinStJeorBmr } from '../src/services/intelligence/restingEnergy.js';

/** The pre-overhaul inline formula from routes/me.js, verbatim in logic. */
function legacy({ weight, height, age, sex, goal, experience }) {
  const bmr = mifflinStJeorBmr({ weightKg: weight, heightCm: height, age, sex });
  const mult = { BEGINNER: 1.375, INTERMEDIATE: 1.55, ADVANCED: 1.725 }[experience] || 1.55;
  let tdee = Math.round(bmr * mult);
  tdee += { FAT_LOSS: -350, MUSCLE_GAIN: 300, RECOMP: 0, STRENGTH: 200, GENERAL: 0 }[goal] || 0;
  tdee = Math.max(1200, Math.min(tdee, 6000));
  const lean = weight * 0.82;
  let p; let c; let f;
  if (goal === 'MUSCLE_GAIN' || goal === 'STRENGTH') { p = Math.round(lean * 2.0); f = Math.round(tdee * 0.25 / 9); }
  else if (goal === 'FAT_LOSS') { p = Math.round(lean * 2.2); f = Math.round(tdee * 0.25 / 9); }
  else { p = Math.round(lean * 1.8); f = Math.round(tdee * 0.28 / 9); }
  c = Math.round((tdee - p * 4 - f * 9) / 4);
  return { calories: tdee, protein: Math.max(p, 50), carbs: Math.max(c, 50), fat: Math.max(f, 30) };
}

const kcalOf = (t) => t.protein * 4 + t.carbs * 4 + t.fat * 9;

test('typical adults get exactly the numbers they got before', () => {
  for (const goal of ['FAT_LOSS', 'MUSCLE_GAIN', 'RECOMP', 'STRENGTH', 'GENERAL']) {
    for (const experience of ['BEGINNER', 'INTERMEDIATE', 'ADVANCED']) {
      for (const p of [{ weight: 75, height: 178, age: 28, sex: 'MALE' }, { weight: 60, height: 162, age: 35, sex: 'FEMALE' }, { weight: 88, height: 183, age: 45, sex: 'MALE' }]) {
        const args = { ...p, goal, experience };
        assert.deepEqual(computeTargets(args).targets, legacy(args), JSON.stringify(args));
      }
    }
  }
});

test('under 18: no deficit or surplus, and a referral', () => {
  const minor = computeTargets({ weight: 55, height: 165, age: 15, sex: 'MALE', goal: 'FAT_LOSS' });
  const asMaintenance = computeTargets({ weight: 55, height: 165, age: 15, sex: 'MALE', goal: 'GENERAL' });
  assert.equal(minor.meta.goal, 'FAT_LOSS');
  assert.ok(Math.abs(minor.targets.calories - asMaintenance.targets.calories) <= 1, 'maintenance energy, not a cut');
  assert.ok(minor.safety.warnings.some((w) => /under 18/i.test(w)));
});

test('underweight + fat loss: no deficit, and a warning', () => {
  const r = computeTargets({ weight: 45, height: 170, age: 25, sex: 'FEMALE', goal: 'FAT_LOSS' });
  assert.ok(r.meta.bmi < 18.5);
  assert.ok(r.assumptions.some((a) => /\+0 kcal/.test(a)));
  assert.ok(r.safety.warnings.some((w) => /underweight/i.test(w)));
});

test('BMI 30+: protein from adjusted body weight, not total weight', () => {
  const r = computeTargets({ weight: 140, height: 175, age: 40, sex: 'MALE', goal: 'FAT_LOSS' });
  const old = legacy({ weight: 140, height: 175, age: 40, sex: 'MALE', goal: 'FAT_LOSS', experience: 'INTERMEDIATE' });
  assert.ok(r.targets.protein < old.protein, `${r.targets.protein} g vs ${old.protein} g`);
  assert.ok(r.targets.protein >= 120 && r.targets.protein <= 200, `${r.targets.protein} g`);
  assert.ok(r.safety.adjustments.some((a) => /adjusted body weight/.test(a)));
});

test('calories always agree with the macros (floors included)', () => {
  const cases = [
    { weight: 40, height: 150, age: 70, sex: 'FEMALE', goal: 'FAT_LOSS', experience: 'BEGINNER' },
    { weight: 75, height: 178, age: 28, sex: 'MALE', goal: 'GENERAL' },
    { weight: 140, height: 175, age: 40, sex: 'MALE', goal: 'MUSCLE_GAIN', experience: 'ADVANCED' },
  ];
  for (const c of cases) {
    const t = computeTargets(c).targets;
    assert.ok(Math.abs(kcalOf(t) - t.calories) <= 6, `${JSON.stringify(c)}: ${kcalOf(t)} vs ${t.calories}`);
  }
});

test('medical notes are acknowledged; the disclaimer and assumptions are always returned', () => {
  const r = computeTargets({ weight: 70, height: 170, age: 50, sex: 'FEMALE', goal: 'GENERAL', medicalNotes: 'type 2 diabetes' });
  assert.ok(r.safety.warnings.some((w) => /medical notes/i.test(w)));
  assert.equal(r.disclaimer, TARGETS_DISCLAIMER);
  assert.match(r.disclaimer, /not medical/);
  assert.ok(r.assumptions.some((a) => /Mifflin-St Jeor/.test(a)));
  assert.ok(r.assumptions.some((a) => /training experience/.test(a)), 'the activity proxy is disclosed');
});
