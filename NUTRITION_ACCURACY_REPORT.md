# Nutrition Accuracy Report — Phase 2

Branch `feature/nutrition-engine-overhaul` · 2026-11-16 · live engine `foodEstimator.js` (skos-food-v1, deterministic)

This report covers **calorie and macro accuracy**: raw vs cooked, dry vs prepared, oil, recipe yield, double counting and missing values. Every number below comes from running the engine or the benchmark at the stated commit. Nothing is projected. Where a claim needs data this repository does not have, it is marked **Requires external validation**.

Status keys: **Completed** · **Partially completed** · **Not implemented** · **Blocked** · **Requires external validation**.

---

## 1. Headline: what the benchmark can and cannot show

The benchmark has 324 cases (v1) and 534 cases (v2). Its ground truth comes in three kinds:

1. A database row scaled to the stated weight (`db_row_scaled` / `db_sum_scaled`).
2. A published range.
3. A standard portion.

**Circularity.** When the engine prices a case from **the same row** the reference was taken from, the case can only test arithmetic and portion handling, never composition. Those cases score about 98% by construction and inflate the headline. The split is therefore reported separately: same-row cases versus cases whose reference comes from another row or source. The script is `indep.mjs` in the session scratchpad. It applies the dataset's own `resolved_source_id` against the engine's chosen `source_id`.

### kcal accuracy, nutrition-scored cases

Both columns use the current corrected datasets.

| View | Phase 1 final (`ab44aae`) | Now (`8569add` + this report) |
|---|---|---|
| **v1** all (n=306): in-range / MAE | 69.0% / 54.1 kcal | **72.4% / 50.1 kcal** |
| v1 same-row only (n≈48) | 91.7% / 5.1 | 97.9% / 0.1 |
| **v1 independent references (n≈258)** | **64.7% / 63.5 kcal** | **67.6% / 59.5 kcal** |
| **v2** all (n=426) | 75.1% / 41.2 | **78.2% / 37.7** |
| **v2 independent references (n≈312)** | **67.3% / 55.3 kcal** | **70.3% / 51.9 kcal** |
| v2 independent, `standard_portion` ground truth (n=91) | 62.6% / 111.6 kcal | 67.0% / 104.2 kcal |
| v2 independent, `published_range` (n=93) | 75.3% / 36.0 | 76.5% / 35.9 |
| v2 independent, other database row (n≈108) | 60.9% / 31.8 | 64.5% / 27.9 |

**Weighted benchmark score:** v1 83.9% and v2 87.0% (baselines re-frozen 2026-11-15; see the log in `ml/data/benchmark/README.md`).

**Reading this honestly**

- About 7 in 10 independently referenced cases land in their kcal range. The typical miss is 50–60 kcal.
- The largest remaining error source is **portion** (standard-portion cases: MAE 104 kcal), not composition.
- The "in-range" windows are ±18–30%. "In range" does not mean exact.
- None of these cases is a real photographed or weighed plate from a user. Real-world accuracy is **Requires external validation**; see `NUTRITION_REAL_WORLD_VALIDATION.md`.

---

## 2. Defects fixed in Phase 2, before vs after

These are actual engine outputs: Phase 1 final (`ab44aae`, left) and now (right). An asterisk (*) marks an assumed amount. Each line is pinned by a test, in `foodStateAndAmounts.test.js`, `foodRecipes.test.js`, `plateAccuracy.test.js`, `nutritionAccuracy.test.js` or `foodCoverage.test.js`.

