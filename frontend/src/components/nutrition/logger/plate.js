/**
 * THE PLATE — what is about to be logged, before it is.
 *
 * Pure functions only, so the arithmetic every tap depends on is tested
 * without a browser. Three kinds of item arrive here and leave as ONE shape:
 *
 *   from describe   the server's plate item: per-100 g values plus the grams
 *                   ONE of each natural unit weighs, for this food
 *   from search     a picker result: per-100 g values and its portion list
 *   from usuals     a past log: no per-100 g values, only what that amount
 *                   came to -- so it scales by its own quantity, honestly
 *
 * Grams per unit always come from the server (a katori of dal is not a
 * katori of poha). The only maths done here is proportion.
 */

/** The meals a log row is filed under. Recorded from the clock, never asked
 *  for: they feed "your usuals" and "same as yesterday's breakfast". */
export const SLOTS = [
  { key: 'breakfast', label: 'Breakfast', short: 'Bkfst' },
  { key: 'lunch', label: 'Lunch', short: 'Lunch' },
  { key: 'snack', label: 'Snacks', short: 'Snack' },
  { key: 'dinner', label: 'Dinner', short: 'Dinner' },
];

export const slotLabel = (key) => SLOTS.find((s) => s.key === key)?.label || 'Snacks';

/** Which of the four meals a slot name means. Older slot names fold in, the
 *  same way the server folds them (me.js mealGroup). */
export function mealGroup(slot) {
  const s = String(slot || '').toLowerCase();
  if (s.startsWith('breakfast')) return 'breakfast';
  if (s.startsWith('lunch')) return 'lunch';
  if (s.startsWith('dinner') || s === 'before_bed') return 'dinner';
  return 'snack';
}

/** Which meal it probably is, from the clock. Snacks fill the gaps. */
export function slotForTime(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 12 && h < 15.5) return 'lunch';
  if (h >= 19 && h < 23.5) return 'dinner';
  return 'snack';
}

const r1 = (n) => Math.round(Number(n || 0) * 10) / 10;
let seq = 0;
const nextId = () => `p${Date.now().toString(36)}${(seq += 1).toString(36)}`;

/** A server plate item (POST /me/nutrition/describe or /item). */
export function fromPlateItem(it) {
  return {
    id: nextId(),
    name: it.name,
    sourceName: it.source_name || null,
    sourceId: it.source_id || null,
    stapleKey: it.staple_key || null,
    confidence: it.confidence || null,
    alternatives: it.alternatives || [],
    matchedFrom: it.matched_from || null,
    per100: it.per100,
    // "Less oil" / "more oil" as per-100 g values the server worked out with
    // its oil model; null where oil is not a meaningful choice (an egg, tea).
    oil: it.oil?.options?.length ? it.oil.options.map((o) => ({ key: o.key, per100: o.per100 })) : null,
    oilKey: null,
    units: (it.units || []).map((u) => ({ key: u.key, label: u.label, grams: Number(u.grams) })),
    unitKey: it.unit_key,
    qty: Number(it.qty) || 1,
    // No amount was said ("dal", not "1 katori dal"), so the amount shown is
    // the parser's default -- worth a glance before it is logged.
    assumed: !!it.assumed,
    origin: 'model',
  };
}

/** A /me/foods/search result, at its default portion. */
export function fromSearchFood(f) {
  const units = (f.portions || [])
    .filter((p) => Number(p.grams) > 0)
    .slice(0, 6)
    .map((p) => ({ key: p.key, label: p.label, grams: Number(p.grams) }));
  units.push({ key: 'g', label: 'g', grams: 1 });
  const def = (f.portions || []).find((p) => p.default && Number(p.grams) > 0);
  const unitKey = def ? def.key : 'g';
  return {
    id: nextId(),
    name: f.name,
    sourceName: f.name,
    sourceId: f.source_id || null,
    foodId: f.id || null,
    stapleKey: null,
    confidence: f.confidence || null,
    alternatives: [],
    per100: { calories: Number(f.calories) || 0, protein: Number(f.protein) || 0, carbs: Number(f.carbs) || 0, fat: Number(f.fat) || 0 },
    oil: null,
    oilKey: null,
    units,
    unitKey,
    qty: unitKey === 'g' ? 100 : 1,
    // A pick from search arrives at its default portion: the person chose
    // the food, not the amount.
    assumed: true,
    origin: 'search',
  };
}

