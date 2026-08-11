// ============================================================
// UNIT ENGINE — deterministic quantity parsing + conversion.
//   * understands g / grams / kg / ml / litre / L / piece / pcs /
//     cup / bowl / serving / slice / roti / chapati / tbsp / tsp
//   * conversion is FOOD-AWARE: the food's own `serving` and
//     `piece_g` define its base unit and grams-per-piece. There is
//     NO universal 1ml = 1g assumption — cross-unit conversions
//     (ml ↔ g, pieces ↔ grams) always carry ESTIMATED provenance.
//   * all scaling is: nutrient = per_base_qty * (qty / base_qty)
// ============================================================

// Parsed quantity: { qty, unit, unitType, provenance }
export function parseQuantity(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;

  // explicit unit first: "220g", "0.22 kg", "250 ml", "2 rotis", "1 cup"
  const m = s.match(/^([\d.,]+)\s*([a-z]+)$/);
  if (m) {
    const qty = toNumber(m[1]);
    if (qty === null) return null;
    return fromUnit(qty, m[2]);
  }

  // bare number: "2" — caller decides the unit
  const n = s.match(/^([\d.,]+)$/);
  if (n) {
    const qty = toNumber(n[1]);
    return qty === null ? null : { qty, unit: null, unitType: 'serving', provenance: 'USER_ENTERED', note: 'no unit given' };
  }
  return null;
}

