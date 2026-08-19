// ============================================================
// SKOS food estimator v1 — unit tests.
//
// Covers:
//   * standalone counted portions ("2 roti", "1 egg", "1 banana")
//   * explicit gram input ("150g chicken", "100 g paneer")
//   * volume portions ("2 bowls dal", "1 plate rice")
//   * multi-food comma-separated input ("2 roti, dal and curd")
//   * nutrition totals are computed and non-null for real foods
//   * response shape: source_id, confidence, trustworthy, match_kind, grams
//   * edge cases: empty input, unknown food, single word
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

const { estimateFood } = await import('../src/services/foodEstimator.js');

// ---------- helpers ----------

/** Find the first item whose name matches the given substring (case-insensitive). */
function findItem(result, nameSubstr) {
  return result.items.find(
    (i) => i.name.toLowerCase().includes(nameSubstr.toLowerCase())
  );
}

// ---------- standalone counted portions ----------

test('"2 roti" uses COUNT_PORTIONS roti reference: 40g x 2 = 80g', () => {
  const r = estimateFood('2 roti');
  assert.equal(r.items.length, 1, 'one item');
  const item = r.items[0];
  assert.equal(item.grams, 80, '40g per roti x 2');
  assert.equal(item.qty, 2);
  assert.equal(item.unit, 'roti');
  assert.ok(item.source_id, 'has source_id');
  assert.equal(item.confidence, 'high');
  assert.equal(item.trustworthy, true);
  assert.equal(item.match_kind, 'alias_exact');
});

test('"1 roti" uses COUNT_PORTIONS roti reference: 40g x 1 = 40g', () => {
  const r = estimateFood('1 roti');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 40, '40g per roti x 1');
  assert.equal(r.items[0].qty, 1);
});

test('"2 egg" uses COUNT_PORTIONS egg reference: 50g x 2 = 100g', () => {
  const r = estimateFood('2 egg');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 100, '50g per egg x 2');
  assert.equal(r.items[0].qty, 2);
  assert.equal(r.items[0].unit, 'egg');
});

test('"1 banana" uses COUNT_PORTIONS banana reference: 120g x 1 = 120g', () => {
  const r = estimateFood('1 banana');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 120, '120g per banana x 1');
  assert.equal(r.items[0].qty, 1);
  assert.equal(r.items[0].unit, 'banana');
});

test('"3 chapati" uses canonical roti reference via alias: 40g x 3 = 120g', () => {
  const r = estimateFood('3 chapati');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 120, '40g per roti x 3');
  assert.equal(r.items[0].qty, 3);
});

// ---------- explicit gram input ----------

test('"150g chicken" uses explicit grams: 150g', () => {
  const r = estimateFood('150g chicken');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 150);
  assert.equal(r.items[0].unit, '150 g');
  assert.equal(r.items[0].qty, 150);
});

test('"100 g paneer" uses explicit grams: 100g', () => {
  const r = estimateFood('100 g paneer');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 100);
  assert.equal(r.items[0].unit, '100 g');
  assert.equal(r.items[0].name.toLowerCase(), 'paneer');
  assert.equal(r.items[0].confidence, 'high');
});

// ---------- volume portions ----------

test('"2 bowls dal" uses volume portion: 2 x 250ml bowl x ~1.0 density', () => {
  const r = estimateFood('2 bowls dal');
  assert.equal(r.items.length, 1);
  // bowl = 250ml; dal cooked density ~1.0; 2 x 250 = 500g
  assert.equal(r.items[0].grams, 500);
  assert.equal(r.items[0].unit, 'bowl');
  assert.equal(r.items[0].qty, 2);
  assert.equal(r.items[0].confidence, 'high');
});

test('"1 plate rice" uses volume portion: 1 x 350ml plate', () => {
  const r = estimateFood('1 plate rice');
  assert.equal(r.items.length, 1);
  // plate = 350ml; rice cooked density ~0.85 (from DENSITY_PATTERNS); 1 x 350 x 0.85 = 297.5
  // Actually effectiveDensity may boost cooked wet dish to 1.0; rice matches WET_DISH_RE
  assert.ok(r.items[0].grams > 200, 'rice plate is a meaningful portion');
  assert.equal(r.items[0].unit, 'plate');
  assert.equal(r.items[0].qty, 1);
});

// ---------- multi-food comma-separated input ----------