/**
 * A past log, as it was logged. Its numbers describe `quantity` of `unit`,
 * so one unit is that divided by the quantity -- and with no quantity on
 * record, the entry is one serving and stays one serving.
 */
export function fromUsual(u) {
  const qty = Number(u.quantity) > 0 ? Number(u.quantity) : 1;
  const per = {
    calories: (Number(u.calories) || 0) / qty,
    protein: (Number(u.protein) || 0) / qty,
    carbs: (Number(u.carbs) || 0) / qty,
    fat: (Number(u.fat) || 0) / qty,
  };
  return {
    id: nextId(),
    name: u.name,
    sourceName: null,
    sourceId: null,
    stapleKey: null,
    confidence: null,
    alternatives: [],
    per100: null,
    oil: null,
    oilKey: null,
    units: [{ key: 'own', label: u.unit || 'serving', perUnit: per }],
    unitKey: 'own',
    qty,
    // The person's own last amount -- not a guess.
    assumed: false,
    origin: 'usual',
  };
}

export const unitOf = (item) => item.units.find((u) => u.key === item.unitKey) || item.units[0];

/** The per-100 g values the item prices from: its oil choice's, if one was
 *  made, else the dish as measured. */
export function per100For(item) {
  const o = item.oilKey && item.oil?.find((x) => x.key === item.oilKey);
  return (o && o.per100) || item.per100 || {};
}

/** Choose "less" / "more" oil, or null for the dish as measured. */
export function setOil(item, oilKey) {
  if (oilKey && !item.oil?.some((o) => o.key === oilKey)) return item;
  return { ...item, oilKey: oilKey || null };
}

/** What one of a unit weighs, for the unit chip ("katori · 150 g"). Only for
 *  units whose weight is not already their name (g, ml, a typed "200 ml"). */
export function unitGramsHint(u) {
  if (!u || u.key === 'g' || u.perUnit || !(u.grams >= 1)) return null;
  if (/^(g|gm|gms|grams?|kg|ml|l|litres?|liters?)$/i.test(String(u.label).trim())) return null;
  // Small things keep a decimal: "almond · 1.2 g", not a rounded "1 g".
  return u.grams < 10 ? `${Math.round(u.grams * 10) / 10} g` : `${Math.round(u.grams)} g`;
}

/** What the item comes to at its current amount. */
export function priceItem(item) {
  const u = unitOf(item);
  if (!u) return { grams: null, calories: 0, protein: 0, carbs: 0, fat: 0 };
  if (u.perUnit) {
    return {
      grams: null,
      calories: Math.round(u.perUnit.calories * item.qty),
      protein: r1(u.perUnit.protein * item.qty),
      carbs: r1(u.perUnit.carbs * item.qty),
      fat: r1(u.perUnit.fat * item.qty),
    };
  }
  const grams = r1(u.grams * item.qty);
  const f = grams / 100;
  const p = per100For(item);
  return {
    grams,
    calories: Math.round((p.calories || 0) * f),
    protein: r1((p.protein || 0) * f),
    carbs: r1((p.carbs || 0) * f),
    fat: r1((p.fat || 0) * f),
  };
}

