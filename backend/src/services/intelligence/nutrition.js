// ============================================================
// NUTRITION SERVICE — deterministic scaling + totals.
//   nutrient = per_base_qty × factor   (factor = qty / base_qty)
//   * per-100g foods scale linearly
//   * packaged foods scale by their label serving
//   * every result carries provenance + confidence
// The database row is the ONLY source of nutrition values; the
// server always recomputes from (food, quantity, unit). Totals
// sent by a client are never trusted.
// ============================================================
import { baseGramsFrom, multiplierFor, scaleNutrients, perPieceDefaults } from './units.js';

// Enrich a food row with base-quantity metadata (baseGrams, perPieceGrams).
export function withBase(food) {
  if (!food) return null;
  const { baseGrams, perPieceGrams } = baseGramsFrom(food);
  return { ...food, baseGrams: baseGrams || 100, perPieceGrams };
}

// Resolve one parsed food item against a specific food row.
// parsed: { qty, unitType, unit, provenance }
// Returns structured nutrition + provenance + confidence + the
// ORIGINAL unitType — never forces everything into grams.
export function computeNutrition(food, parsed, opts = {}) {
  const f = withBase(food);
  if (!f) return null;
  const mul = multiplierFor(parsed, f);
  const scaled = scaleNutrients(f, mul.factor);

  // provenance: parsed-level estimates override; food source otherwise
  let provenance = f.source || 'USER_ENTERED';
  if (parsed.provenance === 'ESTIMATED') provenance = 'ESTIMATED';
  if (mul.estimated) provenance = 'ESTIMATED';

  return {
    food_id: f.id,
    name: f.name,
    brand: f.brand || null,
    quantity: parsed.qty,
    unit: parsed.unit || (parsed.unitType === 'piece' ? 'pc' : parsed.unitType === 'ml' ? 'ml' : 'g'),
    unitType: parsed.unitType || 'serving',
    qtyGrams: mul.qtyGrams == null ? null : Math.round(mul.qtyGrams * 10) / 10,
    macros: scaled,
    perBase: {
      baseGrams: f.baseGrams,
      calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat,
      fiber: f.fiber, sugar: f.sugar, sodium: f.sodium
    },
    calculation: mul.qtyGrams == null
      ? `${parsed.qty} ${parsed.unit} ÷ ${f.baseGrams}${f.unit || 'g'} per base`
      : `${mul.qtyGrams} / ${f.baseGrams} × per-${f.baseGrams}${f.unit || 'g'}`,
    provenance,
    sourceScope: f.is_global === 1 ? 'GLOBAL' : f.org_id && !f.client_id ? 'GYM' : f.client_id ? 'MY_FOOD' : 'GLOBAL',
    confidence: mul.confidence,
    estimated: mul.estimated || provenance === 'ESTIMATED',
    note: mul.note || null
  };
}

// Sum a list of computed nutrition entries.
export function sumNutrition(entries) {
  const t = entries.reduce((a, e) => {
    a.calories += e.macros.calories || 0;
    a.protein += e.macros.protein || 0;
    a.carbs += e.macros.carbs || 0;
    a.fat += e.macros.fat || 0;
    a.fiber += e.macros.fiber || 0;
    a.sugar += e.macros.sugar || 0;
    a.sodium += e.macros.sodium || 0;
    return a;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 });
  for (const k of ['protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium']) t[k] = Math.round(t[k] * 10) / 10;
  t.calories = Math.round(t.calories);
  return t;
}