| Input | Phase 1 final | Now |
|---|---|---|
| 100g raw rice | Murmura (puffed rice) **113 kcal** | Rice (raw, uncooked) **365 kcal** |
| 50g uncooked moong dal | a cooked moong dal **27 kcal** | Moong dal (raw, dry, IFCT) **163 kcal** |
| 50g dry chana | **Cabbage rolls** 71 kcal | Chana, whole (raw, dry, IFCT) 144 kcal |
| 100g raw potato | **Potato pancake** 196 kcal | Potato (raw, IFCT) 70 kcal |
| 100g atta | **Atta dal burfi** 299 kcal | Wheat flour, atta (IFCT) 320 kcal |
| 50g suji | **Semolina dosa** 114 kcal | Semolina, dry (IFCT) 167 kcal |
| 50g raw oats | **Birthday Cake Protein Oats** | Oats (dry) 195 kcal |
| 100g cooked soya chunks | dry chunks **331 kcal** | soaked/boiled 110 kcal |
| 1 bowl oats | 250 g of **dry** oats, **973 kcal** | cooked oats, 213 kcal |
| 1 katori soya chunks | dry chunks **496 kcal** | soaked chunks 165 kcal |
| chicken breast 200g | **100 g\*** (the 200 g was lost) | 200 g, 330 kcal |
| paneer 100 g / dal 1 bowl | **unresolved** | 305 kcal / 218 kcal |
| roti 2 | roti + **"2-Minute noodles"** 465 kcal | 2 roti, 162 kcal |
| 1 bowl dal | 363 kcal (USDA "Dal", 145/100 g) | 218 kcal (home dal, 87/100 g; §4) |
| 1 katori kheer | **401 g**, 301 kcal (a bowl-sized serving) | 150 g, 113 kcal |
| 2 large eggs | 200 g\*, 296 kcal | 100 g, 155 kcal |
| sabudana khichdi | khichdi **twice** (sago + rice khichdi), 866 kcal | one dish, 374 kcal |
| Had chicken biryani, half a plate, with raita | biryani 300 g\* + **USDA veal** + potato raita, 770 kcal | biryani 150 g + cucumber raita, 315 kcal |
| 1 plate mutton curry | 693 kcal (198/100 g hand value) | 482 kcal (computed, 138/100 g) |
| raw mango | **raw mango chutney** 193 kcal | green mango (IFCT) 74 kcal |
| I had a plate of poha with peanuts and one cup of tea | poha 98 g + peanuts 30 g\* + chai = 437 | poha 245 g + peanuts 10 g\* (topping) + chai = 591 |

The last row is not a simple improvement. In Phase 1, "a plate" of poha used a 98 g row serving, which is too small for a plate. P2-2 made the container a plate (245 g), which raised the meal total. The peanuts went down from a 30 g handful to a 10 g topping, because we cannot tell whether INDB's poha recipe already includes them (§6). Both are documented assumptions.

---

## 3. Raw vs cooked, dry vs prepared — **Completed** for the listed staples, **Partially completed** overall

**Mechanism** (`food/staples.js`):

- Every curated staple has a **cooking state**: cooked, raw, dry, ripe, or any.
- 13 measured raw/dry staples are pinned by source id to IFCT 2017 or USDA rows:
  - rice: white and brown
  - dals: toor, moong, urad, chana and masoor
  - whole chana and rajma
  - potato
  - flours and grains: atta, suji, dalia and sabudana
- Cooked variants exist for oats (USDA, cooked in water) and soya chunks (computed, 1 : 3 rehydration, stated as an assumption).

**Rules**:

- "raw", "uncooked" and a **leading** "dry"/"dried" select the raw/dry row. "cooked", "boiled" and "steamed" select the cooked row. A state word never selects the other state's row.
  - A **trailing** "dry" ("chana dry", "chilli chicken dry") is not treated as a state: on Indian menus it means a dish without gravy.
  - "raw banana" and "raw mango" mean unripe fruit, so the ripe fruit staples refuse "raw". Raw mango has its own IFCT row.
