# MODEL CARD — skos-food-v1

**Version:** 1.0 · **Schema:** `food-v1` · **Owner:** Sambhav (ML)
**Status:** built and measured; **not integrated** — `backend/`, `database/` and
`frontend/` are untouched.

---

## 1. What it does

Estimates energy, macronutrients and micronutrients for a food a user logs, from
a text query, an optional portion, an optional ingredient list, and an optional
oil level.

It replaces `backend/src/services/foodEstimator.js` — a 22-item hardcoded list
with hand-typed macros, no citations, and a regex matcher, whose own header
calls it an MVP placeholder.

## 2. How it estimates — three tiers, tried in order

| Tier | Mechanism | Measured accuracy |
|---|---|---|
| **1 — database match** | Exact/alias lookup over 21,353 foods | The lab measurement itself |
| **2 — compositional** | User's ingredients → grams → summed measured foods → cooking yield | **25.7% median APE** (main dishes), bias 1.01× |
| **3 — retrieval fallback** | kNN over food-name text; returns real measured neighbours | 14.9% (known family) / 21.6% (novel) |

Only tier 3 is *trained* (14,519 clean rows). Tiers 1–2 are lookup and
arithmetic over lab measurements, which is precisely why they are more accurate.

## 3. Headline accuracy, and how it was measured

**25.1% median APE, 50% within 25%, on high-confidence matches.**

Method: all 506 lab-measured IFCT 2017 Indian foods are **removed from the
database**, then queried by common name. The system must answer from USDA +
INDB + CNF + Open Food Facts alone — different labs, countries, samples and
analytical methods. Resolution rate **74.9%**.

**A retrieval failure counts as an error.** To a user, the right number for the
wrong food is simply wrong.

| Confidence | n | median APE | within 25% |
|---|---:|---:|---:|
| high | 96 | **25.1%** | 50.0% |
| medium | 136 | 56.5% | 35.3% |
| low | 139 | 44.7% | 30.9% |

**This is a conservative lower bound.** Part of the spread is genuine biology —
IFCT sampled Indian cultivars, USDA sampled American ones. An Indian papaya is
not a US papaya.

### The measured floor

Foods sharing a head noun genuinely differ by **16.9% median**. Tier 3 sits at
14.9–21.6%, i.e. **near-optimal for its input**. Further model tuning buys
almost nothing; widening tier 1 coverage is the real lever.

## 4. Data sources

| Source | Rows | Licence | Role |
|---|---:|---|---|
| USDA FoodData Central | 12,890 | Public domain | Global foods, raw/cooked pairs, FNDDS dishes |
| Canadian Nutrient File | 4,944 | Open Government Licence – Canada | Generic foods, household measures |
| Open Food Facts (India) | 2,009 | ODbL (attribution + share-alike) | Packaged/branded products |
| INDB | 1,004 | Open academic | Indian composite dishes + serving sizes |
| IFCT 2017 (NIN/ICMR) | 506 | NIN primary publication | Indian ingredients + full micronutrient panel |

**Deliberately not used:** the digitised IFCT repo `github.com/ifct2017/compositions`
is **AGPL-3.0**. For a closed-source backend served over a network that can
oblige releasing the entire backend, and it offers **no data advantage** over
NIN's own PDF — the risk buys nothing.

## 5. Known limitations

1. **Not lab-grade, and no name-based system can be.** A samosa varies ~2× on
   oil absorption, a curry ~3× on cream and ghee. That information is not in
   the string.
2. **Tier 3 must always be labelled an estimate.** It beats guessing but a
   50%-error number shown next to lab values discredits both.
3. **Condiments have weak per-serving figures** — 52.4% median error vs 25.7%
   for main dishes, because a "serving" of chutney is a teaspoon of a batch.
   Whole-batch totals remain reliable; flagged via `serving_caveat`.
