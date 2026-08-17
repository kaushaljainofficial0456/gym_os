# INTEGRATION CONTRACT — skos-food-v1

**Owner of this document:** Sambhav (ML, `ml-sambhav`)
**Binding on:** Kaushal (backend, `origin/backend`) · Manavi (frontend, `origin/ui-manavi`)
**Status:** proposed — nothing below is implemented in `backend/` or `frontend/` yet.
**Kaushal:** a **JS reference implementation** now ships at
`ml/models/skos-food-v1/foodEstimate.reference.js` covering tiers 1-2, ranking,
confidence, portion units and oil. Port from it rather than reimplementing; its
33 parity tests mirror the Python suite so divergence fails loudly. Tier 3 (kNN)
is intentionally not ported - it is the least accurate tier and needs a
vectoriser + index; omit it and report "not found", which this contract allows.
**Schema version:** `food-v1` — breaking changes get a new version, never a silent edit.

This exists so three branches can build against the same shapes without waiting
on each other. **The JSON shapes in §3 are the contract.** Everything else is
context and rationale.

---

## 1. What is changing, in one paragraph

`backend/src/services/foodEstimator.js` is a 22-item hardcoded list with
hand-typed macros and a regex matcher; its own header calls it an MVP
placeholder. It is being replaced by **skos-food-v1**: a 21,378-food database
plus a three-tier estimator, already built, measured, and committed on
`ml-sambhav`. Nothing in `backend/` or `frontend/` has been touched by ML.

## 2. The three tiers, and why the UI must distinguish them

| Tier | When it runs | Accuracy | UI treatment |
|---|---|---|---|
| **1 — database match** | Food is in the DB | The lab value itself | Show plainly |
| **2 — compositional** | User gives ingredients | 25.7% median (main dishes), **bias 1.01× i.e. none** | Show plainly, list ingredients |
| **3 — name-only fallback** | Nothing matched | 14.9%–21.6% median APE | **Must be labelled an estimate** |

**Measured, not claimed.** End-to-end benchmark holds IFCT 2017 (506 lab-measured
Indian foods) out of the database entirely and queries by common name:
high-confidence answers land at **25.1% median APE, 50% within 25%**; resolution
rate 74.9%. Full numbers and method: `ml/docs/FOOD_MODEL_V1_PROGRESS.md`.

---

## 3. THE CONTRACT — canonical shapes

### 3.1 `FoodMatch` — one search result

Returned by food search. **`confidence` is required and drives UI treatment.**

```json
{
  "source_id": "ifct:L003",
  "food_name": "Paneer",
  "energy_kcal": 305.4,
  "protein_g": 18.86,
  "fat_g": 24.78,
  "carb_g": null,
  "fiber_g": null,
  "sodium_mg": 22.1,
  "serving_description": "1 katori",
  "serving_grams": 150.0,
  "cooking_state": "raw",
  "cuisine": "INDIAN",
  "source": "IFCT2017",
  "confidence": "high",
  "trustworthy": true,
  "match_kind": "exact_name",
  "query_relaxed": false,
  "unmatched_query_terms": []
}
```

| Field | Type | Notes |
|---|---|---|
| `source_id` | string | **Stable identity.** `ifct:`/`usda:`/`indb:`/`cnf:`/`off:` prefixed. Persist THIS, not the name. |
| `energy_kcal` … `carb_g` | number \| **null** | Per 100 g. **null means not measured — never render as 0.** |
| `serving_grams` | number \| null | Gram weight of `serving_description`. 6,818 of 21,378 foods have one. |
| `cooking_state` | `"raw"` \| `"cooked"` \| `"unspecified"` | See §4. |
| `confidence` | `"high"` \| `"medium"` \| `"low"` \| `"unreliable"` | See §3.2. |
| `trustworthy` | boolean | `false` = known-bad row; see §5. |
| `query_relaxed` | boolean | `true` = some query terms were dropped to find a match. |

### 3.2 `confidence` — measured, and the UI must honour it

| Value | Measured median APE | Required UI treatment |
|---|---:|---|
| `high` | **25.1%** | Show the number normally |
| `medium` | 56.5% | Show, with a "best match" affordance to change it |
| `low` | 44.7% | Show, visibly secondary, easy to correct |
| `unreliable` | — | **Do not present as a value.** Show the reason from `data_quality_flag`. |

