import {
  foodSearch,
  scaleNutrition,
  portionToGrams,
  canonicalPortion
} from './skos-food/index.js';

function round1(value) {
  return Math.round(value * 10) / 10;
}

function splitFoodText(text) {
  return String(text || '')
    .split(/\s*(?:,|\band\b|\&|\+)\s*/i)
    .map(x => x.trim())
    .filter(Boolean);
}

function parsePart(part) {
  const gramMatch = part.match(/^(\d+(?:\.\d+)?)\s*g(?:ram|rams)?\s+(.+)$/i);
  if (gramMatch) {
    return {
      count: Number(gramMatch[1]),
      gramsExplicit: Number(gramMatch[1]),
      portion: null,
      query: gramMatch[2].trim()
    };
  }

  const portionMatch = part.match(
    /^(\d+(?:\.\d+)?)\s*(roti|chapati|phulka|idli|dosa|egg|banana|apple|paratha|poori|samosa|vada|ladoo|biscuit|pieces?|slices?|bowls?|plates?|cups?|glasses?)\s+(.+)$/i
  );

  if (portionMatch) {
    const count = Number(portionMatch[1]);
    const raw = portionMatch[2].toLowerCase();
    const query = portionMatch[3].trim();

    const aliases = {
      chapati: 'roti',
      phulka: 'roti',
      pieces: 'piece',
      piece: 'piece',
      slices: 'slice',
      slice: 'slice',
      bowls: 'bowl',
      plates: 'plate',
      cups: 'cup',
      glasses: 'glass'
    };

    return {
      count,
      gramsExplicit: null,
      portion: canonicalPortion(aliases[raw] || raw),
      query
    };
  }

  // Volume portion: "2 bowls dal", "1 plate rice", "3 cups tea".
  // The existing portionMatch above requires the portion word BEFORE the food
  // name ("2 roti dal"), but household expressions often put the vessel first
  // ("2 bowls dal"). Without this branch it hits leadingNumber, which passes
  // "bowls dal" as a query and FoodSearch returns garbage like "2-Minute
  // noodles".
  const volumePortion = part.match(
    /^(\d+(?:\.\d+)?)\s*(teaspoons?|tablespoons?|katoris?|small bowls?|soup bowls?|medium bowls?|large bowls?|bowls?|quarter plates?|half plates?|plates?|full plates?|small glasses?|tall glasses?|glasses?|tea cups?|cups?|mugs?)\s+(.+)$/i
  );

  if (volumePortion) {
    const count = Number(volumePortion[1]);
    const raw = volumePortion[2].toLowerCase().replace(/\s+/g, '_');
    const aliases = {
      bowls: 'bowl', 'small bowls': 'small_bowl', 'medium bowls': 'medium_bowl',
      'large bowls': 'large_bowl', 'soup bowls': 'soup_bowl',
      plates: 'plate', 'half plates': 'half_plate', 'quarter plates': 'quarter_plate',
      'full plates': 'full_plate',
      glasses: 'glass', 'small glasses': 'small_glass', 'tall glasses': 'tall_glass',
      cups: 'cup', 'tea cups': 'tea_cup', mugs: 'mug',
      teaspoons: 'teaspoon', tablespoons: 'tablespoon', katoris: 'katori'
    };

    return {
      count,
      gramsExplicit: null,
      portion: canonicalPortion(aliases[raw] || raw),
      query: volumePortion[3].trim()
    };
  }

  // Standalone counted portion: "2 roti", "1 egg", "3 chapati" (no food name after).
  // The portionMatch above requires text AFTER the portion word (\s+(.+)), so a
  // bare "2 roti" falls through. Without this branch it hits leadingNumber,
  // which treats "roti" as the food query and uses serving_grams (36g) instead
  // of COUNT_PORTIONS.roti.grams (40g).
  const standalonePortion = part.match(
    /^(\d+(?:\.\d+)?)\s*(roti|chapati|phulka|idli|dosa|egg|banana|apple|paratha|poori|samosa|vada|ladoo|biscuit|pieces?|slices?)$/i
  );

  if (standalonePortion) {
    const count = Number(standalonePortion[1]);
    const raw = standalonePortion[2].toLowerCase();

    const aliases = {
      chapati: 'roti',
      phulka: 'roti',
      pieces: 'piece',
      piece: 'piece',
      slices: 'slice',
      slice: 'slice'
    };

    return {
      count,
      gramsExplicit: null,
      portion: canonicalPortion(aliases[raw] || raw),
      query: aliases[raw] || raw  // use the canonical name so FoodSearch finds it
    };
  }

  const leadingNumber = part.match(/^(\d+(?:\.\d+)?)\s*(?:x\s*)?(.+)$/i);

  if (leadingNumber) {
    return {
      count: Number(leadingNumber[1]),
      gramsExplicit: null,
      portion: null,
      query: leadingNumber[2].trim()
    };
  }

  return {
    count: 1,
    gramsExplicit: null,
    portion: null,
    query: part
  };
}

function makeItem(result, grams, qty, unit) {
  const nutrition = scaleNutrition(result, grams);
  if (!nutrition) return null;

  const t = nutrition.totals;

  return {
    name: result.food_name,
    source_id: result.source_id,
    unit,
    qty,
    grams: nutrition.grams,
    calories: round1(t.energy_kcal ?? 0),
    protein: round1(t.protein_g ?? 0),
    carbs: round1(t.carb_g ?? 0),
    fat: round1(t.fat_g ?? 0),
    fiber: t.fiber_g,
    sodium_mg: t.sodium_mg,
    cooking_state: result.cooking_state,
    confidence: result.confidence,
    trustworthy: result.trustworthy,
    match_kind: result.match_kind
  };
}

export function estimateFood(text) {
  const parts = splitFoodText(text);
  const items = [];

  for (const part of parts) {
    const parsed = parsePart(part);

    const results = foodSearch.search(parsed.query, {
      limit: 1,
      allowBackoff: true
    });

    const result = results[0];
    if (!result) continue;

    let grams;
    let unit;

    if (parsed.gramsExplicit !== null) {
      grams = parsed.gramsExplicit;
      unit = `${grams} g`;
    } else if (parsed.portion) {
      const converted = portionToGrams(
        parsed.portion,
        parsed.count,
        {
          foodName: result.food_name,
          cookingState: result.cooking_state,
          foodServingGrams: result.serving_grams
        }
      );

      grams = converted.grams;
      unit = parsed.portion;
    } else if (result.serving_grams) {
      grams = result.serving_grams * parsed.count;
      unit = 'serving';
    } else {
      grams = 100 * parsed.count;
      unit = '100 g';
    }

    if (!(grams > 0)) continue;

    const item = makeItem(result, grams, parsed.count, unit);
    if (item) items.push(item);
  }

  const total = items.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  return {
    text,
    items,
    total: {
      calories: round1(total.calories),
      protein: round1(total.protein),
      carbs: round1(total.carbs),
      fat: round1(total.fat)
    },
    estimate: true,
    disclaimer:
      'AI-estimated values — approximate. Confirm with the actual pack/recipe when possible.'
  };
}
