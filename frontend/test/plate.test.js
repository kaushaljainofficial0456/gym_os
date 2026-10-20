import { describe, it, expect } from 'vitest';
import {
  fromPlateItem, fromSearchFood, fromUsual, priceItem, plateTotals, stepQty, switchUnit,
  amountLabel, toLogItems, groupDay, mealGroup, slotForTime, looksLikeMeal,
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

  it('subtotals only what was eaten', () => {
    const day = groupDay([
      { slot: 'breakfast', calories: 300, protein: 10, carbs: 40, fat: 8, eaten: true },
      { slot: 'breakfast', calories: 200, protein: 5, carbs: 20, fat: 5, eaten: false },
      { slot: 'dinner', calories: 500, protein: 30, carbs: 50, fat: 15, eaten: true },
    ]);
    expect(day.map((g) => [g.key, g.items.length, g.total.calories])).toEqual([
      ['breakfast', 2, 300], ['lunch', 0, 0], ['snack', 0, 0], ['dinner', 1, 500],
    ]);
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