These come from the held-out benchmark, not intuition. Two earlier confidence
schemes were *inverted* against it and were discarded — so please don't
re-derive confidence client-side; use this field.

### 3.3 `NutritionResult` — the estimate for a logged item

```json
{
  "schema_version": "food-v1",
  "tier": 1,
  "food": { "...FoodMatch..." },
  "quantity": { "amount": 2, "unit": "katori", "grams": 300.0 },
  "totals": { "energy_kcal": 916.2, "protein_g": 56.6, "fat_g": 74.3, "carb_g": null },
  "confidence": "high",
  "oil_level": null,
  "notes": []
}
```

`totals` are for the quantity actually logged. `grams` is what the quantity
resolved to — always show it, so the user can catch a bad unit conversion.

### 3.4 `CompositionalRequest` / `CompositionalResult` — tier 2

Request:
```json
{
  "dish_name": "Rogan josh",
  "servings": 4,
  "ingredients": [
    { "name": "mutton", "amount": 500, "unit": "g" },
    { "name": "curd",   "amount": 150, "unit": "g" },
    { "name": "oil",    "amount": 4,   "unit": "tbsp" }
  ]
}
```

Response adds to `NutritionResult`:
```json
{
  "tier": 2,
  "raw_mass_g": 911.2,
  "estimated_cooked_mass_g": 742.6,
  "per_serving": { "energy_kcal": 372.4, "protein_g": 31.9, "fat_g": 25.9 },
  "ingredients": [
    { "ingredient": "mutton", "matched_food": "Goat, legs", "grams": 500.0,
      "energy_kcal": 799.5, "matched_source": "IFCT2017" }
  ],
  "unresolved": [
    { "ingredient": "salt", "reason": "'to taste' has no measurable quantity" }
  ],
  "confidence": "high",
  "serving_caveat": null
}
```

**`unresolved` must be surfaced.** An unresolved ingredient means those calories
are *missing from the total*, not merely approximate. Trace items (essences,
food colour) are excluded deliberately and are not errors.

`serving_caveat` is non-null for condiments/chutneys/masalas — measured at 52.4%
per-serving error vs 25.7% for main dishes, because a "serving" of chutney is a
teaspoon of a batch. Whole-batch totals stay reliable; show the caveat.

### 3.5 `oil_level` — user-selectable, product decision

```json
{ "oil_level": "moderate", "custom_oil_g": null }
```

| Value | g oil / 100 g | Basis |
|---|---:|---|
| `none` | 0.0 | — |
| `low` | 2.0 | ≈p25 of real recipes |
| `moderate` | 4.5 | ≈median real Indian dish |
| `high` | 10.0 | ≈p75 |
| `very_high` | 17.0 | ≈p90 |
| `custom` | `custom_oil_g` | grams **in the user's portion** |

Anchored to measured percentiles across **541 real Indian recipes**. Applied as a
**delta from each dish's own recipe oil**, so selecting `low` on a dish that
already assumes oil correctly *reduces* calories (chana curry: −17.2%). Mass is
conserved — adding 10 g oil adds 10 g of mass, not only 88 kcal.

---

## 4. Cooking state — the largest single error source

Rice is **358 kcal/100 g raw** and **129 cooked**. Logging "150 g rice" against
the raw entry is a **342 kcal error on one item** — larger than every other error
source in this project combined.

**Rule:** default to the state the food is *eaten* in. Users log what they put in
their mouth: rice/dal/chicken default **cooked**; fruit/nuts/curd default **raw**.
The measured alternative is returned alongside so the UI can offer a one-tap
switch rather than silently committing.

Frontend: when `alternative` is present, a compact toggle is enough — this is a
correction affordance, not a required decision.

---

## 5. Known-bad rows must never render as clean

`trustworthy: false` means the row failed a plausibility check. Example: 201 of
1,014 INDB dishes count the deep-frying **oil bath** as eaten — "Dum aloo" reads
4,576 kcal/serving. These pass an Atwater check because energy and macros are
consistently wrong *together*.

