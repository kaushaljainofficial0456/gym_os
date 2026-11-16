// ============================================================
// NUTRITION TARGETS — daily calorie + macro suggestion, with safeguards.
//
// Moved out of routes/me.js (GET /me/nutrition/targets) so the arithmetic
// and the safety rules are pure and tested. For a typical adult the numbers
// are UNCHANGED from the previous inline version:
//
//   BMR       Mifflin-St Jeor (services/intelligence/restingEnergy.js)
//   TDEE      BMR x activity multiplier: the person's own ACTIVITY LEVEL
//             when they have set one (Phase 2: sedentary 1.2 / light 1.375 /
//             moderate 1.55 / active 1.725 / very active 1.9), otherwise --
//             exactly as before -- from training EXPERIENCE (beginner 1.375 /
//             intermediate 1.55 / advanced 1.725). Which one was used is
//             stated in `assumptions`.
//   goal      fat loss -350 kcal, muscle gain +300, strength +200, else 0
//   protein   1.8-2.2 g per kg of estimated lean mass (0.82 x weight)
//   fat       25-28% of energy; carbs the remainder
//
// SAFEGUARDS (new). These are not medical advice; they stop the app from
// handing out a number it should not:
//   - Under 18: no deficit or surplus. Growing bodies need energy; diet
//     changes for minors belong with a paediatrician / registered dietitian.
//   - BMI under 18.5 asking for fat loss: no deficit.
//   - BMI 30 or more: protein from ADJUSTED body weight (the BMI-25 weight
//     plus 25% of the excess), the convention used in clinical dietetics,
//     because grams per kg of total weight overshoots badly at high weights.
//   - Medical notes on the profile: targets are flagged as general.
//   - Any floor that raises a macro also raises calories, so the stated
//     calories always equal 4 x protein + 4 x carbs + 9 x fat (within
//     rounding) -- the old code could state calories its own macros
//     contradicted.
// ============================================================
'use strict';

import { mifflinStJeorBmr } from '../intelligence/restingEnergy.js';

export const ACTIVITY_BY_EXPERIENCE = Object.freeze({ BEGINNER: 1.375, INTERMEDIATE: 1.55, ADVANCED: 1.725 });
/** Standard physical-activity multipliers for total daily energy. */
export const ACTIVITY_LEVELS = Object.freeze({ SEDENTARY: 1.2, LIGHT: 1.375, MODERATE: 1.55, ACTIVE: 1.725, VERY_ACTIVE: 1.9 });
const ACTIVITY_WORDS = { SEDENTARY: 'mostly sitting', LIGHT: 'lightly active', MODERATE: 'moderately active', ACTIVE: 'very active', VERY_ACTIVE: 'extremely active' };
export const GOAL_ADJUST_KCAL = Object.freeze({ FAT_LOSS: -350, MUSCLE_GAIN: 300, RECOMP: 0, STRENGTH: 200, GENERAL: 0 });
export const CALORIE_FLOOR = 1200;
export const CALORIE_CEILING = 6000;
export const MACRO_FLOOR = Object.freeze({ protein: 50, carbs: 50, fat: 30 });

export const TARGETS_DISCLAIMER = 'A general starting point from standard equations, not medical or dietetic advice. '
  + 'If you are pregnant or breastfeeding, under 18, have a medical condition or take medication that affects appetite or weight, '
  + 'check these targets with a doctor or registered dietitian.';

/**
 * @param {{weight:number, height:number, age:number, sex:string, goal?:string,
 *          experience?:string, medicalNotes?:string|null}} p
 * @returns {{targets:{calories:number,protein:number,carbs:number,fat:number},
 *            meta:object, safety:{warnings:string[], adjustments:string[]},
 *            assumptions:string[], disclaimer:string}}
 */