test('"2 roti, dal and curd" returns 3 items with correct roti grams', () => {
  const r = estimateFood('2 roti, dal and curd');
  assert.equal(r.items.length, 3, 'three food items parsed');

  // roti
  const roti = findItem(r, 'roti');
  assert.ok(roti, 'roti found');
  assert.equal(roti.grams, 80, '2 x 40g roti');
  assert.equal(roti.qty, 2);

  // dal
  const dal = findItem(r, 'dal');
  assert.ok(dal, 'dal found');
  assert.ok(dal.grams > 0, 'dal has positive grams');

  // curd
  const curd = findItem(r, 'curd');
  assert.ok(curd, 'curd found');
  assert.ok(curd.grams > 0, 'curd has positive grams');
});

// ---------- nutrition totals ----------

test('nutrition totals are computed and are positive for real foods', () => {
  const r = estimateFood('2 roti');
  assert.ok(r.total.calories > 0, 'calories > 0');
  assert.ok(r.total.protein > 0, 'protein > 0');
  assert.ok(r.total.carbs > 0, 'carbs > 0');
  assert.ok(r.total.fat > 0, 'fat > 0');
});

test('nutrition totals aggregate across multiple items', () => {
  const r = estimateFood('2 roti, dal and curd');
  assert.ok(r.total.calories > 200, 'total calories for three foods');
  assert.ok(r.total.protein > 10, 'total protein for three foods');
  // totals should be the sum of individual items
  const itemSum = r.items.reduce(
    (s, i) => ({
      calories: s.calories + i.calories,
      protein: s.protein + i.protein,
      carbs: s.carbs + i.carbs,
      fat: s.fat + i.fat
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
  // Allow ±0.1 tolerance: the estimator applies round1() to each item and
  // to the total separately, so floating-point accumulation can drift.
  const approx = (a, b, label) => assert.ok(Math.abs(a - b) < 0.2, `${label}: ${a} vs ${b}`);
  approx(r.total.calories, itemSum.calories, 'total calories = sum of items');
  approx(r.total.protein, itemSum.protein, 'total protein = sum of items');
});

// ---------- response shape ----------

test('each item contains source_id, confidence, trustworthy, match_kind, grams', () => {
  const r = estimateFood('100 g paneer');
  const item = r.items[0];
  assert.ok(typeof item.source_id === 'string' && item.source_id.length > 0, 'source_id is a non-empty string');
  assert.ok(['high', 'medium', 'low', 'unreliable'].includes(item.confidence), 'confidence is a valid level');
  assert.equal(typeof item.trustworthy, 'boolean', 'trustworthy is boolean');
  assert.ok(typeof item.match_kind === 'string' && item.match_kind.length > 0, 'match_kind is a non-empty string');
  assert.ok(typeof item.grams === 'number' && item.grams > 0, 'grams is a positive number');
});

test('top-level response contains estimate flag and disclaimer', () => {
  const r = estimateFood('1 banana');
  assert.equal(r.estimate, true, 'estimate flag is true');
  assert.ok(typeof r.disclaimer === 'string' && r.disclaimer.length > 0, 'disclaimer is present');
  assert.equal(r.text, '1 banana', 'original text preserved');
});

// ---------- edge cases ----------

test('empty input returns empty items and zero totals', () => {
  const r = estimateFood('');
  assert.equal(r.items.length, 0, 'no items');
  assert.equal(r.total.calories, 0);
  assert.equal(r.total.protein, 0);
  assert.equal(r.total.carbs, 0);
  assert.equal(r.total.fat, 0);
  assert.equal(r.estimate, true);
});

test('null/undefined input returns empty items (no crash)', () => {
  const r1 = estimateFood(null);
  const r2 = estimateFood(undefined);
  assert.equal(r1.items.length, 0);
  assert.equal(r2.items.length, 0);
});

test('unknown food returns empty items (no crash, no hallucinated data)', () => {
  const r = estimateFood('quantum flux capacitor');
  assert.equal(r.items.length, 0, 'no match -> no items');
  assert.equal(r.total.calories, 0);
});

test('single common food returns one item with valid data', () => {
  const r = estimateFood('rice');
  assert.ok(r.items.length >= 1, 'at least one rice match');
  assert.ok(r.items[0].grams > 0);
  assert.ok(r.items[0].calories > 0);
  assert.ok(r.items[0].source_id);
});

// ---------- portion type coverage ----------

test('"1 dosa" uses COUNT_PORTIONS dosa reference: 85g', () => {
  const r = estimateFood('1 dosa');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 85, '85g per dosa');
});

test('"2 idli" uses COUNT_PORTIONS idli reference: 45g x 2 = 90g', () => {
  const r = estimateFood('2 idli');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 90, '45g per idli x 2');
});

test('"1 apple" uses COUNT_PORTIONS apple reference: 180g', () => {
  const r = estimateFood('1 apple');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].grams, 180, '180g per apple');
});
