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
| **barcode — exact scan** | Barcode matched | The product's own label values; not a ranked guess | Show plainly (§3.6) |

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

### 3.4b `portions` — how users actually log food

Every `FoodMatch` carries a `portions` array sized **for that food**. Users log
"1 katori", not "150 g", and the app should offer both a weighing-scale gram
entry *and* these.

```json
"portions": [
  { "key": "medium_bowl", "label": "Medium bowl", "group": "bowl",
    "basis": "volume", "volume_ml": 250, "grams": 250.0,
    "observed_range_g": [166, 354] },
  { "key": "tablespoon", "label": "Tablespoon", "group": "spoon",
    "basis": "volume", "volume_ml": 25, "grams": 25.0,
    "observed_range_g": [16, 26] },
  { "key": "roti", "label": "Roti / chapati", "group": "count",
    "basis": "count", "grams": 40 }
]
```

**`grams` is food-specific and you must not cache it across foods.** A portion
is a VOLUME: a medium bowl of dal is 250 g and of spinach 62 g, because their
densities differ ~4x. Publishing "1 bowl = 250 g" globally would be wrong by
that factor on most foods.

Groups for UI layout: `spoon` (teaspoon, tablespoon, serving spoon, ladle),
`bowl` (small/medium/large/soup, katori), `plate` (quarter/half/regular/full),
`glass` (small/glass/tall/tea cup/cup/mug), `count` (roti, dosa, idli, egg...),
`misc` (handful, pinch). Count portions appear only for foods that come in that
form — no "1 idli" option on dal.

**Show `observed_range_g` where present.** A "bowl" is not a defined unit; real
bowls span 166–354 g in the measured data. Presenting a single number as exact
would be false precision. The catalogue is calibrated against ~900 real INDB
serving weights — overall bias 0.94, bowl 0.95, plate 0.98.

Resolution order when converting a chosen portion to grams:
1. the food's **own measured serving weight**, if it has one;
2. a **count** reference weight (one roti is 40 g);
3. **volume x the food's density**.

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

### 3.6 Barcode scan — auto-log to daily total (`tier: "barcode"`)

**This is a different retrieval mode from §3.1-3.4, not a variant of it.** Text
search is fuzzy — it ranks candidates and can be wrong. A barcode is an EXACT
key: `dict[barcode] -> product`, or a miss. There is no ranking and no
confidence *calibration* question the way §3.2 means it for search, which is
why `confidence` below is a fixed constant, not a measured value.

**Flow:** user scans a barcode → app calls the lookup → on a hit, show a
confirm screen defaulted to **1 of the product's own serving size** → user taps
confirm → log directly to the daily total. No search, no picking a portion —
the product defines its own unit.

Request/response shape:
```json
// GET /intelligence/foods/barcode/:code?servings=1
{
  "schema_version": "food-v1",
  "tier": "barcode",
  "match_kind": "barcode_exact",
  "food": {
    "source": "OPEN_FOOD_FACTS",
    "barcode": "8901234567895",
    "source_id": "off:8901234567895",
    "food_name": "...",
    "brand": "...",
    "serving_size_label": "1 bar (40 g)",
    "serving_grams": 40.0,
    "energy_kcal": 450.0, "protein_g": 30.0, "fat_g": 15.0, "carb_g": 40.0,
    "fiber_g": null, "sugar_g": 10.0, "sodium_mg": 200.0
  },
  "quantity": {
    "servings": 1, "grams": 40.0,
    "serving_grams_each": 40.0, "serving_grams_known": true
  },
  "totals": { "energy_kcal": 180.0, "protein_g": 12.0, "fat_g": 6.0, "carb_g": 16.0 },
  "confidence": "high",
  "notes": []
}
```

A miss (barcode not indexed) is a plain **404**, not a guessed food — the
frontend should fall back to name search or manual entry, exactly as it would
for a food nobody has heard of.

| Field | Notes |
|---|---|
| `confidence` | **Always `"high"`.** The *identity* match is exact by construction — this is not the calibrated §3.2 field and must not be compared to it. |
| `quantity.serving_grams_known` | **The field that actually needs UI attention.** `false` means the product publishes no serving size and the response defaulted to 100 g — see below. |
| `notes` | Non-empty only when `serving_grams_known: false`; surface it, same as `unresolved` in §3.4. |

**`serving_grams_known: false` must not be silently logged as-is, and it is
not a rare case.** Measured: only **45.6%** of indexed products carry a usable
serving size (1,861 of 4,078) — the other **54.4%** fall back to 100 g.
Defaulting to 100 g and logging it without telling the user is a guess
presented as a fact for *most* barcode-only products, not an edge case — show
the note and let the user adjust grams before confirming, the same honesty
rule as an `unreliable` search result in §3.2.