export function plateTotals(items) {
  return items.reduce((s, it) => {
    const p = priceItem(it);
    return { calories: s.calories + p.calories, protein: r1(s.protein + p.protein), carbs: r1(s.carbs + p.carbs), fat: r1(s.fat + p.fat) };
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

/** How far one tap of − / + moves the amount, by unit. Pieces move in
 *  wholes, but in halves at or below one: half a roti is a real amount. */
export function stepFor(item, dir = 1) {
  const u = unitOf(item);
  if (!u) return 1;
  if (u.key === 'g') return item.qty >= 200 ? 25 : 10;
  if (/^ml$/i.test(u.label)) return 50;
  if (u.grams && u.grams < 3) return item.qty >= 20 ? 5 : 1;    // 1 almond, 1 cashew
  const low = dir < 0 ? item.qty <= 1 : item.qty < 1;
  return low || item.qty % 1 !== 0 ? 0.5 : 1;
}

export function stepQty(item, dir) {
  const step = stepFor(item, dir);
  const next = Math.round((item.qty + dir * step) / step) * step;
  return Math.max(step, Math.min(9999, Math.round(next * 100) / 100));
}

/**
 * Change unit, keeping the AMOUNT OF FOOD the same where both units have a
 * weight: 2 roti (80 g) shown in grams is 80 g, not 2 g. Count units round
 * to the nearest half, because nobody eats 1.37 roti.
 */
export function switchUnit(item, unitKey) {
  const from = unitOf(item);
  const to = item.units.find((u) => u.key === unitKey);
  if (!to || to === from) return item;
  if (from?.grams && to.grams) {
    const grams = from.grams * item.qty;
    let qty = grams / to.grams;
    qty = to.key === 'g' ? Math.round(qty) : Math.max(0.5, Math.round(qty * 2) / 2);
    return { ...item, unitKey, qty };
  }
  return { ...item, unitKey, qty: to.key === 'g' ? 100 : 1 };
}

/** "2 roti", "150 g", "1.5 katori" -- for display and for the stored unit. */
export function amountLabel(item) {
  const u = unitOf(item);
  const q = Number.isInteger(item.qty) ? item.qty : Math.round(item.qty * 100) / 100;
  if (!u) return `${q}`;
  if (u.key === 'g') return `${q} g`;
  return `${q} ${u.label}`;
}

/** The log rows for a plate: what was eaten, how much, and how sure. */
export function toLogItems(items) {
  return items.map((it) => {
    const p = priceItem(it);
    const u = unitOf(it);
    // The oil choice travels in the name, so the day's list says which dal
    // this was ("Dal · less oil") and the numbers never look unexplained.
    const oilNote = it.oilKey === 'less' ? ' · less oil' : it.oilKey === 'more' ? ' · more oil' : '';
    return {
      name: (it.name.slice(0, 100 - oilNote.length) + oilNote),
      calories: p.calories,
      protein: p.protein,
      carbs: p.carbs,
      fat: p.fat,
      quantity: it.qty,
      // The unit the person chose, so "Edit quantity" later scales from it.
      unit: (u?.key === 'g' ? 'g' : u?.label || 'serving').slice(0, 30),
      source: 'manual',
      ...(it.confidence ? { confidence: it.confidence } : {}),
    };
  });
}

/** The order a day happens in: snacks sit in the afternoon, before dinner. */
const DAY_ORDER = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };

/**
 * Today's rows as ONE list, in the order the day happened, with the total of
 * what was actually eaten. The meal each row was logged to only decides its
 * place in the list; it is never shown as a heading (see TodayLog.jsx).
 * Within a meal the rows keep the order they arrived in -- the sort is stable.
 */
export function dayList(meals) {
  const items = [...(meals || [])]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (DAY_ORDER[mealGroup(a.m.slot)] - DAY_ORDER[mealGroup(b.m.slot)]) || (a.i - b.i))
    .map(({ m }) => m);
  const total = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let eatenCount = 0;
  for (const m of items) {
    if (!m.eaten) continue;
    eatenCount += 1;
    total.calories += Number(m.calories) || 0;
    total.protein = r1(total.protein + (Number(m.protein) || 0));
    total.carbs = r1(total.carbs + (Number(m.carbs) || 0));
    total.fat = r1(total.fat + (Number(m.fat) || 0));
  }
  return { items, total, eatenCount };
}

/** Whether to look the text up as one food (type-ahead) or parse it as a
 *  meal: a number, a comma or "and" means the person is describing. */
export const looksLikeMeal = (text) => /\d|,|\band\b|\bwith\b|\+/i.test(String(text || ''));