- A katori, bowl or plate of a **dry** staple is the cooked food. Weights and spoons stay dry, because that is how the dry ingredient is measured.
- A **weight** of a cooked staple with no state word ("100g rice", "50g masoor dal") stays cooked, since that is how most plates are logged. In this case:
  - the dry row is offered as the first alternative;
  - identification confidence drops to medium, with the reason shown ("if that was the dry weight it is about 365 kcal");
  - this applies only when the dry row would more than double or halve the number (rice ×2.8, dal ×3.8). Raw versus cooked chicken (×0.73) is offered but not doubted.

**Remaining gaps**:

- **Dry poha (flattened rice): Blocked on data.** There is no trustworthy measured row. INDB's rice-flakes row is cooked, and the one Open Food Facts label reads 722 kcal/100 g, which is impossible. IFCT 2017 lists rice flakes, but the row is not in the ingested index. "50g dry poha" is flagged rather than guessed.
- "raw banana" (green plantain) has no IFCT row in the index. It currently resolves to ripe banana, flagged at medium identification.
- Dalia and sabudana said **without** a state word still resolve to the dish rows (sweet dalia, sabudana khichdi). This is correct for "1 bowl dalia" and wrong for "30g dalia". Not implemented: no reliable signal separates the two.

---

## 4. Recipe yield and hand-entered values — **Completed** (14 conversions), **Partially completed** (10 inline values remain)

Composite dishes are priced by the yield method food-composition tables use: Σ(ingredient raw g × measured value) ÷ finished weight. Each ingredient is pinned by source id, frying oil is entered as oil absorbed, and unmeasured macros are listed in `incomplete`. A recipe value is labelled `recipe_calculation` with medium composition confidence, never `verified_database`.

**Converted in Phase 2** (`2e671ac`) from hand-typed per-100 g values. INDB is an independent cross-check here: a separate recipe database whose rows the conversions do not use.

| Staple | Old hand value (kcal/100 g) | Computed now | Independent INDB rows |
|---|---|---|---|
| Dal (home) | 145 (USDA FNDDS "Dal") | **87** | plain home dals 44–103 (moong 44/50, urad 61, kulthi 56, chana 100, moti mahal 103) |
| Mutton curry | 198 | **138** | mutton curries 80–183 (palak 80, yakhni 104, korma 116, do piaza 183) |
| Chicken biryani | 170 | **151** | mutton biryani 191, chicken pulao 108 |
| Jeera rice | 151 | **150** | cumin pulao 135 |
| Butter chicken | 189 | **177** | INDB row quarantined (frying-bath error) |
| Kadhi | 95 | **86** | INDB row quarantined |
| Oats porridge (milk) | 114 | **116** | oatmeal porridge 73 (water or thinner milk; our recipe is oats in milk) |
| Chai (with sugar) | 60 | **61** | "Hot tea" 16 (very little milk, no sugar), so not comparable |
| Coffee (milk) | 64 | **69** | espresso coffee 52, cold coffee 83 |
| Vada pav | 200 | **228** | INDB vada rows quarantined |
| Pakora | 282 | **285** | INDB pakora rows all quarantined (frying bath counted) |
| Dal tadka, mix veg, chai without sugar | 110 / 86 / 39 | 111 / 82 / 41 | none comparable |

The two largest corrections, dal (−40%) and mutton curry (−30%), move values from outside INDB's range to inside it. Every computed value is Atwater-consistent with its own macros (test: `foodRecipes.test.js`). Each old hand value is kept in a comment beside its recipe.

The benchmark cannot see these corrections: its staple cases were referenced from the same rows. That is why the INDB cross-check above is the evidence, not the benchmark score.

**Remaining**:

- 10 staples still carry inline values, each with a stated basis: chicken tikka masala, raw chicken breast, whey, salad, oil, pani puri, biscuit, gulab jamun, jalebi and rasgulla. Converting the four sweets requires sugar-syrup absorption data that the index does not hold.
- Recipe proportions and finished weights are SK OS curation. They have not been checked against weighed home batches: **Requires external validation**.

---

## 5. Oil — **Completed** for recipe dishes, **Partially completed** for database dishes