4. **19.1% of foods have no cooking state.** Left unspecified deliberately —
   a wrong state is worse than a missing one, because search acts on it.
5. **223 rows are flagged `trustworthy: false`**, mostly INDB dishes that count
   the deep-frying oil bath as eaten (Dum aloo reads 4,576 kcal/serving). They
   are flagged, not deleted and not silently corrected — there is no basis to
   invent a replacement.
6. **Micronutrient coverage is partial** and concentrated in IFCT's 506 Indian
   foods. A null means *not measured*, never zero.
7. **3 dishes are absent from every source** (`rogan josh`, `vindaloo`,
   `jalebi`). Tier 2 handles them when the user supplies ingredients.
8. **Tier 3 is not ported to JS** — the JS reference covers tiers 1–2 and oil.

## 6. Do not use this for

- **Clinical or medical nutrition.** Not validated for therapeutic diets,
  diabetes management, renal diets, or any condition where a nutrient error has
  a health consequence.
- **Infant feeding or formula.**
- **Allergen determination.** Nothing here is an allergen database, and a
  missing ingredient is not evidence of absence.
- **Regulatory nutrition labelling.**
- **Presenting a tier-3 estimate as a measurement.**

## 7. Correctness practices worth carrying forward

Every significant defect found in this model surfaced from a **measurement or a
specific real food looking wrong**, never from reading code:

| Defect | Would have shipped as |
|---|---|
| Table parser split `1278±61` | Paneer at **66 kcal/100 g** instead of 305 |
| 66% of IFCT names corrupted by extraction | "amaranth **leav es**" — unsearchable |
| Amino acids assumed per-100g-food | Leucine **100× too low** |
| Confidence thresholds | Labels **inverted** — "high" less accurate than "medium" |
| `\b` became literal backspace bytes via heredoc | A safety guard that was **dead code while appearing to work** |
| OFF API path lacked an energy cap | A muesli at **955 kcal/100 g** (physically impossible) |

Consequently: **nothing is invented to fill a gap.** Missing nutrients stay
null; unresolvable ingredients are reported, not substituted; terms with no
trustworthy match are left unmapped rather than pointed at an approximation.

## 7b. Portion sizes

Users log "1 katori", not "150 g", so the model offers a weighing-scale gram
entry **and** ~22 household portions (spoons, bowls, plates, glassware, counted
items like roti/dosa/egg).

A portion is a **volume**, so grams are computed per food: a medium bowl of dal
is 250 g and of spinach 62 g. Volumes are calibrated against ~900 real INDB
serving weights — overall bias **0.94** (bowl 0.95, plate 0.98, tablespoon 0.93).

**Precision is reported honestly.** A "bowl" is not a defined unit; real ones
span 166–354 g in the measured data, and that spread ships as
`observed_range_g` rather than being hidden behind a single number.

Count portions are deliberately **not** calibrated against INDB, because its
"1 egg" for boiled egg is 151 g — the dish with accompaniments, not one egg.

## 8. Tests

| Suite | Checks |
|---|---|
| `ml/tests/test_food_model.py` | **70** — database integrity, ranking, units, portions, oil, ingredient resolution, regex guards |
| `ml/models/skos-food-v1/foodEstimate.test.js` | **42** — same invariants in JS, so Python/JS divergence fails loudly |

The Python suite found three real data bugs on its first run (impossible energy,
duplicate `source_id`s, negative carbohydrate), all fixed before this release.

## 9. Reference

| Thing | Path |
|---|---|
| Integration contract | `ml/docs/CONTRACT_skos-food-v1.md` |
| Full results and method | `ml/docs/FOOD_MODEL_V1_PROGRESS.md` |
| Database (21,353 foods) | `ml/data/processed/unified_food_db.json` |
| JS reference implementation | `ml/models/skos-food-v1/foodEstimate.reference.js` |
| Python inference | `ml/src/inference/` |
| Benchmarks | `ml/src/validation/` |