export function computeTargets({ weight, height, age, sex, goal = 'GENERAL', experience = 'INTERMEDIATE', activityLevel = null, medicalNotes = null }) {
  const warnings = [];
  const adjustments = [];
  const exp = String(experience || 'INTERMEDIATE').toUpperCase();
  const g = String(goal || 'GENERAL').toUpperCase();
  const level = activityLevel ? String(activityLevel).toUpperCase() : null;
  const bmr = mifflinStJeorBmr({ weightKg: weight, heightCm: height, age, sex });
  const fromLevel = level && ACTIVITY_LEVELS[level] != null;
  const activityMultiplier = fromLevel ? ACTIVITY_LEVELS[level] : (ACTIVITY_BY_EXPERIENCE[exp] || 1.55);
  const bmi = height > 0 ? weight / ((height / 100) ** 2) : null;

  let goalAdjust = GOAL_ADJUST_KCAL[g] || 0;
  if (age < 18 && goalAdjust !== 0) {
    goalAdjust = 0;
    adjustments.push('No calorie deficit or surplus under 18 — targets are set for maintenance.');
    warnings.push('Under 18: talk to a paediatrician or registered dietitian before changing how much you eat.');
  }
  if (g === 'FAT_LOSS' && bmi != null && bmi < 18.5 && goalAdjust < 0) {
    goalAdjust = 0;
    adjustments.push(`No calorie deficit at a BMI of ${bmi.toFixed(1)} (under 18.5) — targets are set for maintenance.`);
    warnings.push('Your weight is already in the underweight range. A doctor or dietitian should guide any weight change.');
  }

  let calories = Math.round(bmr * activityMultiplier) + goalAdjust;
  if (calories < CALORIE_FLOOR) {
    adjustments.push(`Raised to the ${CALORIE_FLOOR} kcal minimum; going lower needs professional supervision.`);
    calories = CALORIE_FLOOR;
  }
  calories = Math.min(calories, CALORIE_CEILING);

  // Protein basis: estimated lean mass, from ADJUSTED weight at BMI >= 30.
  let proteinBasisKg = weight;
  if (bmi != null && bmi >= 30) {
    const refWeight = 25 * (height / 100) ** 2;
    proteinBasisKg = refWeight + 0.25 * (weight - refWeight);
    adjustments.push(`Protein is based on an adjusted body weight of ${Math.round(proteinBasisKg)} kg (BMI ${bmi.toFixed(1)}).`);
  }
  const leanMass = proteinBasisKg * 0.82;

  let protein; let fat;
  if (g === 'MUSCLE_GAIN' || g === 'STRENGTH') {
    protein = Math.round(leanMass * 2.0);
    fat = Math.round((calories * 0.25) / 9);
  } else if (g === 'FAT_LOSS') {
    protein = Math.round(leanMass * 2.2);
    fat = Math.round((calories * 0.25) / 9);
  } else {
    protein = Math.round(leanMass * 1.8);
    fat = Math.round((calories * 0.28) / 9);
  }
  let carbs = Math.round((calories - protein * 4 - fat * 9) / 4);

  const floored = protein < MACRO_FLOOR.protein || carbs < MACRO_FLOOR.carbs || fat < MACRO_FLOOR.fat;
  protein = Math.max(protein, MACRO_FLOOR.protein);
  carbs = Math.max(carbs, MACRO_FLOOR.carbs);
  fat = Math.max(fat, MACRO_FLOOR.fat);
  if (floored) {
    // Keep the numbers honest with each other: the floors raised a macro,
    // so the calories it implies are the calories stated.
    calories = Math.round(protein * 4 + carbs * 4 + fat * 9);
    adjustments.push('A macro was raised to its minimum, so calories were recalculated to match.');
  }

  if (medicalNotes && String(medicalNotes).trim()) {
    warnings.push('Your profile has medical notes. These targets do not take them into account — check them with your doctor or dietitian.');
  }

  return {
    targets: { calories, protein, carbs, fat },
    meta: {
      bmr: Math.round(bmr), activityMultiplier, activityLevel: fromLevel ? level : null,
      activitySource: fromLevel ? 'activity_level' : 'experience',
      experience: exp, goal: g, bmi: bmi == null ? null : Math.round(bmi * 10) / 10,
    },
    safety: { warnings, adjustments },
    assumptions: [
      'Resting energy: Mifflin-St Jeor equation.',
      fromLevel
        ? `Activity: ×${activityMultiplier}, from the activity level you set (${ACTIVITY_WORDS[level]}).`
        : `Activity: ×${activityMultiplier}, taken from your training experience (${exp.toLowerCase()}) — set your activity level if your day is very different.`,
      `Goal adjustment: ${goalAdjust >= 0 ? '+' : ''}${goalAdjust} kcal/day.`,
      'Protein from estimated lean mass; fat 25–28% of energy; carbs make up the rest.',
    ],
    disclaimer: TARGETS_DISCLAIMER,
  };
}
