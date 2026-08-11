// ============================================================
// AI FOOD LOGGING — deterministic estimator for the MVP.
// Parses free text ("2 rotis, dal and curd") against a small Indian
// food table and returns per-item + total estimates. Every result is
// labeled estimate:true — the client UI must badge it as an estimate.
// Swap the internals for a vision/LLM food-recognition API later;
// the contract (estimate(text) => {items, total, estimate:true}) stays.
// ============================================================
const FOODS = [
  { match: 'roti|chapati|phulka', name: 'Roti', kcal: 120, p: 3, c: 22, f: 3, unit: '1 roti' },
  { match: 'rice', name: 'Rice', kcal: 130, p: 3, c: 28, f: 0.5, unit: '1 bowl (150g)' },
  { match: 'dal', name: 'Dal', kcal: 110, p: 7, c: 16, f: 3, unit: '1 bowl' },
  { match: 'curd|dahi|yogurt|yoghurt', name: 'Curd', kcal: 60, p: 3, c: 5, f: 3, unit: '100 g' },
  { match: 'paneer', name: 'Paneer', kcal: 265, p: 18, c: 6, f: 21, unit: '100 g' },
  { match: 'egg', name: 'Egg', kcal: 75, p: 6, c: 0.5, f: 5, unit: '1 egg' },
  { match: 'chicken', name: 'Chicken', kcal: 165, p: 31, c: 0, f: 3.6, unit: '100 g' },
  { match: 'banana', name: 'Banana', kcal: 105, p: 1.3, c: 27, f: 0.3, unit: '1 medium' },
  { match: 'whey', name: 'Whey scoop', kcal: 120, p: 24, c: 3, f: 1.5, unit: '1 scoop' },
  { match: 'milk', name: 'Milk', kcal: 60, p: 3.2, c: 4.8, f: 3.3, unit: '100 ml' },
  { match: 'poha', name: 'Poha', kcal: 250, p: 5, c: 45, f: 6, unit: '1 plate' },
  { match: 'idli', name: 'Idli', kcal: 55, p: 2, c: 11, f: 0.2, unit: '1 idli' },
  { match: 'dosa', name: 'Dosa', kcal: 130, p: 3, c: 22, f: 3, unit: '1 plain dosa' },
  { match: 'upma', name: 'Upma', kcal: 220, p: 5, c: 35, f: 8, unit: '1 bowl' },
  { match: 'chole', name: 'Chole', kcal: 190, p: 9, c: 25, f: 7, unit: '1 bowl' },
  { match: 'rajma', name: 'Rajma', kcal: 180, p: 8, c: 24, f: 6, unit: '1 bowl' },
  { match: 'sabzi|bhaji|vegetable', name: 'Sabzi', kcal: 90, p: 2, c: 10, f: 5, unit: '1 bowl' },
  { match: 'sprouts|moong', name: 'Sprouts', kcal: 105, p: 9, c: 17, f: 0.5, unit: '100 g' },
  { match: 'oats', name: 'Oats', kcal: 150, p: 5, c: 27, f: 3, unit: '40 g' },
  { match: 'peanut', name: 'Peanuts', kcal: 90, p: 4, c: 2, f: 8, unit: '15 g' },
  { match: 'almond', name: 'Almonds', kcal: 70, p: 2.5, c: 2.5, f: 6, unit: '10 almonds' },
  { match: 'apple', name: 'Apple', kcal: 95, p: 0.5, c: 25, f: 0.3, unit: '1 medium' },
  { match: 'bread', name: 'Bread slice', kcal: 80, p: 3, c: 14, f: 1, unit: '1 slice' }
];

import { round1 } from '../utils/time.js';

export function estimateFood(text) {
  const lower = String(text || '').toLowerCase();
  const items = [];
  let total = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const f of FOODS) {
    const re = new RegExp(f.match, 'i');
    if (re.test(lower)) {
      const qtyRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*x?\\s*${f.name}`, 'i');
      const m = lower.match(qtyRe);
      const qty = m ? Number(m[1]) : 1;
      const cal = Math.round(f.kcal * qty);
      const p = f.p ?? f.protein ?? 0, c = f.c ?? f.carbs ?? 0, ft = f.f ?? f.fat ?? 0;
      items.push({ name: f.name, unit: f.unit, qty, calories: cal, protein: round1(p * qty), carbs: round1(c * qty), fat: round1(ft * qty) });
      total.calories += cal;
      total.protein += p * qty;
      total.carbs += c * qty;
      total.fat += ft * qty;
    }
  }
  return {
    text,
    items,
    total: {
      calories: Math.round(total.calories),
      protein: round1(total.protein),
      carbs: round1(total.carbs),
      fat: round1(total.fat)
    },
    estimate: true,
    disclaimer: 'AI-estimated values — approximate. Confirm with the actual pack/recipe when possible.'
  };
}
