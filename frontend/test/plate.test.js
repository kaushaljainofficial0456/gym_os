import { describe, it, expect } from 'vitest';
import {
  fromPlateItem, fromSearchFood, fromUsual, priceItem, plateTotals, stepQty, switchUnit,
  amountLabel, toLogItems, dayList, mealGroup, slotForTime, looksLikeMeal, setOil, unitGramsHint, fromAIEstimate,
} from '../src/components/nutrition/logger/plate.js';

// Shapes as POST /me/nutrition/describe returns them.
const roti = fromPlateItem({
  name: 'Roti / Chapati', source_id: 'indb:ASC096', staple_key: 'roti', confidence: 'high',
  per100: { calories: 202.5, protein: 7, carbs: 34.9, fat: 4.7 },
  units: [{ key: 'staple_roti', label: 'roti', grams: 40 }, { key: 'g', label: 'g', grams: 1 }],
  unit_key: 'staple_roti', qty: 2,
});
const milk = fromPlateItem({
  name: 'Milk (toned)', per100: { calories: 61, protein: 3.27, carbs: 4.63, fat: 3.2 },
  units: [{ key: 'typed', label: 'ml', grams: 1.03 }, { key: 'staple_glass', label: 'glass', grams: 250 }, { key: 'g', label: 'g', grams: 1 }],
  unit_key: 'typed', qty: 200,
});

describe('pricing', () => {
  it('prices by grams of the chosen unit', () => {
    expect(priceItem(roti)).toEqual({ grams: 80, calories: 162, protein: 5.6, carbs: 27.9, fat: 3.8 });
  });

  it('a past log scales by its OWN quantity, not an assumed 100 g', () => {
    const chai = fromUsual({ name: 'Chai', quantity: 2, unit: 'cup', calories: 180, protein: 6, carbs: 26, fat: 6 });
    expect(priceItem(chai).calories).toBe(180);
    expect(priceItem({ ...chai, qty: 1 }).calories).toBe(90);
    // No quantity on record: it is one serving, and stays one.
    const old = fromUsual({ name: 'Thali', calories: 700, protein: 20, carbs: 90, fat: 25 });
    expect(old.qty).toBe(1);
    expect(priceItem(old).calories).toBe(700);
  });

  it('totals add up item by item', () => {
    expect(plateTotals([roti, milk]).calories).toBe(162 + Math.round(0.61 * 206));
  });
});

describe('amount controls', () => {
  it('steps whole pieces, and halves below two', () => {
    expect(stepQty(roti, +1)).toBe(3);
    expect(stepQty(roti, -1)).toBe(1);
    expect(stepQty({ ...roti, qty: 1 }, -1)).toBe(0.5);
    expect(stepQty({ ...roti, qty: 0.5 }, -1)).toBe(0.5);   // never to zero
  });

  it('steps millilitres in 50s and grams in 10s', () => {
    expect(stepQty(milk, +1)).toBe(250);
    const g = switchUnit(roti, 'g');
    expect(stepQty(g, +1)).toBe(90);
  });

  it('switching unit keeps the amount of food the same', () => {
    const g = switchUnit(roti, 'g');
    expect(g.qty).toBe(80);
    expect(priceItem(g).calories).toBe(priceItem(roti).calories);
    const glass = switchUnit(milk, 'staple_glass');
    expect(glass.qty).toBe(1);                              // 206 g ~ 0.82 glass -> rounds to 1
  });

  it('labels the amount the way it will be stored', () => {
    expect(amountLabel(roti)).toBe('2 roti');
    expect(amountLabel(switchUnit(roti, 'g'))).toBe('80 g');
  });
});

describe('search results join the plate at their default portion', () => {
  it('uses the portion the server marked default, with grams always available', () => {
    const banana = fromSearchFood({
      name: 'Banana', calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3,
      portions: [{ key: 'staple_banana', label: 'banana', grams: 120, default: true }, { key: 'katori', label: 'Katori', grams: 0 }],
    });
    expect(banana.unitKey).toBe('staple_banana');
    expect(banana.units.map((u) => u.key)).toEqual(['staple_banana', 'g']);   // a 0 g portion is dropped
    expect(priceItem(banana).calories).toBe(107);
  });
});

describe('logging', () => {
  it('every row carries its quantity and unit', () => {
    const rows = toLogItems([roti, switchUnit(milk, 'g')]);
    expect(rows[0]).toMatchObject({ name: 'Roti / Chapati', quantity: 2, unit: 'roti', calories: 162, confidence: 'high' });
    expect(rows[1]).toMatchObject({ quantity: 206, unit: 'g' });
  });
});