They are **flagged, not deleted and not silently corrected** — there is no basis
to invent a replacement. When one is the only match, show the reason
(`data_quality_flag`), not the number.

---

## 6. Work split

### Kaushal — backend

1. **Replace `estimateFood()`** behind `POST /nutrition/clients/:id/meals/ai-estimate`.
   Keep the route and response envelope; swap the internals. The current
   `{items, total, estimate:true}` shape can be preserved during migration —
   add `schema_version`, `tier`, `confidence` alongside it.
2. **Extend `GET /intelligence/foods`** to return `FoodMatch` (§3.1). It currently
   returns rows from the `foods` table; skos-food-v1 supersedes that ranking.
   **Keep `id`/`name` populated** so `Nutrition.jsx` keeps working unchanged.
3. **New:** `POST /intelligence/foods/compositional` → §3.4.
4. **Pass through `oil_level`** on meal-item create/update.
5. **Do not** re-derive confidence, re-rank results, or convert units server-side —
   all three are already measured and calibrated in the ML layer.

Ingestion path: `ml/data/processed/unified_food_db.json` (13.9 MB, 21,378 rows)
is committed on `ml-sambhav`. Load it into the existing `foods` table or read it
directly — your call. Column mapping is 1:1 with `foods` except the extra
micronutrient fields.

**Schema note:** `foods` has no `cooking_state`, `serving_grams`, `confidence`, or
`source_id` column. I have **not** proposed a migration — that is your call, and
I will not touch `database/`.

### Manavi — frontend

1. **Confidence affordance** (§3.2) — `high` plain; `medium`/`low` easy to correct.
2. **Serving-size picker** — prefer `serving_description` + `serving_grams` over
   grams. 6,818 foods have one; people log "1 katori", not "150 g".
3. **Oil selector** (§3.5) — 5 presets + custom grams.
4. **Cooking-state toggle** (§4) — only when `alternative` is present.
5. **Ingredient entry for tier 2** (§3.4) — name / amount / unit rows, and
   **show `unresolved` prominently**: those calories are missing, not approximate.
6. **Never render `null` as 0.** A missing nutrient is unknown, not zero.

### Sambhav — ML

- Owns `unified_food_db.json`, ranking, confidence calibration, tier 2/3, oil model.
- Will not modify `backend/`, `database/`, or `frontend/`.
- Any change to a §3 shape ships as `food-v2` with notice, never edited in place.

---

## 7. Open items (flagged, not hidden)

1. **`foods` table lacks the new columns** — no migration proposed; Kaushal's call.
2. **3 dishes absent from all sources** (`rogan josh`, `vindaloo`, `jalebi`) —
   tier 2 handles them when the user supplies ingredients.
3. **Condiment per-serving figures are weak** (52.4%) — flagged via `serving_caveat`.
4. **OFF bulk covers 1,723 usable India products**, not the 22,504 the API
   advertises; most India entries have no nutrition panel at all.
5. **Tier 3 must never be shown unlabelled.** It beats guessing but is not a
   measurement, and a 50%-error number next to lab values discredits both.

---

## 8. Reference

| Thing | Path (branch `ml-sambhav`) |
|---|---|
| **Model card** (scope, limits, do-not-use) | `ml/models/skos-food-v1/MODEL_CARD.md` |
| **JS reference implementation** (Kaushal: port from this) | `ml/models/skos-food-v1/foodEstimate.reference.js` |
| JS parity tests | `ml/models/skos-food-v1/foodEstimate.test.js` |
| Python test suite (59 checks) | `ml/tests/test_food_model.py` |
| Full results, method, caveats | `ml/docs/FOOD_MODEL_V1_PROGRESS.md` |
| Database (21,378 foods) | `ml/data/processed/unified_food_db.json` |
| Search + ranking + confidence | `ml/src/inference/food_search.py` |
| Tier 2 calculator | `ml/src/inference/compositional.py` |
| Oil adjustment | `ml/src/inference/oil_adjustment.py` |
| Cooking-state rules | `ml/src/inference/cooking_state.py` |
| Unit → grams | `ml/src/inference/portion_units.py` |
| End-to-end benchmark | `ml/src/validation/end_to_end_benchmark.py` |

Questions on a shape: ask before building around it. Changing it later costs all
three of us more than a message does now.
