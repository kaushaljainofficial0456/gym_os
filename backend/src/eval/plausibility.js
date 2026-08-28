// ============================================================
// FOOD BENCHMARK — EVAL-SIDE PLAUSIBILITY JUDGE
//
// This is NOT the future engine plausibility stage. It lives entirely in the
// benchmark harness and is used ONLY to score two metrics:
//   * plausibility false negatives — a returned estimate this judge considers
//     nutritionally implausible that the engine nonetheless delivered with
//     high/medium confidence  ("a confident wrong answer slipped through")
//   * plausibility false positives — a returned estimate that IS inside the
//     case's own acceptable nutrition range but that this judge would reject
//     anyway  (measures whether these ranges are themselves too tight)
//
// The FP metric exists so the ranges below can be validated against V1's
// known-good outputs BEFORE any V2 phase relies on a real plausibility stage.
//
// Ranges are per (primary category, coarse prep state), expressed per 100 g of
// the AS-SERVED food, plus a per-serving kcal band. Deliberately WIDE — they
// bound "this is the wrong kind of food / a unit error", not "this is a
// slightly unusual recipe".
// ============================================================
'use strict';

// [kcal/100g lo, hi], [protein g/100g lo, hi], [carb …], [fat …], [serving kcal lo, hi]
// prep key: 'raw' | 'cooked' | 'fried' | 'any'
const TABLE = {
  single_ingredient: {
    raw:    { kcal: [8, 620],  p: [0, 30], c: [0, 90], f: [0, 60], serving: [5, 900] },
    cooked: { kcal: [20, 420], p: [0, 35], c: [0, 55], f: [0, 40], serving: [20, 700] },
    fried:  { kcal: [90, 600], p: [0, 35], c: [0, 60], f: [3, 55], serving: [40, 800] },
    any:    { kcal: [8, 620],  p: [0, 35], c: [0, 90], f: [0, 60], serving: [5, 900] },
  },
  prepared_food: {
    raw:    { kcal: [20, 400], p: [0, 30], c: [0, 60], f: [0, 30], serving: [20, 700] },
    cooked: { kcal: [40, 380], p: [1, 32], c: [0, 55], f: [0, 28], serving: [40, 900] },
    fried:  { kcal: [120, 560], p: [1, 32], c: [0, 60], f: [4, 45], serving: [60, 900] },
    any:    { kcal: [20, 560], p: [0, 32], c: [0, 60], f: [0, 45], serving: [20, 900] },
  },
  composite_dish: {
    // wet dishes (dal, curry, soup) run low kcal/100g; dry/fried composites (pakora
    // plate, fried rice, biryani) run higher. One wide band spans both.
    cooked: { kcal: [30, 340], p: [1, 22], c: [1, 45], f: [0.5, 28], serving: [80, 1400] },
    fried:  { kcal: [120, 420], p: [1, 20], c: [3, 55], f: [4, 32], serving: [120, 1400] },
    any:    { kcal: [30, 420], p: [1, 22], c: [1, 55], f: [0.5, 32], serving: [80, 1400] },
  },
  meal: {
    any: { kcal: [40, 320], p: [1, 22], c: [2, 45], f: [0.5, 26], serving: [150, 2200] },
  },
  beverage: {
    any: { kcal: [0, 160], p: [0, 12], c: [0, 30], f: [0, 12], serving: [0, 900] },
  },
  snack: {
    any: { kcal: [180, 620], p: [1, 30], c: [2, 85], f: [1, 45], serving: [40, 700] },
  },
  dessert: {
    any: { kcal: [80, 560], p: [0, 18], c: [8, 80], f: [0, 40], serving: [40, 700] },
  },
  sauce_condiment: {
    any: { kcal: [10, 700], p: [0, 30], c: [0, 80], f: [0, 75], serving: [3, 300] },
  },
  nonfood_or_malformed: {
    any: { kcal: [0, 0], p: [0, 0], c: [0, 0], f: [0, 0], serving: [0, 0] },
  },
};

function coarsePrep(prep) {
  const p = String(prep || 'any').toLowerCase();
  if (p === 'raw') return 'raw';
  if (p === 'fried') return 'fried';
  if (['boiled', 'steamed', 'grilled', 'roasted', 'baked', 'cooked', 'cooked_wet',
       'cooked_dry', 'ready_to_eat'].includes(p)) return 'cooked';
  return 'any';
}

function pickRange(primary, prep) {
  const byCat = TABLE[primary] || TABLE.prepared_food;
  return byCat[coarsePrep(prep)] || byCat.any || TABLE.prepared_food.any;
}

const outside = (v, [lo, hi], slack = 0) =>
  v != null && (v < lo * (1 - slack) || v > hi * (1 + slack));

/**
 * Judge a single returned estimate.
 * @param {{kcal:number, protein_g:number, carb_g:number, fat_g:number, grams:number}} est
 * @param {{primary:string, prep:string}} caseInfo
 * @returns {{ plausible:boolean, reasons:string[] }}
 */
export function judgePlausible(est, caseInfo) {
  const reasons = [];
  const g = Number(est.grams) || 0;
  const kcal = Number(est.kcal);
  if (!(g > 0) || !Number.isFinite(kcal)) {
    return { plausible: false, reasons: ['no usable grams/kcal'] };
  }
  const r = pickRange(caseInfo.primary, caseInfo.prep);
  const per100 = (x) => (x == null ? null : (Number(x) / g) * 100);

  const k100 = per100(kcal), p100 = per100(est.protein_g),
        c100 = per100(est.carb_g), f100 = per100(est.fat_g);

  // 10% slack on density bounds, 0 on the per-serving ceiling.
  if (outside(k100, r.kcal, 0.10)) reasons.push(`kcal density ${Math.round(k100)}/100g outside ${r.kcal[0]}–${r.kcal[1]}`);
  if (outside(p100, r.p, 0.10))   reasons.push(`protein density ${p100?.toFixed(1)}/100g outside ${r.p[0]}–${r.p[1]}`);
  if (outside(c100, r.c, 0.10))   reasons.push(`carb density ${c100?.toFixed(1)}/100g outside ${r.c[0]}–${r.c[1]}`);
  if (outside(f100, r.f, 0.10))   reasons.push(`fat density ${f100?.toFixed(1)}/100g outside ${r.f[0]}–${r.f[1]}`);
  if (outside(kcal, r.serving, 0.10)) reasons.push(`serving ${Math.round(kcal)} kcal outside ${r.serving[0]}–${r.serving[1]}`);

  // Atwater self-consistency (mathematical, separate from category plausibility).
  if ([est.protein_g, est.carb_g, est.fat_g].every((x) => x != null)) {
    const atwater = est.protein_g * 4 + est.carb_g * 4 + est.fat_g * 9;
    if (atwater > 0) {
      const ratio = kcal / atwater;
      if (ratio < 0.55 || ratio > 1.9) reasons.push(`Atwater ratio ${ratio.toFixed(2)} (kcal vs 4P+4C+9F)`);
    }
  }
  return { plausible: reasons.length === 0, reasons };
}

export { pickRange as _pickRange };
