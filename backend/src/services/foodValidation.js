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

  // REMOVED (was here through the previous revision of this file): a check
  // rejecting any record whose protein_g + carb_g + fat_g + fiber_g summed
  // to more than 100 -- on the theory that macro grams can never exceed
  // 100g per 100g of food. That premise is correct for a food's TOTAL
  // physical weight (water/ash make up the rest), but this function has no
  // way to know whether the caller's numbers actually represent a 100g
  // basis -- and in this app's own Custom Macros flow they never did: a
  // person enters macros for whatever quantity they're describing (a 40g
  // chapati: 3g protein, 18g carbs, 2g fat), and protein+carbs+fat is NOT
  // required to equal that quantity in the first place (the rest is water
  // and other non-macro mass) -- 3+18+2=23, not 40, and that is correct,
  // not "impossible". Rejecting on a raw gram sum crossing 100 produced
  // real false positives for ordinary small-serving, calorie-dense foods
  // once fed through a per-100g conversion upstream (a 25g protein bar
  // with 15g protein/15g carbs/8g fat converts to 60+60+32=152 per 100g,
  // which is high but not remotely "impossible" for a concentrated food).
  // Never reinstate an equality/upper-bound check between macro grams and
  // a serving/reference weight -- see FoodLogSheet.jsx's Custom Macros
  // screen for the reference-quantity-vs-eaten-quantity model this
  // function's callers now use instead.

  return { valid: errors.length === 0, errors, warnings };
}

export { validateFoodRecord };