- "Less oil" and "more oil" are relative choices mapped to absolute levels (0 / 2 / 4.5 / 10 / 17 g of oil per 100 g), using the same model (`adjustOil`) in the plate and in the classic picker.
- **New in Phase 2:** a computed recipe knows its cooking fat (ghee, oil and butter, not cream), so that is the baseline.
  - Home dal (1.7 g of tadka per 100 g) can go down to no tadka while keeping the dal's own 0.4 g of fat.
  - Paneer bhurji now offers both directions (4.7 g of cooking oil → "less" 2 g or "more" 10 g). Before, its whole 20.3 g of fat, mostly paneer, stood in for oil, so "more oil" was never offered. (Commit `2e671ac`'s message describes this as "no longer subtracts the paneer's fat"; this is the precise effect.)
  - Oats porridge, whose fat comes from milk, no longer offers an oil choice.
- **Database dishes** (INDB rows) still use total fat as the oil baseline, capped so that "less" removes at most 70% of it. That approximation overstates the oil in paneer and meat dishes. Porting the per-recipe oil baselines from the Python `OilAdjuster` was never done: **Not implemented**.
- A restaurant context word ("restaurant", "dhaba", "hotel") lowers composition confidence to low with the reason "oil and portions often higher". It does **not** change the number, because no measured restaurant oil data is available. **Requires external validation.**
- INDB rows that counted the whole frying bath as eaten (pakora 552–713, vada 559–826 kcal/100 g) remain quarantined: never summed, always reported.

---

## 6. Double counting — **Completed** for known patterns

| Guard | Example | Where |
|---|---|---|
| A dish named in full is one row, not its parts | "poha with curd" is INDB "Poha with curd"; "masala dosa with sambar" still splits, because the dosa row names no sambar | `splitWithConjunction` |
| Spelling variants are the same word | "sabudana khichdi" no longer adds a second "khichdi" (866 → 374 kcal) | `coverage.isExplained` (edit distance) |
| A preparation word is not a second food | "egg bhurji" / "paneer bhurji" are one dish | `PREPARATION_FORMS` |
| A container is not a food | "half a plate" no longer becomes USDA veal | `parseFragment`, `attachQuantityPhrases` |
| Two names for one staple are not split | "pav bhaji pav" style pairs | `segmentIntoStaples` |
| A nut topping is a topping | "poha with peanuts" adds 10 g, assumed, not 30 g | `resolveParsed` |

**Open (F12): Requires external validation.** It is unknown whether INDB's "Vegetable poha" recipe already includes peanuts (its fat, 8.1 g/100 g, is consistent with either). The 10 g topping is the smaller error either way, and it is labelled as an assumption.

---

## 7. Missing values are never a measured zero — **Partially completed**

- **Item level (Completed):** a nutrient the source did not measure stays `null` end to end (IFCT paneer carbohydrate, fibre on many rows). The UI shows "—".
- **Recipe level (Completed):** an ingredient with an unmeasured macro is listed in the dish's `recipe.incomplete`. An unmeasured micronutrient makes the dish's value unknown rather than a partial sum.
- **Meal total (Completed in this report's commit):** `estimateFood` returns `total_incomplete`, for example `{ carbs: ['Paneer'] }`, naming the nutrients for which the total is a lower bound.
- **Stored logs: Not implemented.** `meal_logs.carbs/protein/fat` are `NOT NULL` in `database/schema.sql`, so a logged unmeasured carbohydrate is stored as 0. Fixing that means a column change and null-aware daily totals across `me.js`, `nutrition.js` and the frontend trackers. It is non-destructive but cross-cutting, and is listed for P2-4. The size of the error is small: paneer at roughly 1–4 g carbohydrate per 100 g.

---

## 8. Confidence calibration (summary; detail in `NUTRITION_BENCHMARK_REPORT.md`)

| View (v2, now) | ECE |
|---|---|
| Independent references | **0.081** |
| All nutrition-scored | 0.135 |
| Same-row cases | 0.319 (*under*-confident: right ~99%, labelled medium) |
| All 534 cases, including identity-only and non-food | 0.205 |

On independently referenced nutrition, labels track accuracy well: an ECE of 0.08 means stated and observed accuracy differ by about 8 points on average. The large figure for all cases comes from cases with no nutrition ground truth (identity or decomposition only) and from same-row cases where the engine is more right than it claims. That is a defensible failure direction, not an overclaim.

Phase 2 added a new reason: a weighed staple with no stated state is not called certain (§3).

---

## 9. What would most improve accuracy next (ranked by measured error)

1. **Portions:** MAE of 104 kcal on standard-portion cases. Household containers vary between kitchens; only real weighed plates can calibrate them (`NUTRITION_REAL_WORLD_VALIDATION.md`). **Requires external validation.**
2. **Oil in database dishes:** port per-recipe oil baselines, or convert the most-logged INDB dishes to computed recipes the way the 14 staples above were converted. **Not implemented.**
3. **Nullable stored macros** (§7). **Not implemented.**
4. **Data gaps:** dry poha, green plantain, "chicken 65" (currently ground chicken, low confidence), dalia/sabudana with no state word. **Blocked** on measured rows or **Not implemented**.

---

## 10. Status summary

| Area | Status |
|---|---|
| Raw vs cooked, dry vs prepared for everyday Indian staples | **Completed** (13 raw/dry staples, state rules, tests) |
| Dry staple served in a container counts as cooked | **Completed** |
| Weighed staple with unstated state: dry row offered, confidence lowered | **Completed** |
| Amount written after the food | **Completed** |
| Hand-typed values replaced by computed recipes | **Partially completed** (14 converted, 10 inline remain) |
| Dal / mutton references corrected | **Completed** (cross-checked against INDB) |
| Oil: recipe dishes | **Completed** |
| Oil: database dishes | **Partially completed** (fat-approximated, capped) |
| Restaurant oil adjustment | **Requires external validation** |
| Double counting, known patterns | **Completed** |
| Poha / peanuts recipe question (F12) | **Requires external validation** |
| Missing values in items, recipes and estimate totals | **Completed** |
| Missing values in stored logs | **Not implemented** |
| Dry poha, green plantain | **Blocked** (no measured row in the index) |
| Accuracy on real user meals | **Requires external validation** |

---

## Addendum — benchmark v3 and the fixes after this report (2026-11-16)

After this report was written, benchmark v3 (945 cases, `267fba3`) added a **multi-source** reference: the same food as measured by IFCT, USDA and CNF, with a band running from the lowest to the highest reading. It also exposed further accuracy defects, all now fixed and tested:

- "1 tomato" was a 20 g slice of green tomato;
- a cup of mushrooms was weighed as 240 g;
- "beetroot" was a beetroot-egg salad;
- "1 slice cheddar" was 100 g;
- "tomato rice" was a beef-and-rice dish.

Final numbers on v3, comparing the Phase 1 final engine with now:

| | Phase 1 final | Now |
|---|---:|---:|
| kcal in range, all nutrition-scored (n=675) | 73.6% | 83.5% |
| kcal MAE (resolved) | 37.5 kcal | 25.3 kcal |
| kcal in range, independent references | 63.6% (n=481) | 72.1% (n=399) |
| Portion error: share within 25% of reference grams | — | 89.2% |
| False identification | — | 2.5% (0 of 252 at "high") |

The status table in §10 still stands, with two additions:

- **raw vegetables at USDA reference weights: Completed**;
- **calibration: Partially completed**. On independent references it is good (ECE 0.063), but overall the engine is under-confident (ECE 0.213, meals 0.45).

See `NUTRITION_COMMERCIAL_READINESS.md` for the weighted scorecard.