describe('the day', () => {
  it('folds every slot name into four meals', () => {
    expect(['breakfast', 'Lunch', 'mid_morning', 'post_workout', 'Snack', 'dinner', 'before_bed', null].map(mealGroup))
      .toEqual(['breakfast', 'lunch', 'snack', 'snack', 'snack', 'dinner', 'dinner', 'snack']);
  });

  it('is one list in the order the day happened, totalling only what was eaten', () => {
    const day = dayList([
      { id: 'd', slot: 'dinner', calories: 500, protein: 30, carbs: 50, fat: 15, eaten: true },
      { id: 's1', slot: 'Snack', calories: 90, protein: 3, carbs: 13, fat: 3, eaten: true },
      { id: 'b1', slot: 'breakfast', calories: 300, protein: 10, carbs: 40, fat: 8, eaten: true },
      { id: 'b2', slot: 'breakfast', calories: 200, protein: 5, carbs: 20, fat: 5, eaten: false },
      { id: 's2', slot: 'post_workout', calories: 120, protein: 24, carbs: 3, fat: 1, eaten: true },
    ]);
    // Breakfast before snacks before dinner; arrival order kept within a meal.
    expect(day.items.map((m) => m.id)).toEqual(['b1', 'b2', 's1', 's2', 'd']);
    expect(day.eatenCount).toBe(4);
    expect(day.total).toEqual({ calories: 1010, protein: 67, carbs: 106, fat: 27 });
  });

  it('an empty day is an empty list, not an error', () => {
    expect(dayList(undefined)).toEqual({ items: [], total: { calories: 0, protein: 0, carbs: 0, fat: 0 }, eatenCount: 0 });
  });

  it('guesses the meal from the clock', () => {
    const at = (h) => new Date(2026, 9, 20, h, 0);
    expect([7, 13, 17, 21, 2].map((h) => slotForTime(at(h)))).toEqual(['breakfast', 'lunch', 'snack', 'dinner', 'snack']);
  });

  it('tells a meal description from a food name', () => {
    expect(looksLikeMeal('2 roti and dal')).toBe(true);
    expect(looksLikeMeal('paneer')).toBe(false);
  });
});

describe('accuracy aids', () => {
  const dal = fromPlateItem({
    name: 'Dal', per100: { calories: 145, protein: 8.6, carbs: 19.2, fat: 4.31 },
    oil: { options: [
      { key: 'less', per100: { calories: 127.5, protein: 8.8, carbs: 19.7, fat: 2 } },
      { key: 'more', per100: { calories: 185, protein: 8.2, carbs: 18.3, fat: 9.9 } },
    ] },
    units: [{ key: 'staple_katori', label: 'katori', grams: 150 }, { key: 'g', label: 'g', grams: 1 }],
    unit_key: 'staple_katori', qty: 1, assumed: true,
  });

  it('prices an oil choice from the server-supplied values, at the same grams', () => {
    expect(priceItem(dal)).toMatchObject({ grams: 150, calories: 218 });
    expect(priceItem(setOil(dal, 'less'))).toMatchObject({ grams: 150, calories: 191, fat: 3 });
    expect(priceItem(setOil(dal, 'more')).calories).toBe(278);
    expect(priceItem(setOil(setOil(dal, 'more'), null)).calories).toBe(218);   // back to as measured
  });

  it('refuses an oil choice the food does not have', () => {
    expect(setOil(roti, 'more')).toBe(roti);
    expect(roti.oil).toBe(null);
  });

  it('says which dal it was in the logged name', () => {
    expect(toLogItems([setOil(dal, 'less')])[0].name).toBe('Dal · less oil');
    expect(toLogItems([dal])[0].name).toBe('Dal');
  });

  it('marks amounts nobody chose', () => {
    expect(dal.assumed).toBe(true);
    expect(roti.assumed).toBe(false);
    expect(fromSearchFood({ name: 'Banana', calories: 89, portions: [] }).assumed).toBe(true);
    expect(fromUsual({ name: 'Chai', quantity: 1, unit: 'cup', calories: 90 }).assumed).toBe(false);
  });

  it('shows what one of a unit weighs, but not for g or ml', () => {
    expect(unitGramsHint({ key: 'staple_katori', label: 'katori', grams: 150 })).toBe('150 g');
    expect(unitGramsHint({ key: 'g', label: 'g', grams: 1 })).toBe(null);
    expect(unitGramsHint({ key: 'typed', label: 'ml', grams: 1.03 })).toBe(null);
    expect(unitGramsHint({ key: 'staple_almond', label: 'almond', grams: 1.2 })).toBe('1.2 g');
    expect(unitGramsHint({ key: 'own', label: 'cup', perUnit: {} })).toBe(null);
  });
});

describe('AI estimates on the plate', () => {
  const res = {
    ok: true, food_name: 'Jollof rice', confidence: 'medium',
    serving: { estimated_weight_g: 400, description: 'plate' },
    totals: { calories: 640, protein: 16, carbs: 112, fat: 14 },
    ai: { provider: 'groq', model: 'llama-x' },
  };

  it('is one serving as the AI sized it, re-priceable by grams', () => {
    const it = fromAIEstimate(res);
    expect(it.origin).toBe('ai');
    expect(priceItem(it)).toMatchObject({ grams: 400, calories: 640, protein: 16 });
    expect(priceItem({ ...it, qty: 0.5 }).calories).toBe(320);
    expect(priceItem(switchUnit(it, 'g')).calories).toBe(640);
  });

  it('is logged as an estimate, with the AI that made it', () => {
    const [row] = toLogItems([fromAIEstimate(res)]);
    expect(row).toMatchObject({ source: 'ai_estimated', ai_provider: 'groq', ai_model: 'llama-x', confidence: 'medium', quantity: 1, unit: 'plate' });
    const [half] = toLogItems([{ ...fromAIEstimate(res), qty: 0.5 }]);
    expect(half.source).toBe('ai_estimated_user_adjusted');
  });

  it('a measured food is never logged as an estimate', () => {
    expect(toLogItems([roti])[0]).toMatchObject({ source: 'manual' });
    expect(toLogItems([roti])[0].ai_provider).toBeUndefined();
  });
});
