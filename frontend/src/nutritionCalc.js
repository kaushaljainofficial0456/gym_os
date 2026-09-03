// ============================================================
// NUTRITION CALCULATION — single source of truth for any math this app
// does client-side over already-known macro/portion numbers. Deliberately
// NOT the place grams/macros are derived from a food + quantity (that
// stays server-authoritative -- see FoodLogSheet.jsx's own header comment
// on `/me/foods/resolve` and why re-implementing it client-side is exactly
// how the UI and the model start disagreeing). This file only ever
// combines numbers the server has already computed and handed back.
// ============================================================

/** Atwater factors -- kcal per gram of each macronutrient. The ONLY place
 *  this ratio is defined; every other calorie-from-macros calculation in
 *  the app should import and use this, never restate the numbers. */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/** calories = protein×4 + carbs×4 + fat×9 (rounded to the nearest kcal). */
export function calculateCaloriesFromMacros({ protein = 0, carbs = 0, fat = 0 } = {}) {
  return Math.round((Number(protein) || 0) * KCAL_PER_G.protein
    + (Number(carbs) || 0) * KCAL_PER_G.carbs
    + (Number(fat) || 0) * KCAL_PER_G.fat);
}

/**
 * Sums calories/protein/carbs/fat over meal entries flagged `eaten`
 * (Part 37 -- "single source of truth for nutrition math"). This is the
 * frontend counterpart to `sumEatenTotals()` in
 * `backend/src/routes/nutrition.js` -- they can't be the literal same
 * runtime function across the client/server boundary, but naming and
 * isolating BOTH copies here (instead of an inline reduce living
 * wherever a page happens to need "today's totals") means any future
 * change to what "eaten total" means has exactly ONE place to update on
 * each side, not an inline reduce silently drifting from its backend
 * counterpart. Accepts any array of objects with those four numeric
 * fields and an `eaten` flag -- works for `Nutrition.jsx`'s own
 * `mealState`, or any other list shaped the same way.
 */
export function sumEatenTotals(meals = []) {
  return meals.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + (Number(m.calories) || 0),
    protein: s.protein + (Number(m.protein) || 0),
    carbs: s.carbs + (Number(m.carbs) || 0),
    fat: s.fat + (Number(m.fat) || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}