**Coverage is intentionally broader than text search's OFF data.** §3.1's OFF
rows are restricted to `countries_tags=india` because text search ranks by
name plausibility and a noisy net can out-score a good match. Barcode lookup
carries no such risk — a code either matches or it doesn't — so the barcode
index additionally includes any product whose barcode starts with **`890`**,
the GS1 company-prefix block issued to India, which catches Indian-made
products even when OFF's crowd-sourced country tag is missing or wrong.
**Consequence: a product findable by barcode is not guaranteed to also be
findable by name search.** These are two different datasets on purpose.

**Leading-zero handling is done for you.** A UPC-A scan (12 digits) and an
EAN-13 scan (13 digits) of the *same* physical product are numerically the
same code with/without a leading zero. The backend does not need to normalize
this — both forms are indexed and either resolves.

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

## 5b. `per_100g_unreliable` — a SCOPED flag, weaker than `trustworthy: false`

Distinct from §5 and must not be conflated with it.

94 INDB rows have an implausible per-100 g basis, detected by checking each
derived serving mass against reference piece weights — a dosa is not 33 g, a
bowl of poha is not 55 g. INDB publishes per-serving energy *directly* but
DERIVES serving grams from per-100 g, so an implausible mass is the fingerprint
of a wrong per-100 g value.

**What this means for the UI:**

| Logging | Affected? |
|---|---|
| "1 dosa", "1 bowl poha" (per serving) | **No** — per-serving energy is published directly and stays reliable |
| "100 g dosa" (per 100 g) | **Yes** — show the caveat or prefer the serving basis |

So when `per_100g_unreliable` is present, **prefer the serving-based path** and
avoid presenting a per-100g figure as firm. The row is otherwise fine — this is
not `trustworthy: false`, which means do not present the value at all.

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
5. **New:** `GET /intelligence/foods/barcode/:code?servings=N` → §3.6. Look the
   cleaned code up in `off_barcode_index.json` (or your DB copy of it); 404 on
   a miss. Accept both a 12- and 13-digit scan for the same product — the data
   already carries both forms, no server-side normalization needed.
6. **Do not** re-derive confidence, re-rank results, convert units, or invent a
   serving size server-side — all are already measured/calibrated in the ML
   layer, including the barcode `serving_grams_known: false` fallback.

Ingestion path: `ml/data/processed/unified_food_db.json` (13.9 MB, 21,378 rows)
is committed on `ml-sambhav`. Load it into the existing `foods` table or read it
directly — your call. Column mapping is 1:1 with `foods` except the extra
micronutrient fields. `off_barcode_index.json` (§3.6) is a **separate** file —
keyed by barcode, not merged into `foods` — since it is a different retrieval
mode with a different (broader) source filter; see §3.6's coverage note.

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
6. **Barcode scan** (§3.6) — camera scan → call the lookup → confirm screen
   defaulted to 1 serving → "Add to today" logs it directly, no portion picker
   needed (the product defines its own unit). On a miss, fall back to name
   search. **Always show the `serving_grams_known: false` note** when present
   and let the user correct the grams before confirming — do not silently log
   an assumed 100 g as if it were the real serving.
7. **Never render `null` as 0.** A missing nutrient is unknown, not zero.

### Sambhav — ML

- Owns `unified_food_db.json`, `off_barcode_index.json`, ranking, confidence
  calibration, tier 2/3, oil model, barcode lookup.
- Will not modify `backend/`, `database/`, or `frontend/`.
- Any change to a §3 shape ships as `food-v2` with notice, never edited in place.

---

## 7. Open items (flagged, not hidden)

1. **`foods` table lacks the new columns** — no migration proposed; Kaushal's call.
2. **3 dishes absent from all sources** (`rogan josh`, `vindaloo`, `jalebi`) —
   tier 2 handles them when the user supplies ingredients.
3. **Condiment per-serving figures are weak** (52.4%) — flagged via `serving_caveat`.
4. **OFF bulk covers 1,723 usable India products** for TEXT SEARCH, not the
   22,504 the API advertises; most India entries have no nutrition panel at
   all. The BARCODE index (§3.6) is a separate, broader pull — see its own
   coverage note; the two are not the same file or the same count.
5. **Tier 3 must never be shown unlabelled.** It beats guessing but is not a
   measurement, and a 50%-error number next to lab values discredits both.
6. **Barcode coverage is real but partial** — Open Food Facts is
   crowd-sourced, so a physical product in a user's hand can still be a
   miss. This is a coverage gap, not a wrong-answer risk (§3.6 has none) —
   the frontend's fallback to name search / manual entry is load-bearing,
   not an edge case to skip.

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
| **Barcode index** (§3.6) | `ml/data/processed/off_barcode_index.json` |
| Barcode index builder | `ml/src/ingestion/build_barcode_index.py` |
| Barcode lookup (Python) | `ml/src/inference/barcode_lookup.py` |
| Barcode lookup (JS reference) | `ml/models/skos-food-v1/barcodeLookup.reference.js` |
| Barcode JS parity tests | `ml/models/skos-food-v1/barcodeLookup.test.js` |
| Barcode Python tests | `ml/tests/test_barcode_lookup.py` |

Questions on a shape: ask before building around it. Changing it later costs all
three of us more than a message does now.
