// ============================================================
// Validation for nutrition data written into the `foods` table — the
// write-side counterpart to skos-food-v1's read-side confidence system.
//
// Applied at every insertion point that accepts caller-supplied macro
// values (a barcode/manual-label product, a client's custom food) so a
// malformed or nonsensical record can never enter a cache every user
// shares, or silently corrupt one client's own logged intake.
//
// SK OS Indian Nutrition Engine upgrade, Phase 12: reject invalid data
// outright rather than "repairing" it — a repaired number is an invented
// number wearing the original's name. Field names follow the skos-food-v1
// convention (energy_kcal / protein_g / carb_g / fat_g / fiber_g / sugar_g
// / sodium_mg) since that is the shape barcodeLookup.js already produces;
// callers using the legacy calories/protein/carbs/fat column names map
// into this shape at the call site.
// ============================================================
'use strict';

const MACRO_FIELDS = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];

// Atwater factors (kcal/g). A generous tolerance, not a precision check —
// packaged labels round to whole grams/calories, so this exists to catch
// DATA-ENTRY errors (a misplaced decimal, a unit mix-up), not to
// second-guess a real label's own rounding.
const ATWATER = { protein_g: 4, carb_g: 4, fat_g: 9 };
const ATWATER_TOLERANCE = 0.35; // +/-35% before flagged — flagged, never silently corrected

/**
 * @param {object} record  { name, energy_kcal, protein_g, carb_g, fat_g, fiber_g, sugar_g, sodium_mg }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 *   `errors` non-empty -> the record must be rejected outright.
 *   `warnings` non-empty -> the record may still be saved, but the
 *   inconsistency should be surfaced (never hidden) to whoever is
 *   reviewing/using it.
 */
function validateFoodRecord(record = {}) {
  const { name } = record;
  const errors = [];
  const warnings = [];

  if (!name || !String(name).trim()) errors.push('name is required');

  for (const field of MACRO_FIELDS) {
    const raw = record[field];
    if (raw === null || raw === undefined || raw === '') continue; // absent = "not measured", not invalid
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors.push(`${field} must be a finite number`); continue; }
    if (n < 0) errors.push(`${field} cannot be negative (got ${n})`);
  }
  if (errors.length) return { valid: false, errors, warnings };

  const kcal = Number(record.energy_kcal);
  if (Number.isFinite(kcal) && kcal > 0) {
    const macroFields = ['protein_g', 'carb_g', 'fat_g'];
    const macrosPresent = macroFields.every((f) => record[f] !== null && record[f] !== undefined && record[f] !== '');
    if (macrosPresent) {
      const macroKcal = macroFields.reduce((sum, f) => sum + Number(record[f]) * ATWATER[f], 0);
      if (macroKcal > 0) {
        const deviation = Math.abs(macroKcal - kcal) / kcal;
        if (deviation > ATWATER_TOLERANCE) {
          warnings.push(
            `declared ${kcal} kcal is inconsistent with its own protein/carb/fat (~${Math.round(macroKcal)} kcal by Atwater factors) — off by ${Math.round(deviation * 100)}%`
          );
        }
      }
    }
  }

  // A macro gram total that alone exceeds 100 g per 100 g of food is
  // physically impossible for a solid (moisture/ash take up the rest).
  const perHundred = ['protein_g', 'carb_g', 'fat_g', 'fiber_g']
    .reduce((sum, f) => sum + (Number.isFinite(Number(record[f])) ? Number(record[f]) : 0), 0);
  if (perHundred > 100) {
    errors.push(`protein + carbs + fat + fiber (${perHundred.toFixed(1)} g) exceeds 100 g per 100 g — impossible`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export { validateFoodRecord };