function fromUnit(qty, unitRaw) {
  const unit = unitRaw.replace(/\.$/, '');
  switch (unit) {
    case 'g': case 'gram': case 'grams': case 'gm': case 'gr': case 'gms':
      return { qty, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED' };
    case 'kg': case 'kilo': case 'kilos': case 'kilogram': case 'kilograms':
      return { qty: qty * 1000, unit: 'g', unitType: 'gram', provenance: 'USER_ENTERED', note: 'converted kg → g' };
    case 'ml': case 'milliliter': case 'milliliters': case 'millilitre': case 'millilitres':
      return { qty, unit: 'ml', unitType: 'ml', provenance: 'USER_ENTERED' };
    case 'l': case 'litre': case 'litres': case 'liter': case 'liters':
      return { qty: qty * 1000, unit: 'ml', unitType: 'ml', provenance: 'USER_ENTERED', note: 'converted l → ml' };
    case 'pc': case 'pcs': case 'piece': case 'pieces':
      return { qty, unit: 'pc', unitType: 'piece', provenance: 'USER_ENTERED' };
    case 'slice': case 'slices':
      return { qty, unit: unit, unitType: 'slice', provenance: 'USER_ENTERED' };
    case 'egg': case 'eggs':
      return { qty, unit, unitType: 'piece', provenance: 'USER_ENTERED' };
    case 'cup': case 'cups':
      return { qty, unit: 'cup', unitType: 'cup', provenance: 'ESTIMATED', note: 'cup volume approximated' };
    case 'bowl': case 'bowls':
      return { qty, unit: 'bowl', unitType: 'bowl', provenance: 'ESTIMATED', note: 'bowl approximated' };
    case 'serving': case 'servings': case 'portion': case 'portions':
      return { qty, unit: 'serving', unitType: 'serving', provenance: 'USER_ENTERED' };
    case 'tbsp': case 'tablespoon': case 'tablespoons': case 'tbs':
      return { qty, unit: 'tbsp', unitType: 'tbsp', provenance: 'USER_ENTERED' };
    case 'tsp': case 'teaspoon': case 'teaspoons':
      return { qty, unit: 'tsp', unitType: 'tsp', provenance: 'USER_ENTERED' };
    case 'rotis': case 'roti': case 'chapatis': case 'chapati': case 'phulka': case 'phulkas':
      return { qty, unit, unitType: 'piece', provenance: 'USER_ENTERED' };
    case 'handful': case 'handfuls':
      return { qty, unit: 'handful', unitType: 'handful', provenance: 'ESTIMATED', note: 'handful approximated' };
    case 'scoop': case 'scoops':
      return { qty, unit: 'scoop', unitType: 'scoop', provenance: 'USER_ENTERED' };
    default:
      return { qty, unit: unitRaw, unitType: 'serving', provenance: 'USER_ENTERED', note: `unit "${unitRaw}" interpreted as servings` };
  }
}

// Rough grams-per-unit defaults — clearly estimates, never presented as exact.
export const perPieceDefaults = {
  piece: 50, slice: 20, slices: 20, egg: 52, eggs: 52, roti: 35, chapatis: 35,
  phulka: 35, handful: 15, tbsp: 15, tsp: 5, scoop: 33, cup: 150, bowl: 250, serving: 100
};

// ------------------------------------------------------------------
// FOOD-AWARE base units.
// A food row's `serving` defines its base: "100 g", "200 ml", "1 pc",
// "1 scoop", "2 slices". `piece_g` (optional) is the food-specific
// grams per piece/scoop/slice — used instead of the generic default.
// ------------------------------------------------------------------
export function foodBase(food) {
  if (!food) return { unit: 'g', unitType: 'gram', qty: 100, gramsPerUnit: null, note: null };
  const serving = String(food.serving || food.unit || '100 g').toLowerCase();
  const m = serving.match(/^([\d.,]+)\s*([a-z]+)\b/);
  if (!m) return { unit: 'g', unitType: 'gram', qty: 100, gramsPerUnit: null, note: null };
  const qty = toNumber(m[1]) || 1;
  const rawUnit = m[2];
  // map the raw serving unit to a unitType
  let unitType = 'serving';
  if (/^(g|gram|grams|gm|gms)$/.test(rawUnit)) unitType = 'gram';
  else if (/^(kg|kilo|kilos|kilogram|kilograms)$/.test(rawUnit)) unitType = 'gram';
  else if (/^(ml|milliliter|milliliters|millilitre|millilitres)$/.test(rawUnit)) unitType = 'ml';
  else if (/^(l|litre|litres|liter|liters)$/.test(rawUnit)) unitType = 'ml';
  else if (/^(pc|pcs|piece|pieces|egg|eggs|rotis|roti|chapatis|chapati|phulka|phulkas)$/.test(rawUnit)) unitType = 'piece';
  else if (/^(slice|slices)$/.test(rawUnit)) unitType = 'slice';
  else if (/^(scoop|scoops)$/.test(rawUnit)) unitType = 'scoop';
  else if (/^(cup|cups)$/.test(rawUnit)) unitType = 'cup';
  else if (/^(bowl|bowls)$/.test(rawUnit)) unitType = 'bowl';
  else if (/^(serving|servings|portion|portions)$/.test(rawUnit)) unitType = 'serving';

  // grams-per-unit for piece-like bases: food.piece_g wins, else default
  const gramsPerUnit = /^(piece|slice|scoop)$/.test(unitType)
    ? (food.piece_g ?? perPieceDefaults[unitType])
    : null;
  return { unit: rawUnit, unitType, qty, gramsPerUnit, note: null };
}

// Extract the base gram amount for a food (used for gram-based scaling).
export function baseGramsFrom(food) {
  const b = foodBase(food);
  if (b.unitType === 'gram') return { baseGrams: b.qty, perPieceGrams: null };
  if (b.unitType === 'ml') return { baseGrams: b.qty, perPieceGrams: null };
  if (b.gramsPerUnit) return { baseGrams: b.qty * b.gramsPerUnit, perPieceGrams: b.gramsPerUnit };
  return { baseGrams: 100, perPieceGrams: null };
}

// ------------------------------------------------------------------
// MULTIPLIER — scale a parsed quantity against a food's base serving.
// Returns { factor, qtyGrams, note, estimated, confidence }.
// Cross-unit conversions are never silent: they are ESTIMATED.
// ------------------------------------------------------------------
export function multiplierFor(parsed, food) {
  const f = foodBase(food);
  const t = parsed.unitType;
  const baseT = f.unitType;

  // exact same-unit scaling (gram→gram, ml→ml, piece→piece, scoop→scoop…)
  if (t === baseT) {
    if (t === 'gram') return { factor: parsed.qty / f.qty, qtyGrams: parsed.qty, note: null, estimated: false, confidence: 'HIGH' };
    if (t === 'ml') return { factor: parsed.qty / f.qty, qtyGrams: null, note: null, estimated: false, confidence: 'HIGH' };
    // piece/slice/scoop/serving/cup/bowl against same base unit
    const gramsPerUnit = f.gramsPerUnit || perPieceDefaults[t] || perPieceDefaults.piece;
    return {
      factor: parsed.qty / f.qty,
      qtyGrams: parsed.qty * gramsPerUnit,
      note: f.gramsPerUnit ? null : `${parsed.qty} × ~${gramsPerUnit}g/${t} (ESTIMATED)`,
      estimated: !f.gramsPerUnit && /^(piece|slice|scoop)$/.test(t),
      confidence: f.gramsPerUnit ? 'HIGH' : 'MEDIUM'
    };
  }

  // gram ↔ ml cross-conversion: density is unknown — always ESTIMATED.
  if ((t === 'gram' && baseT === 'ml') || (t === 'ml' && baseT === 'gram')) {
    const note = 'assumed 1 ml ≈ 1 g (density varies by food)';
    return { factor: parsed.qty / f.qty, qtyGrams: parsed.qty, note, estimated: true, confidence: 'LOW' };
  }

  // piece-like input against a gram/ml base: use grams-per-piece (food-specific if known)
  if (['piece', 'slice', 'scoop', 'handful', 'tbsp', 'tsp', 'cup', 'bowl', 'serving'].includes(t) && (baseT === 'gram' || baseT === 'ml')) {
    const gramsPerUnit = parsed.unit === 'rotis' ? (food.piece_g ?? perPieceDefaults.roti)
      : parsed.unit === 'egg' ? (food.piece_g ?? perPieceDefaults.egg)
      : parsed.unitType === 'piece' ? (food.piece_g ?? perPieceDefaults[parsed.unit] ?? perPieceDefaults.piece)
      : perPieceDefaults[t] ?? perPieceDefaults.piece;
    const qtyGrams = parsed.qty * gramsPerUnit;
    return {
      factor: qtyGrams / f.qty,
      qtyGrams,
      note: `${parsed.qty} × ~${gramsPerUnit}g/${parsed.unit || t} (ESTIMATED)`,
      estimated: true,
      confidence: 'MEDIUM'
    };
  }

  // gram/ml input against a piece base: divide by grams-per-piece
  if ((t === 'gram' || t === 'ml') && ['piece', 'slice', 'scoop'].includes(baseT)) {
    const gramsPerUnit = f.gramsPerUnit || perPieceDefaults[baseT] || perPieceDefaults.piece;
    const pieces = parsed.qty / gramsPerUnit;
    return {
      factor: pieces / f.qty,
      qtyGrams: parsed.qty,
      note: `${parsed.qty}g ÷ ~${gramsPerUnit}g/${f.unit} (ESTIMATED)`,
      estimated: true,
      confidence: 'MEDIUM'
    };
  }

  // last resort — fall back to the food's own serving as 1 unit
  return { factor: parsed.qty, qtyGrams: parsed.qty * (f.gramsPerUnit || 100), note: 'counted as servings (ESTIMATED)', estimated: true, confidence: 'LOW' };
}

// Nutrient scaling with consistent rounding (1 decimal, floor at 0).
export function scaleNutrients(perBase, factor) {
  const scale = (v) => (v == null ? null : Math.round((v * factor) * 10) / 10);
  return {
    calories: Math.round((perBase.calories || 0) * factor),
    protein: scale(perBase.protein),
    carbs: scale(perBase.carbs),
    fat: scale(perBase.fat),
    fiber: scale(perBase.fiber),
    sugar: scale(perBase.sugar),
    sodium: scale(perBase.sodium)
  };
}

export function toNumber(s) {
  const n = Number(String(s).replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}
