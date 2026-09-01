# SKOS Food / Nutrition Estimation — Current-System Audit

**Date:** 2026-08-28
**Scope:** Reverse-engineering audit of the *as-shipped* food/nutrition estimation engine.
**Method:** Source reading + live read-only execution of the real exported functions against `ml/data/processed/unified_food_db.json` (21,353 records). No source file, dataset, or DB row was modified.
**Rule:** Nothing was fixed. This establishes a baseline only.

Fact/assumption tags used throughout:
`[CODE]` directly implemented in source · `[DATA]` derived from a dataset row ·
`[CONST]` from a hard-coded constant · `[HEUR]` a heuristic · `[RUNTIME]` observed by executing the real code · `[DOC≠CODE]` documentation contradicts the implementation.

---

## 1. Executive Summary

SKOS does **not** have one food-estimation system. It has **three parallel, independently-built pipelines**, plus **two diverged copies** of the core engine:

| # | Pipeline | Entry route | Engine | Data source | Live in UI? |
|---|----------|-------------|--------|-------------|-------------|
| **A** | Free-text meal sentence → items | `POST /api/nutrition/clients/:id/meals/ai-estimate` | `foodEstimator.js` → `ml/models/skos-food-v1/foodEstimate.reference.js` | `unified_food_db.json` (JSON, 21k) + `food_aliases.json` | **No frontend calls it.** Consumed only by tests. |
| **B** | Search box → portion picker → (oil) → add; "Estimate with AI" | `GET /me/foods/search`, `POST /me/foods/resolve`, `POST /me/foods/ai-estimate` | Same `foodEstimator.js` engine (Tier 1 + Tier 3), plus `foodAI.js` (Tier 4 LLM) | Same JSON DB; Tier 4 calls Groq/Gemini/OpenRouter/Ollama | **Yes** — `FoodLogSheet.jsx`, `CustomizeMealSheet.jsx` |
| **C** | "AskSK" quick-add NL parse | `POST /intel/parse-food`, `POST /intel/confirm-food` | `intelligence/parseFoods.js` + `foodSearch.js` + `nutrition.js` + `units.js` | **SQLite `foods` table** (hand-seeded, ~small) + SQL `food_aliases` table | **Yes** — `AskSK.jsx` |

Plus: `backend/src/services/skos-food/foodEstimate.reference.cjs` is a **stale, encoding-corrupted second copy** of the Tier-1 engine, used only by `me.js`'s meal-template builder (`POST /me/meals/:id/items` SKOS fallback).

**The core estimation model (Pipeline A/B engine) is:**

- **Purely deterministic.** No ML model is loaded, no inference runs, no embeddings, no vector search in Tier 1. It is: regex tokenisation → weighted keyword/token scoring over a 21k-row JSON array → linear per-100 g scaling.
- **A single-record lookup + multiply.** For any query, it selects **one** database row and multiplies its per-100 g macros by (grams / 100). There is **no ingredient decomposition** on the live path.
- **Missing a plausibility layer entirely.** No Atwater check, no kcal/100 g ceiling, no dish-category range check on the Tier-1 path. (`MAX_PLAUSIBLE_KCAL = 902` exists but is referenced only by a test. Atwater checks exist only in `foodValidation.js` (write-side) and `foodAI.js` (Tier 4).)
- **Indian-food-thin.** Of 21,353 records, only **1,510 (7%)** are Indian (INDB 1,004 + IFCT2017 506). USDA is 60%, Canadian CNF 23%, Open Food Facts 9%. **223 of the 1,004 INDB dishes (22%) are quarantined** by a `data_quality_flag` and contribute *nothing* — disproportionately the fried snacks (poori, papdi, pakora, samosa, bhaji, chaat).

**The papdi-chaat screenshot (206 g ≈ 871 kcal / P17 / C155 / F21) is fully explained** (see §30, §41): the query matched a branded packaged snack — `off:8906151230391 "Quinoa Puffs - Dahi Papdi Chaat"` (422.9 kcal/100 g, 75 g carb/100 g) — because it is the *only* row in the DB whose name contains both "papdi" and "chaat" and is not quarantined. 206 g × 4.229 = 871 kcal. The parser, portion resolver, and arithmetic are all correct. The failure is **database coverage + no wrong-match guard + no plausibility check**, not a math bug.

**Current-state verdict:** solid, honest, well-tested plumbing (parsing, unit conversion, confidence labelling, "never fabricate" discipline) wrapped around a **retrieval problem it cannot solve for composite Indian food** because (a) the food doesn't exist in the corpus, (b) the nearest lexical match is a packaged product, and (c) nothing downstream sanity-checks the number.

---

## 2. Actual Runtime Architecture

### 2.1 Pipeline A — `estimateFood(text)` (the papdi-chaat path)

```
POST /api/nutrition/clients/:id/meals/ai-estimate            backend/src/routes/nutrition.js:195
  requireAuth, orgScope, rateLimit(30/min), validate(schemas.aiEstimate = {text: string 1..300})
  → res.json( estimateFood(req.body.text) )                  no persistence; returns the estimate only

estimateFood(text)                                           backend/src/services/foodEstimator.js:372
  1. search = getFoodSearch()                                lazy singleton; builds FoodSearch(db, aliases) once, ~14 MB JSON
       └ if unavailable → return {items:[], total:0s, model_available:false, unresolved:[...]}
  2. fragments = splitItems(text)                            foodEstimator.js:203
       replace /\band\b/gi → ","   then split on  [,\n;+&]+   trim, drop empties
  3. for each fragment:
       parsed = parseFragment(fragment)                      foodEstimator.js:246
       if !parsed.name → unresolved.push({reason:'no food named in this part'}); continue
       hits = search.search(parsed.name, {limit:1})          foodEstimate.reference.js:376  (Tier-1 ranked search)
       if !hits.length → unresolved.push({reason:`no match for "<name>"`}); continue
       food = hits[0]
       if food.trustworthy === false →                       data_quality_flag row
            unresolved.push({matched, reason: food.data_quality_flag}); continue
       q = resolveGrams(parsed, food)                        foodEstimator.js:305
       scaled = scaleNutrition(food, q.grams)                foodEstimate.reference.js:741
       if !scaled → unresolved.push({reason:'could not resolve a quantity'}); continue
       items.push({ name, unit:q.description, qty, calories:round(energy_kcal), protein, carbs, fat,
                    source_id, source, grams, grams_basis, grams_assumed, confidence,
                    trustworthy, match_kind, cooking_state, matched_from, fiber_g, sugar_g, sodium_mg })
       total += per-item macros
       worst = max(worst, food.confidence)                   RANK {high:0, medium:1, low:2, unreliable:3}
  4. return { text, items, total:{calories:round, protein/carbs/fat:round1},
              estimate:true, schema_version:'food-v1', tier:1, model_version:'skos-food-v1',
              confidence: items.length ? worst : null, unresolved,
              disclaimer: unresolved.length ? "Some items could not be matched…" : "Matched against measured…" }
```

**No Tier 2/3/4 anywhere in this path.** `estimateCompositional()` and `estimateFoodKnn()` are exported from the same file but not called here.

### 2.2 Pipeline B — `me.js` food routes (the live client UI)

```
GET /me/foods/search?q=…                                     backend/src/routes/me.js:386
  mine   = SELECT * FROM foods WHERE client_id=? AND name LIKE ?          (client's own rows, max 5)
  library= SELECT * FROM foods WHERE (org_id=? OR is_global=1) AND name LIKE ?  (max 8, fallback only)
  model  = searchFoodModel(q, {limit:10})   = foodEstimator.searchFoods() = TWO-PASS:
             pass 1: search.search(q,{limit}) ranked, keep ceil(limit/2)
             pass 2: plain substring over search.foods for the rest, sorted startsWith→shorter
  foods  = [ ...mine(enrich), ...model (name-deduped vs mine), ...library(enrich, name-deduped) ]
  if foods.length === 0:  knnEstimate = estimateFoodKnn(q)   ← Tier 3 (TF-IDF kNN)
  → { foods, model_available, knn_estimate }

POST /me/foods/resolve  { source_id?, name?, portion_key?, count?, grams?, oil_level? }   me.js:602
  hits = searchFoodModel(name||source_id, {limit:25});  food = hits.find(source_id) || hits[0]
  → resolveFoodQuantity(food, {portionKey, count, grams, oilLevel})       foodEstimator.js:595
       grams precedence: explicit grams → portionToGrams(...) → food.serving_grams*n → 100*n
       scaled = scaleNutrition(food, g)
       if oilLevel: adjustOil(...) with baselineOilG ≈ food.fat_g, cooked dishes only
  → { grams, grams_basis, totals, oil, portions:[…], confidence, cooking_state }

POST /me/foods/ai-estimate  { query, brand?, restaurant?, cuisine?, portion?, cooking_method?, ingredients? }   me.js:534
  rateLimit(12/min); 503 if !isFoodAIAvailable()
  → estimateFoodAI(db, {...})                                 backend/src/services/intelligence/foodAI.js:814  (Tier 4)
       cache check (ai_food_estimates) → provider chain [groq→gemini→openrouter→ollama]
       LLM returns {components:[{name,grams,macros}], totals, uncertainty, …}
       resolveComponents(): each component name → resolveComponentFood() → scaleNutrition() against a REAL row;
         unmatched components keep the LLM's own macros, flagged db_grounded:false
       validateAIFoodResponse(): weight ≤ 3000 g, kcal ≤ 4000/serving, Atwater 0.5..1.8, not all-zero macros
       deriveConfidence() from grounded fraction + uncertainty spread + branded flag
  → tier:4 result with components, uncertainty band, disclaimer

POST /me/foods/ai-estimate/adjust  { components, edits[], is_branded_or_restaurant }   me.js:560
  → recomputeAdjustedComponents()  — deterministic re-scale, NEVER a 2nd LLM call
```

### 2.3 Pipeline C — `/intel/parse-food` (AskSK quick-add)

```
POST /intel/parse-food { text }                              backend/src/routes/intelligence.js:72
  parsed = parseFoodInput(text)                              intelligence/parseFoods.js:82
     splitFoodItems: split on  + , &  and  " and " / " with "
     parseFoodSegment: regex ladder — "NUM UNIT NAME" | "NUM UNIT" | "NUM NAME" | "NAME - NUMg" | bare num
  for each item:
     { match, candidates, ambiguous } = resolveFood(db, orgId, clientId, item.name)   intelligence/foodSearch.js:55
        exact name in `foods` → alias in SQL `food_aliases` → LIKE %n% (candidates)
     nutrition = computeNutrition(match, item)               intelligence/nutrition.js:24
        withBase(food): baseGrams from food.serving string; multiplierFor(parsed, food) in units.js
        scaleNutrients(perBase, factor)                      linear
  → { items:[{name, quantity, unit, unitType, macros, provenance, confidence, sourceScope, …}], totals, unresolved, needsConfirmation }

POST /intel/confirm-food { entries:[{food_id, quantity, unit}] }   intelligence.js:107
  re-parses quantity server-side, recomputes, INSERT INTO meal_logs (source='intel')
```

This pipeline never touches `unified_food_db.json`. It reads the small hand-seeded `foods` table. It is effectively the *old* MVP estimator that `foodEstimator.js`'s header says it "replaced" — but it is still wired to a live screen.

---

## 3. Complete Call Graph (Pipeline A/B core)

```
foodEstimator.js  (ESM, backend)
├─ createRequire → ml/models/skos-food-v1/foodEstimate.reference.js   (CJS)
│    exports: FoodSearch, normalize, toGrams, densityFor, expectedState, moistureMismatch,
│             adjustOil, fattyAcidSplit, scaleNutrition, listPortions, portionToGrams,
│             canonicalPortion, effectiveDensity, OIL_LEVELS, OIL_FATTY_ACID_PROFILE,
│             KCAL_PER_G_OIL, MAX_PLAUSIBLE_KCAL, VOLUME_PORTIONS, COUNT_PORTIONS,
│             OBSERVED_SPREAD, SOURCE_RANK
├─ ml/models/skos-food-v1/barcodeLookup.reference.js   → BarcodeIndex, autoLogFromBarcode, …
├─ ml/models/skos-food-v1/compositional.reference.js   → CompositionalCalculator   (Tier 2, wired but unused by any route except tests)
├─ ml/models/skos-food-v1/fallbackKnn.reference.js     → FallbackKnnIndex          (Tier 3, used by me.js /foods/search only)
│
├─ getFoodSearch()      lazy: readJSON('unified_food_db.json') + readJSON('food_aliases.json').aliases → new FoodSearch(db, aliases)
├─ getBarcodeIndex()    lazy: readJSON('off_barcode_index.json')
├─ getCompositionalCalculator()  lazy: new CompositionalCalculator(getFoodSearch())
├─ getKnnFallback()     lazy: read fallback_v4_index.json → new FallbackKnnIndex(payload)
│
├─ splitItems(text)                         export
├─ parseQuantity(tokens)   internal
├─ parseFragment(fragment)                  export
├─ resolveGrams(parsed, food)  internal  → toGrams | portionToGrams | food.serving_grams | 100
├─ estimateFood(text)                       export   ← ROUTE: POST /nutrition/.../ai-estimate
├─ searchFoods(query,{limit,withPortions})  export   ← me.js GET /foods/search (model branch), intelligence.js /foods/model-search
│    └ safePortions(food) → listPortions()
├─ resolveFoodQuantity(food,{portionKey,count,grams,oilLevel})  export  ← me.js POST /foods/resolve
│    └ portionToGrams(), scaleNutrition(), adjustOil()
├─ estimateFromBarcode(code, servings)      export  ← intelligence.js /foods/barcode/:code (+ barcodeLookup.js live layer)
├─ estimateCompositional(ingredients,opts)  export  ← ONLY compositional.test.js
├─ estimateFoodKnn(query,{grams})           export  ← me.js /foods/search (empty-result fallback), me.js /foods/search knn_estimate
└─ scaleNutrition (re-export)                       ← foodAI.js Tier-4 component grounding

FoodSearch  (foodEstimate.reference.js:249)
├─ constructor(foods, aliases)
│    per row: _norm (= search_name || normalize(food_name)), _tokens, _head, _penalty (BRAND_PENALTIES sum), _aliasTokens
│    bySourceId Map; _vocab Map (token→count) for fuzzy
├─ score(food, qNorm, qTokens)      → number | null
├─ search(query,{limit,cuisine,allowBackoff,allowFuzzy})
│    → _searchExact()  → if empty & ≥2 tokens → progressive backoff (drop trailing tokens) → if empty → _searchFuzzy()
├─ _searchExact(qNorm, qTokens, limit, cuisine)   scores all rows, sorts, maps to FoodMatch + confidence
└─ _searchFuzzy(qNorm, qTokens, limit, cuisine)   Levenshtein per token vs _vocab, re-run _searchExact, cap confidence='low'
```

Per-step I/O and failure behaviour: see §8–§17.

---

## 4. Food Database

**Artifact:** `ml/data/processed/unified_food_db.json` — a flat JSON **array** of 21,353 objects. `[RUNTIME]` confirmed count.

### 4.1 Sources `[RUNTIME]`

| `source` value | Records | % | Region | Notes |
|---|---:|---:|---|---|
| `USDA_FDC` | 12,890 | 60.4% | US / global | The bulk. Generic + branded + "NFS" (not further specified) entries. |
| `CNF_CANADA` | 4,944 | 23.2% | Canada | Canadian Nutrient File. Many near-duplicates of USDA. |
| `OPEN_FOOD_FACTS` | 2,009 | 9.4% | India-filtered packaged | Branded packaged products. **User-contributed data — variable quality, some impossible values (e.g. sodium 30 g/100 g).** |
| `INDB` | 1,004 | 4.7% | India | Indian Nutrient Databank — cooked composite dishes with `serving_grams` + `serving_description`. **223 (22%) carry `data_quality_flag`.** |
| `IFCT2017` | 506 | 2.4% | India | Indian Food Composition Tables — lab-measured single ingredients. Highest trust. Test `indianFoodAuthoritative.test.js` pins these byte-for-faithful. |

**Indian total: 1,510 (7.1%).** The README's "21,353 foods: IFCT 2017 … USDA, INDB … CNF … OFF" claim is accurate on the count and sources; it understates how US-dominated the corpus is.

### 4.2 `cooking_state` distribution `[RUNTIME]`

`cooked` 9,372 · `ready_to_eat` 5,021 · `unspecified` 4,087 · `raw` 2,873. `cooking_state_inferred` flag set on 7,994 rows (i.e. ~37% of cooking states are heuristic, not source-stated).

### 4.3 Record schema `[DATA]` (union of keys observed over a 2,000-row scan)

**Identity / classification**
`source` (req) · `source_id` (req, e.g. `indb:ASC096`, `usda:171844`, `off:<barcode>`, `ifct:H001`, `cnf:7253`) · `food_name` (req) · `search_name` (normalised name; used as `_norm` when present) · `category` (null on 86% of rows; `indian_dish` on all 1,004 INDB) · `cuisine` (`INDIAN` | `GLOBAL` | `PACKAGED`) · `brand` (OFF only) · `merged_from`, `cooking_state_evidence`, `cooking_state_inferred`

**Macros (per 100 g unless noted)** — all **nullable**, null = "not measured":
`energy_kcal` · `protein_g` · `fat_g` · `carb_g` · `fiber_g` · `sugar_g` · `sodium_mg`

**Micros (per 100 g, mostly IFCT/INDB)** — `calcium_mg`, `iron_mg`, `potassium_mg`, `magnesium_mg`, `zinc_mg`, `phosphorus_mg`, plus vitamins (`vitamin_c_mg`, `folate_b9_ug`, `thiamine_b1_mg`, `riboflavin_b2_mg`, `niacin_b3_mg`, `vitamin_b6_mg`, `vitamin_d2_ug`, `vitamin_e_mg`, `vitamin_k1_ug`, `vitamin_a`/carotenoids, `biotin_b7_ug`, `pantothenic_acid_b5_mg`), amino acids (`aa_*`), fatty acids (`fa_saturated_mg`, `fa_monounsat_mg`, `fa_polyunsat_mg`, `fa_c18_2n6_mg`, `fa_c18_3n3_mg`, `fa_epa_mg`, `fa_dha_mg`), sugars breakdown (`glucose_g`, `fructose_g`, `sucrose_g`, `maltose_g`, `starch_g`)

**Serving**
`serving_grams` (present on **6,818 rows = 31.9%** — INDB always, CNF often, USDA/OFF rarely) · `serving_description` (e.g. `"plate"`, `"poori"`, `"chapati"`, `"curry bowl"`, `"1 piece"`) · `serving_energy_kcal`

**Quality flags**
`data_quality_flag` (223 rows — free-text reason, e.g. *"frying-bath contamination: 92% of energy is fat … implies the frying bath was counted as consumed"*, or *"1 plate derived as 836 g, above a sane maximum of 700 g"*) · `per_100g_unreliable` (94 rows — **dead: no runtime code reads this field**)

**Field usage at runtime** (Tier-1 engine):
- **Read by `score()`:** `food_name`, `search_name`, `cooking_state`, `category`, `source`, `serving_grams` (+8 if present), `data_quality_flag` (−150).
- **Read by `_searchExact()` return mapping:** `energy_kcal, protein_g, fat_g, carb_g, fiber_g, sodium_mg, serving_description, serving_grams, cooking_state, cuisine, source, data_quality_flag`.
- **Read by `scaleNutrition()`:** `energy_kcal, protein_g, fat_g, carb_g, fiber_g, sugar_g, sodium_mg, calcium_mg, iron_mg, potassium_mg` (10 fields — micros beyond these are **not** scaled or returned by Tier 1).
- **Never read at runtime:** `per_100g_unreliable`, all amino acids, most vitamins, fatty-acid breakdown, sugars breakdown, `merged_from`, `serving_energy_kcal`, `cooking_state_evidence`.
- **Calculated / normalised during ingestion** (Python, `ml/src/ingestion/*`): `search_name`, `cooking_state` (when `cooking_state_inferred`), `category`, `data_quality_flag`, `merged_from`.

---

## 5. Alias System

**File:** `ml/data/processed/food_aliases.json`
`{ generated_from:"unified_food_db.json", alias_count:4006, mapping_count:6248, aliases:{ "<alias>": ["source_id", …], … } }`

- `[RUNTIME]` **4,006 aliases**, **6,248 (alias → source_id) mappings**. **524 aliases map to more than one food.**
- **Generated from the DB itself**, not hand-curated regional knowledge. This is why coverage is patchy on exactly the words that matter:

| Query alias | `aliases[...]` value `[RUNTIME]` |
|---|---|
| `roti` | `["indb:ASC096"]` ✅ |
| `chapati` | `["indb:ASC096"]` ✅ |
| `puri` | `["indb:ASC107"]` → **but `indb:ASC107` "Poori" has a `data_quality_flag`** → dropped |
| `poori` | `null` (no alias) |
| `dal` | `null` |
| `dahi` | 84 ids — **all CNF/OFF dairy, no Indian curd/yogurt dish** |
| `curd` | 7 OFF barcodes |
| `bhindi` | `null` |
| `okra` | `["indb:BFP269"]` |
| `papdi chaat` / `papdi chat` / `papdi` / `chaat` | `null` (none) |

### 5.1 How aliases are loaded and used `[CODE]`

- Loaded in `getFoodSearch()` (`foodEstimator.js:99`): `readJSON('food_aliases.json').aliases || {}`. If the file is missing, `aliases = {}` and search still runs.
- In `FoodSearch` constructor (`foodEstimate.reference.js:268`): for every `alias → [ids]`, split the alias on spaces and add each word to `f._aliasTokens` (a `Set`) on each referenced food.
- Two runtime effects:
  1. **Exact-alias boost** (`_searchExact:418`): `aliasBoost = Map(id → 900)` for `aliases[qNorm]`. If `900 − _penalty − sourceRank*4 ≥ score`, the food's score is replaced with that and `match_kind = 'alias_exact'`, `confidence = 'high'`. This is how "roti" → "Chapati/Roti" wins at score 900.
  2. **Regional-alias token match** (`score():320`): if query tokens match a food's `_aliasTokens` better than its real `_tokens`, `match_kind = 'regional_alias_tokens'`, score += 180.
- Aliases **can** override an exact-name match (the 900 boost beats most `head_noun`/`name_prefix` scores but not `exact_name`'s 1000).
- **Ambiguity handling:** none. If an alias maps to N foods, all N get the 900 boost and the tie-break is `score DESC, then _norm.length ASC` (shortest name wins).
- **Regional?** Only incidentally — aliases are derived, not tagged by region.
- **A `data_quality_flag` food reached via alias is still dropped** by the `trustworthy === false` gate in `estimateFood` (§9), so "puri" → unresolved.

---

## 6 & 7. Search & Ranking Algorithm — exact scoring

**File:** `ml/models/skos-food-v1/foodEstimate.reference.js`
Every weight below is `[CONST]` from source. `score(food, qNorm, qTokens)` returns `null` (excluded) or a number.

### 6.1 Query normalisation `[CODE]` — `normalize(text)` (line 202) and `search()` tokenisation (line 376)

```
normalize(text):
  NFKD → strip combining marks /[̀-ͯ]/  →  lowercase
  remove (...) parenthetical groups     →  [^a-z0-9\s] → space  →  collapse spaces  →  trim

search(query):
  qNorm = normalize(query)
  qTokens = qNorm.split(' ')  filtered to remove STOPWORDS {raw, fresh, whole, the, and, with, without, of, in, a}
  if all tokens were stopwords → keep the raw split
```

- **No** stemming, lemmatisation, singular/plural folding (that happens earlier, only for *units*, in `parseFragment`), synonym expansion beyond the alias file, spelling correction (except the last-resort fuzzy tier), semantic/vector/embedding search, or edit-distance in the main path.
- Number handling: digits survive normalisation as tokens. `"apple 2"` → tokens `["apple","2"]`.
- Unicode: NFKD + combining-mark strip only. `[DOC≠CODE]` The stale `.cjs` copy's strip regex is corrupted (`/[╠Ç-═»]/g`) so that copy does **not** strip diacritics.

### 6.2 Match-kind ladder (mutually exclusive, first hit wins) `[CODE]`

| Condition | Base score | `match_kind` |
|---|---:|---|
| `_norm === qNorm` | **+1000** | `exact_name` |
| `_head === qNorm` (head noun before first comma) **and** remainder has `and`/`with`/`mixed` | **+300** | `composite_dish` |
| `_head === qNorm` and remainder is plain | **+800** | `head_noun` |
| `_norm.startsWith(qNorm + ' ')` | **+500** | `name_prefix` |
| all `qTokens` ∈ `_tokens` (token-count ≥ alias-count) | **+200**, then **−12 × (index of first matched token)** | `all_tokens` |
| all `qTokens` covered by `_tokens ∪ _aliasTokens`, alias-count > token-count | **+180** | `regional_alias_tokens` |
| `_norm.includes(qNorm)` substring, no token match | **+40** | `substring` |
| none of the above | `return null` (excluded) | — |

### 6.3 Additive modifiers applied to every scored row `[CONST]`

| Rule | Δ score | Source line |
|---|---:|---|
| Extra tokens in name: `−(nameTokens − queryTokens) × penalty`, penalty = **20** if 1-word query else **6** | − | 334–336 |
| Each `PREP_WORDS` token in name not in query | **−45** each | 339 |
| Each `UNCOMMON` token (duck, quail, turkey, venison, navajo, alaska, …) not in query | **−40** each | 340 |
| Each `COMPONENT_PARTS` token (yolk, white, bran, germ, peel, pulp, juice, whey, …) not in query | **−90** each | 341 |
| 1-word query **and** `category === 'indian_dish'` **and** name has >1 token | **−120** | 346 |
| Name contains `with`/`w/` and none of the query tokens appear after it | **−25** | 351 |
| `cooking_state ∈ {raw,cooked}` and `expectedState(name)` is set: **+70** if match, **−70** if mismatch | ±70 | 358 |
| else `cooking_state === 'raw'` | **+10** | 361 |
| `moistureMismatch(name)` (name says "dried/dry/…" but not a normally-dry food) and query lacks a dryness word | **−120** | 364 |
| `− _penalty` (sum of `BRAND_PENALTIES` regex hits, precomputed) | − | 369 |
| `− (SOURCE_RANK[source] ?? 5) × 4` → INDB 0, IFCT2017 −4, USDA_FDC −8, CNF_CANADA −12, OFF −16 | − | 370 |
| `+ 8` if `serving_grams` present | +8 | 371 |
| `− 150` if `data_quality_flag` present | −150 | 372 |

`BRAND_PENALTIES` `[CONST]` (line 212): `babyfood` −60 · fast-food chains −45 · `alcoholic beverage` −50 · `vinegar|extract|flavouring|seasoning mix` −30 · offal words (feet, skins, giblets, gizzards, necks, tails, livers, hearts, tripe, offal) −55 · `nfs` −8 · **deli forms (`deli|luncheon|oven.roasted|honey.roasted|cold cut|reformed|water added`) −160**.

`PREP_WORDS` `[CONST]`: creamed, deviled, benedict, fried, scrambled, omelet, battered, breaded, stuffed, candied, pickled, smoked, sauce, salad, soup, stew, curry, casserole, sandwich, burger, pie, cake, cookie, chips, kebab, roll, wrap, pizza, juice, drink, shake, smoothie, dessert, pudding, canned, frozen, instant.

`COMPONENT_PARTS` `[CONST]`: yolk(s), white(s), albumen, bran, germ, husk, peel, rind, pulp, juice, solids, curds, whey.

### 6.4 Sort & selection `[CODE]` (`_searchExact:434`)

```
scored.sort((a,b) => (b.s - a.s) || (a._norm.length - b._norm.length))   // score DESC, then shortest name
return scored.slice(0, limit).map(→ FoodMatch)
```

### 6.5 Confidence assignment `[CODE]` (`_searchExact:442`)

```
overlap = min( inter/|qSet| , inter/|foodTokens| )        inter = |qTokens ∩ (foodTokens ∪ aliasTokens)|
if food.data_quality_flag        → 'unreliable'
elif kind ∈ {exact_name, alias_exact} OR overlap ≥ 0.65 → 'high'
elif overlap ≥ 0.40              → 'medium'
else                            → 'low'
```
Fuzzy-corrected results are hard-capped to `'low'` and tagged `fuzzy_corrected:true` (`_searchFuzzy:504`).

### 6.6 Progressive backoff `[CODE]` (`search():388`)

Only if `_searchExact` returned nothing **and** `qTokens.length ≥ 2`. Drops trailing tokens one at a time (`sub = qTokens[0 .. len−1−drop]`), re-runs `_searchExact` on the prefix. First non-empty result set wins and is tagged `query_relaxed:true, matched_on, unmatched_query_terms`. So `"homemade chicken breast cooked"` → tries `"homemade chicken breast"` → `"homemade chicken"` → `"homemade"`… (it drops from the **end**, so it needs the important word to be first). `[DOC≠CODE]` The `.cjs` copy has an older backoff with a `hasNonNumeric`/`sub.length < 2` guard.

### 6.7 Fuzzy fallback `[CODE]` (`_searchFuzzy:480`) — the only non-exact matcher

Reached only after exact + alias + token + substring + backoff all return nothing. For each query token of length > 3 not already in `_vocab`: find the closest vocabulary token by plain Levenshtein within budget (`maxDist = 2` if token ≥ 7 chars else `1`), tie-broken toward the more frequent token. If any token changed, re-run `_searchExact` on the corrected query; all results forced to `confidence:'low'`, tagged `fuzzy_corrected`. Tokens ≤ 3 chars are never corrected ("dal" ↔ "dad").

**There is no fuzzy/edit-distance/semantic matching in the normal path** — only this last-resort spell-fix.

---

## 8. Multi-Food Parsing — `splitItems()` `[CODE]` (`foodEstimator.js:203`)

```js
String(text||'').replace(/\band\b/gi, ',').split(/[,\n;+&]+/).map(trim).filter(Boolean)
```

| Separator | Handled? | Notes |
|---|---|---|
| `,` comma | ✅ | primary |
| `\n` newline | ✅ | |
| `;` semicolon | ✅ | |
| `+` plus | ✅ | |
| `&` ampersand | ✅ | |
| ` and ` | ✅ | replaced with `,` **word-boundary**, case-insensitive |
| ` with ` | ❌ | **not a separator** → `"roti with sabzi"` stays one fragment → searched as `"roti sabzi"` after noise-word removal (`with` is in `NOISE`) → likely matches roti, sabzi silently lost inside the name |
| `+`/`x` between qty and unit | n/a | not relevant here |
| parentheses | ❌ | not split; `parseFragment` strips non-alphanumerics so `"dal (thick)"` → `"dal thick"` |
| adjacency ("chicken rice", "dal chawal") | ❌ | one fragment. `"dal chawal"` → alias/`all_tokens` → matches a rajma/dal curry; **rice silently dropped**. `"chicken rice"` → `all_tokens` → a USDA "chicken and rice" dish or backoff to "chicken". |

**Known failure modes:**
- `" and "` over-splits legitimate pairs: `"salt and pepper"` → two fragments (acknowledged in the source comment; deliberate — under-splitting loses food, over-splitting produces a visible unresolved fragment).
- ` with ` / adjacency **under-split**: composite phrases collapse into one search string; the secondary food vanishes into token-matching or is dropped.
- No quantity distribution: `"2 roti and dal"` → `["2 roti", "dal"]` — the `2` does not carry to dal (correct here, but `"2 eggs and toast"` gives 2 eggs + 1×(assumed 100 g) toast).
- Adjectives/modifiers are not stripped before search beyond the `NOISE` set (`of, with, and, plus, some, my, the, a, an, had, ate, eaten, for, breakfast, lunch, dinner, snack, today, i, also, then, about, approx, approximately, around`). "grilled", "homemade", "spicy", "leftover" etc. all reach the ranker as tokens and can only hurt via the extra-token penalty.

Pipeline C's `splitFoodItems()` (`intelligence/parseFoods.js:14`) is similar but **does** split on ` with ` and does **not** split on `;`.

---

## 9. Portion Parsing — `parseFragment()` `[CODE]` (`foodEstimator.js:246`)

```
cleaned = fragment.toLowerCase()
          .replace(/[^\p{L}\p{N}\s./½¼¾⅓⅔-]/gu, ' ')   // keep letters, digits, . / - and glyph fractions
          .collapse spaces .trim
tokens = cleaned.split(' ')
{ qty, rest } = parseQuantity(tokens)      // see below
tokens = rest
unit = null
if tokens[0] is a MASS_VOLUME unit (or its singular) → unit = that, shift
elif canonicalPortion(tokens[0] or singular) → unit = canonical key, shift   // roti, egg, bowl, katori, …
name = tokens without NOISE words, joined
if !name && unit → name = unit          // "2 roti" → name becomes "roti"
if !name → return {qty, unit, name:null, raw}   // reported unresolved
return {qty, unit, name, raw}
```

`parseQuantity(tokens)` `[CODE]` (line 212), first token only:
1. glyph fraction `½ ¼ ¾ ⅓ ⅔` → its value
2. `\d+/\d+` → division
3. `\d+(.\d+)?[a-z]+` glued ("150g") → number, unit pushed back onto tokens
4. plain `Number(first)` if finite
5. `WORD_NUMBERS` `[CONST]`: a/an/one=1 … ten=10, half=0.5, dozen=12, couple=2, quarter=0.25
6. else `qty = null`

`MASS_VOLUME` regex `[CONST]`: `g gm gms gram(s) kg kgs kilo(s) kilogram(s) ml millilitre milliliter l litre liter oz ounce(s) lb lbs pound(s) tsp teaspoon(s) tbsp tablespoon(s) cup cups`.

### 9.1 Support matrix `[RUNTIME]`

| Input | Parsed | grams basis (§10) | Result |
|---|---|---|---|
| `150g chicken` | `{qty:150, unit:'g', name:'chicken'}` | `toGrams` mass | 150 g ✅ |
| `200 g rice` | `{qty:200, unit:'g', name:'rice'}` | mass | 200 g ✅ |
| `75 grams paneer` | `{qty:75, unit:'grams', name:'paneer'}` | mass | 75 g ✅ |
| `2 roti` | `{qty:2, unit:'roti', name:'roti'}` | `portionToGrams` → `COUNT_PORTIONS.roti` | **80 g ✅** |
| `3 eggs` | `{qty:3, unit:'egg', name:'egg'}` | `COUNT_PORTIONS.egg` | 150 g ✅ |
| `1 banana` | `{qty:1, unit:'banana', name:'banana'}` | `COUNT_PORTIONS.banana` | 120 g ✅ |
| `5 puri` | `{qty:5, unit:null, name:'puri'}` | — | `puri` not in `COUNT_PORTIONS`/`canonicalPortion` → unit stays null → matched food is quarantined → **unresolved** |
| `1 bowl dal` | `{qty:1, unit:'bowl', name:'dal'}` | `portionToGrams` volume | 250 mL × density |
| `2 cups rice` | `{qty:2, unit:'cup', name:'rice'}` | `toGrams` volume (cup ∈ MASS_VOLUME) → **240 mL** × `densityFor` | note: `toGrams` uses `ML_PER_UNIT.cup = 240`; `portionToGrams`/`VOLUME_PORTIONS.cup = 240` — consistent |
| `1 katori dal` | `{qty:1, unit:'katori', name:'dal'}` | `portionToGrams` → `VOLUME_PORTIONS.katori = 150 mL` × density | |
| `1 glass milk` | `{qty:1, unit:'glass', name:'milk'}` | `VOLUME_PORTIONS.glass = 330 mL` × 1.03 | (note: `ML_PER_UNIT.glass` in `toGrams` = 250; **the two catalogues disagree on "glass"** — 250 vs 330) |
| `1 tablespoon oil` | `{qty:1, unit:'tablespoon', name:'oil'}` | `toGrams` (tbsp ∈ MASS_VOLUME) → **15 mL** × 0.92 = 13.8 g | but `VOLUME_PORTIONS.tablespoon = 25 mL` — **another disagreement** (15 vs 25) |
| `1 egg` | `{qty:1, unit:'egg', name:'egg'}` | `COUNT_PORTIONS.egg = 50` | 50 g ✅ |
| `1 roti` | `{qty:1, unit:'roti', name:'roti'}` | `COUNT_PORTIONS.roti = 40` | 40 g ✅ |
| `2 bowls` (no food) | `{qty:2, unit:'bowl', name:null}` | — | unresolved: "no food named" |
| `roti with sabzi` | `{qty:null, unit:null, name:'roti sabzi'}` | — | searched as `"roti sabzi"` |

### 9.2 The "2 roti bypasses COUNT_PORTIONS" issue — **CONFIRMED FIXED in current code** `[RUNTIME]`

Real `estimateFood('2 roti')` → **1 item, `grams: 80`, `grams_basis: 'count'`, `unit: '2 x roti'`, matched `indb:ASC096 "Chapati/Roti"` via `alias_exact`, `confidence: 'high'`.** The path:
1. `parseFragment` → `canonicalPortion('roti')` returns `'roti'` (it's in `COUNT_PORTIONS`) → `unit='roti'`; tokens now empty → `name = unit = 'roti'`.
2. `resolveGrams`: `unit` is not `MASS_VOLUME`; calls `portionToGrams('roti', 2, {foodServingGrams: 36})`.
3. In `portionToGrams`: the "prefer the food's own `serving_grams`" branch only triggers for `key ∈ {bowl, katori, plate, piece, medium_bowl}` — `'roti'` is **not** in that list, so it falls to `COUNT_PORTIONS.roti.grams = 40` → **2 × 40 = 80 g**.

So `2 roti` correctly uses the 40 g count reference, **not** the matched row's `serving_grams` (36 g). Regression tests `foodEstimator.test.js:34,120,144` and `indianFoodAuthoritative.test.js:157` pin this. The bug the brief describes existed historically (git `35a3490 "portion-scaling fix"`) and no longer reproduces.

**Residual related risk:** count words that are **not** catalogued (`puri/poori`, `pakora`, `tikki`, `kachori`, `bhatura`, `paratha` is catalogued, `thepla`, `cheela`) get `unit = null` → fall through to `serving_grams` (if the matched row has one) or the 100 g assumption.

---

## 10. Portion Sources & Precedence

### 10.1 Every source of a gram figure `[CODE]`

| Source | Where | Applies to |
|---|---|---|
| **User-typed mass/volume** via `toGrams()` | `resolveGrams` step 1 | `unit ∈ MASS_VOLUME` (g, kg, ml, l, oz, lb, tsp, tbsp, cup) |
| **`portionToGrams()`** | `resolveGrams` step 2 | any other recognised `unit` (household portion) |
| ↳ **matched food's own `serving_grams`** | `portionToGrams` first branch | `foodServingGrams` set **and** `key ∈ {bowl, katori, plate, piece, medium_bowl}` |
| ↳ **`COUNT_PORTIONS[key].grams`** | `portionToGrams` | `key` is a count portion with a grams value (roti 40, paratha 85, dosa 85, idli 45, poori 119, samosa 68, vada 60, ladoo 36, biscuit 19, egg 50, banana 120, apple 180) |
| ↳ **`VOLUME_PORTIONS[key].ml × effectiveDensity()`** | `portionToGrams` fallthrough | volume portions |
| **matched food's `serving_grams × qty`** | `resolveGrams` step 3 | any food with `serving_grams > 0` and no usable unit |
| **`100 × qty` (assumed)** | `resolveGrams` step 4 | everything else — flagged `grams_assumed:true`, `grams_basis:'assumed_100g'` |

### 10.2 Precedence (`resolveGrams`, `foodEstimator.js:305`) `[CODE]`

```
1. explicit mass/volume the user typed          (toGrams; basis 'measured')
2. household portion sized for THIS food        (portionToGrams; basis 'count' | 'volume' | 'measured_serving')
3. the food's own serving_grams × qty           (basis 'food_serving')
4. 100 g × qty                                  (basis 'assumed_100g', assumed:true)
```

Inside step 2, `portionToGrams` (`foodEstimate.reference.js:710`):
```
1. foodServingGrams present AND key ∈ {bowl,katori,plate,piece,medium_bowl}  → n × foodServingGrams   (basis 'measured_serving')
2. COUNT_PORTIONS[key].grams defined                                          → n × grams             (basis 'count')
3. else VOLUME_PORTIONS[key]                                                  → n × ml × effectiveDensity(name, cookingState)  (basis 'volume')
```

**Worked precedence examples `[RUNTIME]`:**
- `COUNT_PORTIONS.egg` (50) vs a matched "boiled egg" INDB row's `serving_grams` (~151 g, the whole dish): **`COUNT_PORTIONS` wins** because `resolveGrams` reaches `portionToGrams` first and `'egg'` is a count portion. This is deliberate (source comment: fitting to INDB's 151 g would break every bare-egg entry).
- `1 bowl rajma`: `portionToGrams('bowl', 1, {foodServingGrams: 119.9})` → branch 1 (`'bowl'` ∈ the set) → **`measured_serving` = 119.9 g** (`indb:ASC165`'s own serving). `[RUNTIME]` confirmed.
- `1 bowl dal` where matched "Dal" (USDA) has **no** `serving_grams`: → branch 3 → `250 mL × effectiveDensity('Dal','cooked')`. `densityFor('Dal') = 0.85` (dal pattern), then `effectiveDensity` sees `cooked` + `WET_DISH_RE` matches "dal" → `max(0.85, 1.0) = 1.0` → **250 g**. `[RUNTIME]` confirmed (363 kcal).
- `rajma chawal` (no qty, no unit): step 3 → `indb:ASC165.serving_grams (119.9) × 1` → **`food_serving`, 119.9 g** (rice component absent from the record).

---

## 11. Volume-to-Gram Conversion

**Two catalogues, and they disagree.** `[CODE]` `[DOC≠CODE]`

### 11.1 `VOLUME_PORTIONS` `[CONST]` (`foodEstimate.reference.js:588`) — used by `portionToGrams`, `listPortions`

| key | mL | key | mL | key | mL |
|---|---:|---|---:|---|---:|
| teaspoon | 5 | small_bowl | 220 | small_glass | 150 |
| tablespoon | **25** | katori | 150 | glass | **330** |
| serving_spoon | 45 | medium_bowl / bowl | 250 | tall_glass | 350 |
| ladle | 90 | large_bowl | 400 | tea_cup | 150 |
| | | soup_bowl | 350 | cup | 240 |
| quarter_plate | 120 | half_plate | 200 | mug | 300 |
| plate | 350 | full_plate | 500 | handful | 60 |
| | | | | pinch | 0.35 |

### 11.2 `ML_PER_UNIT` `[CONST]` (`foodEstimate.reference.js:60`) — used by `toGrams` (i.e. when the user types the unit as free text)

`tsp 5 · tbsp/tablespoon **15** · cup 240 · katori 150 · bowl 250 · small bowl 180 · soup bowl 300 · glass **250** · tall glass 350 · tea cup 150 · ml 1 · litre 1000 · drop 0.05 · pinch 0.35 · dash 0.6`

**Divergences:** `tablespoon` 15 mL (`toGrams`) vs 25 mL (`VOLUME_PORTIONS`); `glass` 250 vs 330; `small bowl` 180 vs 220; `soup bowl` 300 vs 350. Which one you get depends on whether the word was typed by the user (→ `toGrams`) or selected as a portion chip (→ `portionToGrams`).

### 11.3 Density `[CODE]`

- **`densityFor(name)`** (`:97`) — 16 regex patterns `[CONST]`: oil 0.92, ghee/butter 0.91, honey 1.42, syrup 1.33, milk/curd/dahi/yogurt 1.03, cream/malai 0.99, sugar/jaggery 0.85, salt 1.20, besan/gram flour 0.60, semolina/suji/rava 0.75, flour/atta/maida 0.55, rice/poha 0.85, dal/lentil 0.85, powder/masala 0.50, leaves/spinach/palak 0.25, almond/cashew/peanut 0.60. Default **1.0**.
- **`effectiveDensity(name, cookingState)`** (`:674`): if `cookingState === 'cooked'` and name matches `WET_DISH_RE` (`curry|gravy|dal|sambar|rasam|soup|stew|kadhi|korma|makhani|rajma|chole|kheer|halwa|raita|lassi|khichdi|porridge|upma|poha|pulao|biryani|rice`) and **not** `DRY_FINISHED_RE` (`roasted|fried|papad|chips|namkeen|bhujia|biscuit|cookie|cracker|khakhra|toast|rusk|wafer`) → `max(base, 1.0)`.
- `toGrams` volume uses **`densityFor` only** (no `effectiveDensity`) — so a typed "1 bowl dal" via `toGrams` would use 0.85, but that path isn't reached because `bowl` isn't in `MASS_VOLUME`.

### 11.4 Calibration claim `[DOC≠CODE]`

Source comment (`:586`): *"Volumes are CALIBRATED against ~900 real INDB serving weights (`ml/src/validation/portion_calibration.py`) — overall bias 0.94, bowl 0.95, plate 0.98."* The calibration artifact `ml/data/processed/portion_calibration.json` exists (95 KB). The JS constants are hand-set round numbers (250, 350, 400…), not obviously the calibrated values; the calibration lives in Python and its output is **not** loaded at runtime. `OBSERVED_SPREAD` `[CONST]` (`:635`) holds display ranges (bowl [166, 354], plate [236, 554], …) — attached to portion chips for the UI, never used in a calculation.

---

## 12. Nutrition Scaling — `scaleNutrition(food, grams)` `[CODE]` (`foodEstimate.reference.js:741`)

```js
if (!(grams > 0)) return null;
factor = grams / 100;
for k of ['energy_kcal','protein_g','fat_g','carb_g','fiber_g','sugar_g','sodium_mg','calcium_mg','iron_mg','potassium_mg']:
    totals[k] = (v == null) ? null : round2(v * factor);
return { grams: round1(grams), totals };
```

- **Purely linear**: `nutrient = per_100g × grams / 100`. No exceptions, no per-serving branch (packaged OFF products are also stored per-100 g here and scaled the same way).
- **Nulls propagate as null** — a not-measured nutrient renders as `—`, never `0`. `estimateFood` then does `t.energy_kcal ?? 0` for the *total* (so a null-energy food contributes 0 to the meal total but the item shows `—`... actually `calories: Math.round(t.energy_kcal ?? 0)` → shows 0).
- **Zero handling**: a real `0` stays `0` (distinct from `null`).
- **Rounding**: item macros `round2` (2 dp) inside `scaleNutrition`; `estimateFood` then rounds displayed `calories` with `Math.round`, and meal totals with `Math.round` (kcal) / `round1` (macros).
- **Calories are always the stored `energy_kcal`** — **never** recomputed from macros, never cross-checked against `4P + 4C + 9F`, never conditionally chosen. Whatever the row says is what scales.

`resolveFoodQuantity` and `estimateFoodKnn` use the same `× grams/100` math.

---

## 13. Cooking-State Logic `[CODE]`

| Aspect | Behaviour |
|---|---|
| **Where state comes from** | `food.cooking_state` — a DB field (`raw` / `cooked` / `ready_to_eat` / `unspecified`; `cooking_state_inferred` true on ~37%). Set during Python ingestion (`ml/src/ingestion/classify_cooking_state.py`), not at runtime. |
| **`expectedState(name)`** (`:187`) | Token scan: any token ∈ `NORMALLY_COOKED` (rice, wheat, dal, rajma, chicken, potato, …) → `'cooked'`; any ∈ `NORMALLY_RAW` (apple, banana, tomato, curd, paneer, milk, honey, oil, …) → `'raw'`; else `null`. |
| **Effect on ranking** | `score()`: if `expectedState` set and row state ∈ {raw, cooked}: **+70 match / −70 mismatch**. Else if row state = `raw`: **+10**. That is the *entire* influence. |
| **Effect on nutrition** | **None directly.** `scaleNutrition` ignores `cooking_state`. There is no raw→cooked yield factor, no water-loss/gain adjustment, no re-hydration. The only lever is *which row gets picked* (a "cooked rice" row already has cooked values). |
| **Effect on density** | Yes — `effectiveDensity` bumps a `cooked` + wet-dish name to ≥ 1.0 (§11.3). Affects volume-portion grams only. |
| **Effect on portion weight** | Indirectly via density; `COUNT_PORTIONS` and `measured_serving` ignore it. |
| **Effect on oil adjustment** | `resolveFoodQuantity` only offers oil adjustment when `cooking_state === 'cooked'` or `category === 'indian_dish'` (§14). |
| **`ready_to_eat` / `unspecified`** | Invisible to `score()`'s ±70 rule (only raw/cooked qualify). `ready_to_eat` gets no bonus/penalty. |

`[RUNTIME]` `indianFoodAuthoritative.test.js:189` confirms a bare `"rice"` query resolves to a `cooked` row and cooked rice < raw rice kcal — but that's *row selection*, not a nutrition transform.

---

## 14. Oil / Frying Logic — `adjustOil()` `[CODE]` (`foodEstimate.reference.js:519`)

**When called:** only from `resolveFoodQuantity()` (`me.js POST /foods/resolve`), when the caller passes `oil_level ∈ {none, low, moderate, high, very_high}`. **Never** called by `estimateFood` (Pipeline A) or Tier 4.

**Gate** (`resolveFoodQuantity:654`): `isCookedDish = cooking_state === 'cooked' || category === 'indian_dish'`. If not a cooked dish → `oil = {applied:false, reason:'no oil baseline for this food — its fat is not mostly added oil'}`. Otherwise `baselineOilG = Number(food.fat_g)` (the dish's own total fat, per 100 g, used as a stand-in for its recipe oil).

**Formula** (`adjustOil`, per 100 g):
```
OIL_LEVELS = { none:0, low:2.0, moderate:4.5, high:10.0, very_high:17.0 }   // g oil / 100 g dish
KCAL_PER_G_OIL = 8.84
target   = OIL_LEVELS[level]
delta    = target − baselineOilG                    // can be negative → REDUCES calories
newMass  = 100 + delta                              // mass is conserved: added oil is added food
absEnergy = max(0, baseKcal + delta × 8.84)
adjKcal  = absEnergy / newMass × 100                // renormalise to per-100 g
fat_g_adjusted     = max(0, fat_g + delta) / newMass × 100
protein/carb_adjusted = value / newMass × 100       // diluted by the mass change
```
`resolveFoodQuantity` then rescales the adjusted per-100 g values to the logged portion (`× g/100`) and reports `oil.delta_kcal`.

**Double-counting risk:** the model treats the selected level as a **delta from the oil the dish already contains** (approximated by `fat_g`), so it does **not** blindly add `grams × 9`. For a genuinely oily fried dish, picking "low" *reduces* kcal. **But** the baseline is `fat_g`, which for paneer / nuts / meat is intrinsic fat, not added oil — the source comment acknowledges this and the code refuses oil adjustment unless `cooking_state==='cooked'` or `category==='indian_dish'`. Within Indian dishes the approximation can still over- or under-subtract (e.g. a `cooked` dal with 4 g fat/100 g vs a real recipe oil of ~2 g).

**`fattyAcidSplit(oilType, grams)`** (`:570`): if a known `oilType` and `delta > 0`, splits added oil into SFA/MUFA/PUFA via `OIL_FATTY_ACID_PROFILE` `[CONST]` (14 oils, IFCT Table 12). Unknown oil → `null` (no default profile). Not surfaced in the current UI.

**Puri / pakora / samosa / bhatura / fries:** these are the case the oil model was built for — **but they never reach it**, because (a) `estimateFood` never calls `adjustOil`, and (b) in the picker flow the fried INDB rows that would match are `trustworthy:false` (frying-bath flag) and excluded before a portion is ever resolved. The INDB frying-bath rows already have oil baked in (that's *why* they're flagged — 72–95 % of energy is fat).

---

## 15. Composite-Dish Handling — **explicit answer**

> **Does the current SKOS engine understand that 206 g of papdi chaat is a mixture of papdi, yogurt, potato/chickpeas, chutneys, sev, vegetables — or does it select one database record and scale it?**

**On the live path (`estimateFood`, and `/me/foods/search` + `/me/foods/resolve`): it selects one database record and scales it. There is no decomposition.** `[CODE]` `[RUNTIME]`

- `estimateFood` does `search.search(name, {limit:1})` → `hits[0]` → `scaleNutrition(hits[0], grams)`. One row, one multiply.
- The 21k DB *does* contain pre-composited dish rows (INDB "Pav bhaji", "Masala dosa", "Mutton biryani" — each is a single row with whole-dish per-100 g macros and a `serving_grams`). For dishes that **have** such a row and it isn't quarantined, the result is reasonable (`[RUNTIME]`: pav bhaji 561 kcal/581 g, masala dosa 345 kcal/210 g, veg biryani via `usda`). This is *composite-as-a-single-record*, not *composite-by-decomposition*.
- For `rajma chawal`, `chole bhature`, `dal chawal`: the alias/token match lands on **only the curry component** (`"Kidney bean curry"`, `"Chickpeas curry"`) and the bread/rice half is **silently dropped** — `[RUNTIME]` chole bhature → 196 kcal (real ≈ 700–900).

**A real ingredient-decomposition engine exists but is off the live path:**

| Tier | File | Status |
|---|---|---|
| **Tier 2 — `CompositionalCalculator`** | `ml/models/skos-food-v1/compositional.reference.js` (563 lines, faithful port of 3 Python modules; 199-entry ingredient-alias map, density classes, yield factors) | **Ported to JS, exported as `estimateCompositional()`, but NO route calls it.** Only `compositional.test.js` exercises it. Requires the caller to supply an explicit `[{name, amount, unit}]` ingredient list — nothing generates one. |
| **Tier 4 — `estimateFoodAI`** | `foodAI.js` | The LLM proposes components + grams; each is grounded against a real DB row via `scaleNutrition`; unmatched components keep the LLM's macros. **This is the only decomposition that runs in production**, and only when a user taps "Estimate with AI" after a search miss in `FoodLogSheet`. |

`[RUNTIME]` demo: `estimateCompositional([papdi, yogurt, potato, chickpeas, sev, tamarind chutney])` returns **554 kcal / 187 g cooked** (`confidence:'high'`) — far closer to reality than Tier 1's 871 — but also surfaces a data bug: `sodium_mg` summed to **31,980** (an OFF ingredient row with sodium in the tens of g/100 g, summed blindly).

`[DOC≠CODE]` `foodAI.js`'s header comment says *"Tier 2 … NOT wired into the live backend today; exists only as Python"* and *"Tier 3 … never ported to JS/backend"*. Both statements are **stale** — git commit `1f55f9f "port Tier 2/3 into the live backend"` post-dates that comment. Tier 3 **is** wired (`me.js` `/foods/search`); Tier 2 is ported but unrouted.

---

## 16. "Total Weight" Semantics `[CODE]` `[RUNTIME]`

The supplied weight/portion is **always interpreted as the weight of the selected database record's food, as-is**, then linearly scaled. There is no notion of "dish weight distributed across components".

| Input | Interpretation |
|---|---|
| `206 g papdi chaat` | 206 g **of the matched row** (`off:8906151230391` Quinoa Puffs), i.e. 2.06 × its per-100 g values. Not "206 g of papdi", not a serving, not a mixture. |
| `81 g puri` | 81 g of the matched `indb:ASC107 "Poori"` — **but that row is `trustworthy:false`, so `estimateFood` drops it → 0 kcal, reported unresolved.** (In `/me/foods/resolve` the row is excluded from the picker too.) |
| `150 g chicken` | 150 g of `usda "Chicken breast, stewed, skin eaten"` → 1.5 × per-100 g. |
| `200 g biryani` | 200 g of whichever biryani row wins (`usda:2706490` "Biryani with meat" 145 kcal/100 g, or `indb` mutton biryani) → 2 × per-100 g. Reasonable *if* the row is a whole-dish row. |
| `1 bowl dal` | `bowl` → 250 mL → × density 1.0 → **250 g** of the matched "Dal" row. The "bowl" is a volume, converted to a mass, then treated exactly like a typed `250 g`. |

---

## 17. Confidence System

### 17.1 Search-match confidence `[CODE]` (`_searchExact:442`) — used by `estimateFood`, `searchFoods`, `resolveFoodQuantity`

```
overlap = min( |qTokens ∩ (foodTokens ∪ aliasTokens)| / |qTokens| ,
               |qTokens ∩ (foodTokens ∪ aliasTokens)| / |foodTokens| )
data_quality_flag                                → 'unreliable'
kind ∈ {exact_name, alias_exact}  OR  overlap ≥ 0.65  → 'high'
overlap ≥ 0.40                                   → 'medium'
otherwise                                        → 'low'
fuzzy path                                       → forced 'low'
```

- **Driven almost entirely by lexical token overlap and match kind.** Not by nutrition quality, not by source rank, not by portion certainty, not by ambiguity/tie-count.
- `estimateFood` rolls the **worst** item confidence up to the meal (`RANK {high:0, medium:1, low:2, unreliable:3}`) — so one weak item makes the whole meal "low" (`[RUNTIME]`: `2 eggs and 1 banana` → meal confidence `low` because the egg row is `low`).
- `grams_assumed:true` (100 g fallback) is surfaced separately (`grams_basis:'assumed_100g'`) but **does not lower `confidence`**.
- A `data_quality_flag` row is labelled `unreliable` *and* `trustworthy:false`, and `estimateFood`/the picker drop it — so `unreliable` is rarely seen in a returned item; it mostly appears as a reason string in `unresolved`.

### 17.2 Tier-3 kNN confidence `[CODE]` (`foodEstimator.js:742`)

`top_similarity ≥ 0.55 → 'medium'` · `≥ 0.30 → 'low'` · else `'unreliable'`. `trustworthy` always `false`.

### 17.3 Tier-4 AI confidence `[CODE]` (`foodAI.js:702` `deriveConfidence`)

```
groundedFraction = grounded / total components
spread = (uncertainty.calories_high − low) / totals.calories
branded/restaurant:  groundedFraction ≥ 0.6 && spread ≤ 0.3 ? 'medium' : 'low'
else:  ≥0.75 & ≤0.25 → 'high' ;  ≥0.4 & ≤0.45 → 'medium' ;  >0 → 'low' ;  0 → 'unreliable'
```

Three different confidence philosophies across the three tiers, not unified.

---

## 18. Data Quality & Source Preference `[CODE]`

| Preference | Mechanism | Strength |
|---|---|---|
| Indian datasets over foreign | `SOURCE_RANK {INDB:0, IFCT2017:1, USDA_FDC:2, CNF_CANADA:3, OPEN_FOOD_FACTS:4}`, score `−= rank × 4` | **weak** — max spread INDB↔OFF is 16 points, dwarfed by a 500-point `name_prefix` or 200-point `all_tokens` delta |
| cooked over raw (when the food is normally cooked) | `expectedState` ±70 in `score()` | moderate |
| whole food over its component | `COMPONENT_PARTS` −90/token | moderate |
| generic over branded/processed | `BRAND_PENALTIES` (−45 chains, −160 deli, −60 babyfood, …); `PREP_WORDS` −45/token | strong **for the listed terms only** |
| exact over alias | `exact_name` 1000 > `alias_exact` 900 | yes |
| has a measured serving | `+8` if `serving_grams` | negligible |
| not data-quality-flagged | `−150` **and** `trustworthy:false` gate drops it entirely | decisive (but see §19.1 leak) |
| fresh over dried (unless asked) | `moistureMismatch` −120 | moderate |

**No preference exists for:** IFCT (lab) over INDB (dish) when both match at ingredient level; INDB dish over USDA "NFS" for composite queries beyond the −8 vs −16 source nudge; higher-`serving_grams`-coverage rows; Atwater-consistent rows over inconsistent ones.

---

## 19. Brand / Deli / Component Protection `[CODE]`

| Guard | Where | Effect | Protects against | False-positive risk |
|---|---|---|---|---|
| `BRAND_PENALTIES` (precomputed `_penalty` per row) | ctor + `score():369` | −8 … −160 | `"chicken breast"` → oven-roasted deli slice (79 kcal); `"apple"` → babyfood; fast-food chain rows; offal | A legitimately-named product containing "smoked"/"roasted"/"extract"/"nfs" is nudged down even when it's the right answer. |
| `PREP_WORDS` −45/token not in query | `score():339` | pushes prepared forms below the plain ingredient | `"egg"` → "egg salad"/"deviled egg"/"omelet" | `"chicken curry"` legitimately wants "curry" — but that token *is* in the query so no penalty; a dish named "… in tomato sauce" for a `"paneer"` query loses 45. |
| `UNCOMMON` −40/token | `score():340` | keeps `"meat"`/`"bird"` queries off duck/quail/turkey/venison | none obvious | A user who actually wants turkey and types just "turkey" — token is in query, no penalty. Safe. |
| `COMPONENT_PARTS` −90/token | `score():341` | `"egg"` → "Egg, yolk" (351 kcal vs 135 whole) | the audit's own cited +160 % egg error | `"orange juice"` — "juice" ∈ query, fine. `"lemon peel"` as a deliberate query works. Low risk. |
| `DELI_FORM_RE` | defined `:247` | **exported but only used inside the `BRAND_PENALTIES` deli entry**; the standalone regex is effectively redundant | — | — |
| 1-word query vs `indian_dish` with >1 name token: −120 | `score():346` | `"brinjal"` → the vegetable, not "Brinjal bhartha" | **This actively pushes single-word dish queries (`"biryani"`, `"poha"`, `"upma"`) toward ingredient rows or USDA generics.** `[RUNTIME]`: `"upma"` → `usda:2709128` not an INDB upma. |
| `moistureMismatch` −120 | `score():364` | `"coconut"` → fresh, not "desiccated coconut" | `"raisin"`/`"date"` still fine (in `NORMALLY_DRY`) | A user wanting dried figs who types "figs" gets the fresh row. |
| `trustworthy === false` hard gate | `estimateFood:413`, picker `disabled` | frying-bath INDB rows never contribute a number | **Over-broad for the user:** removes the *only* Indian match for poori/papdi/bhaji/pakora and offers no fallback on the `estimateFood` path → silent 0. |

### 19.1 Leak: contains-pass bypasses the trust gate `[RUNTIME]`

`searchFoods()`'s second pass (`foodEstimator.js:531`) filters `search.foods` by plain substring and maps `{...f, confidence: f.confidence || 'low', match_kind:'name_contains'}`. The raw row has **no** `confidence` and **no** `trustworthy` field (those are added only by `_searchExact`'s return mapping). So a `data_quality_flag` row that reaches the picker via the contains-pass is labelled **`confidence:'low'`, `trustworthy: undefined`** — not `unreliable`/`false`. `[RUNTIME]`: `searchFoods('poori')` returns "Methi poori" and "Sweet poori" as `conf=low trust=undefined` despite both carrying a frying-bath flag. `FoodLogSheet` only disables items with `trustworthy === false`, so these are **pickable**.

---

## 20. Progressive Query Backoff — **exists, name-only** `[CODE]`

`search():388`. Triggered only when `_searchExact` finds nothing AND `qTokens.length ≥ 2`. Drops **trailing** tokens one at a time:

`"homemade chicken breast cooked"` → `_searchExact("homemade chicken breast cooked")` empty → `"homemade chicken breast"` → `"homemade chicken"` → `"homemade"`.

So it degrades from the **end**. It does **not** try dropping the first token, does **not** try "chicken breast" from "homemade chicken breast" (it would get there only if the first hit on a prefix is empty). It tags results `query_relaxed:true`, `matched_on`, `unmatched_query_terms`. Confidence is whatever `_searchExact` assigns to the prefix (not automatically downgraded). Then, only if backoff is also empty, `_searchFuzzy` runs.

---

## 21. Fallback System — `estimateFood` path `[CODE]`

```
input null/'' ................................ items:[], total:0s, unresolved:[], (splitItems→[])
model artifacts missing ...................... items:[], total:0s, model_available:false,
                                               unresolved = every fragment {reason:'food model not available'}
fragment has no food name ................... unresolved.push({reason:'no food named in this part'})
search returns 0 hits ....................... unresolved.push({reason:`no match for "<name>"`})
top hit trustworthy===false ................. unresolved.push({matched, reason: data_quality_flag})
scaleNutrition returns null (grams<=0) ...... unresolved.push({reason:'could not resolve a quantity'})
no explicit unit, no portion, no serving_grams  grams = 100 × qty, grams_assumed:true, item still counted
nutrient value null ......................... that nutrient renders null (—); total uses `?? 0`
multiple foods tie ......................... deterministic: score DESC then shortest _norm; no "ambiguous" flag
malformed fragment ......................... regex strips to alphanumerics; whatever remains is searched
```

**There is no Tier-2/3/4 fallback here.** A miss is a miss. The response's `disclaimer` switches to *"Some items could not be matched and are NOT included in the total"* whenever `unresolved` is non-empty, and `confidence` is `null` if zero items resolved.

`me.js /foods/search` path adds one fallback: if `foods.length === 0`, attach `knn_estimate = estimateFoodKnn(q)` (Tier 3) to the response; the UI then also offers the "Estimate with AI" (Tier 4) button. Pipeline A has neither.

---

## 22. API Integration

### 22.1 `POST /api/nutrition/clients/:id/meals/ai-estimate` `[CODE]`

| Aspect | Value |
|---|---|
| Auth | `requireAuth`, `orgScope`, `resolveClient` (the caller must be able to see client `:id`) |
| Rate limit | 30 / min / user (`estimateLimit`) |
| Request | `schemas.aiEstimate = { text: string, 1..300 chars }` |
| Handler | `res.json(estimateFood(req.body.text))` — **synchronous, no `await`, no DB read/write** |
| Response | `{ text, items[], total{calories,protein,carbs,fat}, estimate:true, schema_version:'food-v1', tier:1, model_version:'skos-food-v1', confidence, unresolved[], disclaimer }` — each item: `{ name, unit, qty, calories, protein, carbs, fat, source_id, source, grams, grams_basis, grams_assumed, confidence, trustworthy, match_kind, cooking_state, matched_from, fiber_g, sugar_g, sodium_mg }` |
| Persistence | **None.** The estimate is returned for review; logging is a *separate* call to `POST /nutrition/clients/:id/meals/log` with `source:'ai_estimated'`. |
| Error handling | Never throws — worst case returns `items:[]`. Route has no try/catch (relies on the function not throwing). |
| Logging/telemetry | None on this route. |
| Frontend caller | **none found** (`[RUNTIME]` grep of `frontend/src`). Consumed by `nutrition-api.test.js`, `nutrition-meal-log-api.test.js`, `indianFoodAuthoritative.test.js`, `foodEstimator.test.js`, `zeroCostSafety.test.js`. |

### 22.2 Where `items / total / estimate / disclaimer / confidence / source IDs` come from

- `items[]` — built in the `estimateFood` loop, one per resolved fragment.
- `total` — running sum of item macros; `calories` `Math.round`, macros `round1`.
- `estimate: true` — hard-coded literal.
- `disclaimer` — ternary on `unresolved.length`.
- `confidence` — `items.length ? worst-of(item.confidence) : null`.
- `source_id` / `source` — copied from the matched row (`f.source_id`, `f.source`).

### 22.3 Logging endpoint `POST /nutrition/clients/:id/meals/log` `[CODE]`

Persists `meal_logs (calories, protein, carbs, fat, name, source, estimate, ai_provider, ai_model, ai_confidence, quantity, unit, unit_type)`. **`source_id`, `grams`, `grams_basis`, `cooking_state`, `match_kind`, `confidence` (the search one), fiber/sugar/sodium are NOT persisted** — the rich provenance from `estimateFood` items is dropped at log time; only the 4 macros + name + AI provenance survive. `meal_logs` schema (`database/schema.sql:521`) has no `source_id` column.

---

## 23. Frontend Integration

### 23.1 `FoodLogSheet.jsx` (Pipeline B — the live food logger)

- **Search** → `GET /me/foods/search?q=…` (debounced 200 ms). Renders `foods[]`; disables any row with `trustworthy === false` (shows `data_quality_flag` text instead of kcal).
- **Pick** → default portion = the food's `serving` chip, else a `bowl` chip, else grams entry.
- **Quantity** → every change re-calls `POST /me/foods/resolve` (debounced 120 ms). **The browser computes no macros for DB foods** — grams and macros always come from the server. Shows resolved grams prominently ("it is how a user catches a bad unit conversion"). `grams_basis === 'assumed_100g'` shows a warning.
- **Oil** chips (none/low/moderate/high/very_high) only if `food.oil_applicable` (`cooking_state==='cooked' || cuisine==='INDIAN'`); shows `oil.delta_kcal` vs the dish's usual oil.
- **kNN (Tier 3)** — if the search returned `knn_estimate`, renders a card with an editable grams field; macros scaled **client-side** (`energy_kcal × grams / 100`) — explicitly the same formula as `scaleNutrition`. Logs with `source:'knn_estimated'`.
- **"Estimate with AI" (Tier 4)** — explicit tap → `POST /me/foods/ai-estimate {query: q}` (uses the raw search text, **never** the top match). Renders totals + **uncertainty band** ("likely 420–540 kcal"), per-component grams (editable), an `*` on `db_grounded:false` components, and assumptions. Edits → `POST /me/foods/ai-estimate/adjust` (deterministic recompute, no 2nd LLM call). Logs `source:'ai_estimated'` or `'ai_estimated_user_adjusted'`, plus a best-effort `POST /me/food-feedback` observation.
- **Barcode** → `BarcodeScanner` → `/intel/foods/barcode/:code` confirm screen.
- **Display rules:** `null` macro → `—` (never 0). Rounding is display-only (`r1`). Confidence shown as a tiny tag only when `!== 'high'`. Source is shown as brand text, not a trust badge, on search rows.
- **Editing:** the user can change portion/count/grams/oil before adding; those re-resolve server-side. After a meal is logged there's no per-item re-estimation — `meal_logs` holds frozen macros.

### 23.2 `CustomizeMealSheet.jsx`

Uses the **same** `POST /me/foods/ai-estimate` (Tier 4). Comment: *"never a second nutrition engine."*

### 23.3 `AskSK.jsx` (Pipeline C)

`POST /intel/parse-food` → renders `items[].macros`, `provenance` (USER_ENTERED / ESTIMATED badge), `confidence`, `sourceScope` (GLOBAL/GYM/MY_FOOD). `unresolved` shown as *"Couldn't confidently resolve: … — those were skipped."* `+ ADD TO TODAY` → `POST /intel/confirm-food` (server recomputes, writes `meal_logs source='intel'`). Reads the SQL `foods` table, not the JSON DB.

**No frontend consumes `estimateFood` (Pipeline A) directly.**

---

## 24. Database Integration `[CODE]`

| Table | Food-relevant columns | Used at runtime? |
|---|---|---|
| `foods` | `id, org_id, client_id, name, unit, serving (text "100 g"), piece_g, calories, protein, carbs, fat, fiber, sugar, sodium, brand, source ('VERIFIED_DATABASE'|'USER_ENTERED'|'PACKAGING_LABEL'|'OCR_EXTRACTED'|'ESTIMATED'), category, cuisine, is_global, barcode, ingredients_text, image_url` | **Yes** — Pipeline C (`/intel/*`), `me.js /foods` CRUD, barcode cache, and as the *materialisation target* when a JSON-DB food is added to a meal (`/me/foods/from-model`, `/me/meals/:id/items`). **Not** the source for Pipeline A/B search. |
| `food_aliases` (SQL) | `alias, food_id, org_id` | Pipeline C only (`intelligence/foodSearch.js`). Separate from `food_aliases.json`. |
| `meal_logs` | `name, calories, protein, carbs, fat, eaten, source ('plan'|'ai'|'manual'|'ai_estimated'|'ai_estimated_user_adjusted'|'knn_estimated'|'intel'), estimate, quantity, unit, unit_type` + guarded-migration `ai_provider, ai_model, ai_confidence, meal_template_id` | Write target for every logging path. **Stores macros only** — no `source_id`, no `grams`, no `cooking_state`, no micros, no search-confidence. |
| `meals`, `nutrition_plans` | trainer-authored template macros | plan/template flow; unrelated to estimation |
| `meal_items`, `client_meal_templates` | `calories, protein, carbs, fat, quantity, unit, source, ai_*` | "Customize My Meals" builder |
| `ai_food_estimates` | Tier-4 cache: `canonical_key, canonical_name, nutrition(json), uncertainty, component_template, assumptions, source, ai_provider, ai_model, confidence, validation_status, cuisine, usage_count` | Tier 4 cache read/write (`foodAICache.js`) |
| `ai_food_feedback` | user-adjustment observations toward community validation | `foodFeedback.js` |
| `ai_provider_cost_state` | `provider, cooldown_until, daily_count, daily_count_date` | Tier-4 cost governor |
| `intelligence_events` | `input, resolution(json), result(json), source` | Pipeline C audit trail |

**The JSON DB (`unified_food_db.json`) is never loaded into SQL.** `init-db.js` seeds a small hand-typed `foods` set + `food_aliases`; it does **not** import the 21k JSON corpus. The two food universes coexist.

**Stored-but-unused fields:** `foods.category`, `foods.cuisine`, `foods.piece_g` (used by `units.js`), `meal_logs.unit_type` (provenance only), and in the JSON DB: `per_100g_unreliable`, all amino acids, most vitamins, fatty-acid breakdown.

---

## 25. Test Coverage

### 25.1 Files

`backend/test/`: `foodEstimator.test.js`, `indianFoodAuthoritative.test.js`, `compositional.test.js`, `fallbackKnn.test.js`, `foodAI.test.js`, `foodAIProviderChain.test.js`, `foodFeedback.test.js`, `foodValidation.test.js`, `foodValidationApi.test.js`, `foodSearchBenchmark.test.js`, `barcodeApi.test.js`, `nutrition-api.test.js`, `nutrition-history-api.test.js`, `nutrition-meal-log-api.test.js`, `nutrition-plan-api.test.js`.
`ml/models/skos-food-v1/`: `foodEstimate.test.js` (invariants: no row > `MAX_PLAUSIBLE_KCAL`, ranking order, oil monotonicity, mass conservation, unit conversion), `barcodeLookup.test.js`.
`ml/tests/` (Python): `test_food_model.py`, `test_pipeline.py`, `test_v2_pipeline.py`, …

### 25.2 What is covered `[RUNTIME]`

| Area | Covered |
|---|---|
| Explicit grams | ✅ `150g chicken`, `100 g paneer`, `200g paneer` scales linearly from IFCT value |
| Count portions | ✅ `1/2 roti`, `2 roti`(=80 g), `3 chapati`(alias→120 g), `2 egg`(=100 g), `1 banana`(=120 g), `1 dosa`(85 g), `2 idli`(=90 g), `1 apple`(180 g) |
| Volume portions | ✅ `2 bowls dal`(=500 g), `1 plate rice`(>200 g), `1 bowl sambar`(uses INDB own serving) |
| Multi-food | ✅ `2 roti, dal and curd` → 3 items, roti grams asserted |
| Ambiguous / typo | ✅ `chapatti`/`phulka` → same row as `chapati`; `panneer` → `fuzzy_corrected`, `confidence:'low'` |
| Cooked vs raw | ✅ cooked rice kcal < raw rice; bare `rice` → cooked row |
| Absent food | ✅ `quantum flux capacitor` / `xyyzqq nonfoodterm 500g` → 0 items, `unresolved` populated, no fabricated numbers |
| Empty / null input | ✅ no crash |
| IFCT / INDB fidelity | ✅ byte-faithful macro assertions for a pinned set of `source_id`s |
| Tier 2 | ✅ `compositional.test.js` — mass conservation, coverage/confidence, ingredient resolution |
| Tier 3 | ✅ `fallbackKnn.test.js` — parity vs sklearn golden set, doubling grams ≈ doubles kcal, no-overlap → null |
| Tier 4 | ✅ `foodAI.test.js` — schema/plausibility validation, Atwater reject, provider failover chain, cache |
| Write-side validation | ✅ `foodValidation.test.js` — negative macros, macro-sum > 100 g, Atwater ±35 % |

### 25.3 What is NOT covered (`[RUNTIME]` gap analysis)

- **No test asserts a composite Indian street food resolves to a *sane number*.** `papdi chaat`, `bhel puri`, `sev puri`, `dahi puri`, `pani puri`, `aloo tikki chaat`, `chole bhature`, `pav bhaji` (as free text), `vada pav`, `dabeli`, `frankie`, `kathi roll` — none are in any test.
- **No test for `puri`/`poori` as free text** — the quarantine-drop → silent-0 behaviour is untested.
- **No plausibility / Atwater assertion on the `estimateFood` output** (only on write-side records and Tier 4).
- **No test that `rajma chawal` / `dal chawal` include *both* components** (they don't, and nothing catches it).
- **No test for the contains-pass trust leak** (§19.1).
- **No test for `1 tablespoon oil` vs the `VOLUME_PORTIONS`/`ML_PER_UNIT` "tablespoon" 15-vs-25 disagreement.**
- **No test comparing the two engine copies** (`ml/…/foodEstimate.reference.js` vs `backend/…/foodEstimate.reference.cjs`).
- **No test for `estimateFood` when the matched row is a branded OFF product** (the papdi-chaat failure class).
- `foodSearchBenchmark.test.js` exists (`getFoodSearch`) — measures ranking on a fixture set; not a nutrition-accuracy benchmark.

---

## 26. Method Inventory

| Function | File:line | Purpose | Inputs | Outputs | Used by | Key logic | Data | Confidence | Known issues |
|---|---|---|---|---|---|---|---|---|---|
| `estimateFood` | foodEstimator.js:372 | free-text meal → items+total | `text` | food-v1 envelope | `POST /nutrition/.../ai-estimate` | split→parse→search(1)→trust gate→resolveGrams→scaleNutrition | JSON DB | worst item conf | Tier-1 only; no plausibility; drops quarantined w/o fallback |
| `splitItems` | :203 | sentence → fragments | `text` | `string[]` | `estimateFood` | `and`→`,`; split `[,\n;+&]` | — | — | ` with ` & adjacency not split |
| `parseQuantity` | :212 | leading qty | `tokens` | `{qty,rest}` | `parseFragment` | glyphs, `a/b`, `150g`, Number, WORD_NUMBERS | CONST | — | no ranges ("2-3") |
| `parseFragment` | :246 | fragment → `{qty,unit,name}` | `fragment` | obj | `estimateFood` | singularise unit; `canonicalPortion`; `name=unit` if empty | CONST | — | uncatalogued count words (`puri`) → unit null |
| `resolveGrams` | :305 | choose grams | `parsed, food` | `{grams,basis,assumed,description}` | `estimateFood` | 4-step precedence | CONST + DB | flags `assumed` | disagreeing volume tables via `toGrams` vs `portionToGrams` |
| `searchFoods` | :512 | picker list | `query,{limit,withPortions}` | `FoodMatch[]+portions` | `me.js`, `intelligence.js` | ranked half + contains half | JSON DB | per-row | contains-pass drops trust/conf fields (§19.1) |
| `safePortions` | :563 | portion chips for a food | `food` | `portion[]` | `searchFoods`, `resolveFoodQuantity` | `listPortions` + own serving override; drop 0 g | CONST | — | — |
| `resolveFoodQuantity` | :595 | portion+oil → macros | `food,{portionKey,count,grams,oilLevel}` | resolved obj | `POST /me/foods/resolve` | grams precedence + `adjustOil` | CONST + DB | row conf | oil baseline ≈ `fat_g` (approx) |
| `estimateFromBarcode` | :711 | barcode → item | `code, servings` | food-v1 or null | `/intel/foods/barcode` | `autoLogFromBarcode` | `off_barcode_index.json` | — | — |
| `estimateCompositional` | :726 | ingredients → dish | `ingredients[],{servings,dishName}` | Tier-2 result | **tests only** | `CompositionalCalculator.compute` | JSON DB | grounded coverage | unrouted; sums bad OFF sodium blindly |
| `estimateFoodKnn` | :759 | name → kNN estimate | `query,{grams}` | Tier-3 result or null | `me.js /foods/search` | TF-IDF cosine kNN, sim-weighted avg | `fallback_v4_index.json` | sim bands | neighbours can all be the same wrong snack (papdi) |
| `getFoodSearch` etc. | :95–162 | lazy singletons | — | instance/null | all | read JSON once; null on failure | JSON | — | 14 MB read on first call |
| `FoodSearch.score` | reference.js:287 | rank one row | `food,qNorm,qTokens` | number/null | `_searchExact` | match-kind ladder + modifiers | CONST | — | source pref too weak (×4) |
| `FoodSearch.search` | :376 | ranked search | `query,opts` | `FoodMatch[]` | everywhere | exact→backoff→fuzzy | JSON | derives | backoff drops trailing only |
| `FoodSearch._searchExact` | :417 | score+sort+map | | `FoodMatch[]` | `search` | sort score↓ then name-len↑ | | overlap→band | tie-break = name length (nutritionally arbitrary) |
| `FoodSearch._searchFuzzy` | :480 | spell-fix | | `FoodMatch[]` | `search` | Levenshtein vs `_vocab` | CONST | forced low | tokens ≤3 never fixed |
| `normalize` | :202 | text norm | `text` | string | search/ctor | NFKD, strip marks, `[^a-z0-9\s]`→space | — | — | `.cjs` copy's mark regex corrupted |
| `toGrams` | :109 | typed unit → g | `amount,unit,name` | `{grams,method,note}` | `resolveGrams` step 1 | mass / volume×`densityFor` / count×`pieceGramsFor` | CONST | — | tbsp=15, glass=250 (≠ VOLUME_PORTIONS) |
| `portionToGrams` | :710 | portion key → g | `key,count,opts` | `{grams,basis,note}` | `resolveGrams` step 2, `resolveFoodQuantity` | own-serving / COUNT / VOLUME×`effectiveDensity` | CONST + DB | — | own-serving branch only for 5 keys |
| `canonicalPortion` | :665 | key normaliser | `key` | canonical key/null | `parseFragment`, `portionToGrams` | `VOLUME_/COUNT_PORTIONS` + `PORTION_ALIAS` | CONST | — | `puri/poori/pakora/tikki` absent |
| `listPortions` | :682 | offerable portions | `name,cookingState` | `portion[]` | `safePortions` | all volumes; counts only if regex-in-name | CONST | — | count regex: `new RegExp(key)` unanchored |
| `effectiveDensity` | :674 | wet-dish density bump | `name,cookingState` | number | `portionToGrams`, `listPortions` | cooked+`WET_DISH_RE`&!`DRY_FINISHED_RE`→≥1.0 | CONST | — | keyword-based; "rice" always wet |
| `scaleNutrition` | :741 | per-100g → portion | `food,grams` | `{grams,totals}` | Tier 1/3/4, resolve | `× grams/100`, 10 fields, null-safe | DB | — | linear only; no Atwater; ignores cooking_state |
| `adjustOil` | :519 | re-price for oil level | `food,{level,baselineOilG,...}` | `*_adjusted` | `resolveFoodQuantity` | delta from baseline, mass-conserving | CONST | — | baseline ≈ `fat_g` (wrong for paneer/nuts) |
| `fattyAcidSplit` | :570 | SFA/MUFA/PUFA of added oil | `oilType,grams` | split/null | `adjustOil` | `OIL_FATTY_ACID_PROFILE` | CONST (IFCT T12) | — | unknown oil → null (by design) |
| `expectedState` | :187 | normal eaten state | `name` | 'cooked'/'raw'/null | `score` | token ∈ NORMALLY_COOKED/RAW | CONST | — | first-match wins; no "ready_to_eat" |
| `moistureMismatch` | :194 | dried-vs-fresh guard | `name` | bool | `score` | `DRIED_RE` & !NORMALLY_DRY | CONST | — | — |
| `CompositionalCalculator.compute` | compositional.reference.js:441 | sum measured ingredients | `ingredients[],opts` | totals + per-serving + per-100g-cooked | `estimateCompositional`, Tier 4 grounding | resolve alias→search→ingredient-not-dish filter→raw-first pick→×g/100→yield for raw | JSON DB | coverage-based | condiment per-serving caveat; sums bad sodium |
| `CompositionalCalculator.lookupIngredient` | :396 | one ingredient → row | `name` | `{row,cookingState,negligible}` | Tier 4 | alias map (199) + dish-exclusion + rendered-fat net | JSON DB | — | — |
| `FallbackKnnIndex.predict` | fallbackKnn.reference.js:219 | name → macro estimate | `queryText` | `{neighbors,predicted,top_similarity}` / null | `estimateFoodKnn` | TF-IDF(word 1-2gram + char 3-5gram) + class cues, cosine, k=5 sim-weighted avg | `fallback_v4_index.json` | sim bands | corpus-bound; papdi → all-snack neighbours |
| `computeNutrition` (Pipeline C) | intelligence/nutrition.js:24 | SQL food + parsed qty → macros | `food,parsed` | macros+provenance | `/intel/parse-food`, `/confirm-food` | `withBase`→`multiplierFor`→`scaleNutrients` | SQL `foods` | HIGH/MEDIUM/LOW | separate universe from JSON DB |
| `multiplierFor` (Pipeline C) | intelligence/units.js:125 | unit↔base factor | `parsed,food` | `{factor,qtyGrams,estimated,confidence}` | `computeNutrition` | same-unit / g↔ml / piece↔g tables | CONST | per-branch | `perPieceDefaults.roti = 35` (≠ 40 in the other engine) |
| `estimateFoodAI` | foodAI.js:814 | LLM composition → grounded totals | `db,{query,brand,...}` | tier-4 result | `POST /me/foods/ai-estimate` | cache→provider chain→validate→`resolveComponents`→`deriveConfidence` | LLM + JSON DB | derived | needs a provider key; not on Pipeline A |
| `validateAIFoodResponse` | foodAI.js:382 | plausibility gate for LLM | `raw` | `{ok,value}`/`{ok:false,reason}` | Tier 4 | weight ≤3000, kcal ≤4000, Atwater 0.5–1.8, not all-zero | CONST | — | Tier-4 only |
| `validateFoodRecord` | foodValidation.js:37 | write-side record gate | `record` | `{valid,errors,warnings}` | barcode/manual/custom food inserts | negatives reject; sum>100 g reject; Atwater ±35 % warn | CONST | — | not applied to JSON DB or `estimateFood` |

---

## 27. Formula Inventory

| Formula | Location | Purpose | Variables | Example | Potential error |
|---|---|---|---|---|---|
| `nutrient = per_100g × grams / 100` | `scaleNutrition` reference.js:743 | portion scaling (Tier 1/3/4) | `per_100g`, `grams` | 206 × 422.86/100 → 871 kcal | linear only — no non-linearity for concentration; scales a *wrong row* just as confidently |
| `grams = qty × COUNT_PORTIONS[key].grams` | `portionToGrams` :726 | count portions | roti 40, egg 50, idli 45, poori 119, samosa 68, … | `2 roti` → 80 g | catalogue missing many count foods |
| `grams = n × ml × effectiveDensity(name,state)` | `portionToGrams` :730 | volume portions | `VOLUME_PORTIONS[key].ml`, density | `1 bowl dal` → 250 × 1.0 = 250 g | `ml` constants hand-set; density keyword-matched; "rice"/"dal" forced to 1.0 |
| `grams = ml × densityFor(name)` | `toGrams` :127 | typed volume units | `ML_PER_UNIT[u]`, density | `1 tbsp oil` → 15 × 0.92 = 13.8 g | `ML_PER_UNIT` ≠ `VOLUME_PORTIONS` for tbsp/glass/bowls |
| `grams = amt × pieceGramsFor(name)` | `toGrams` :131 | typed count units | PIECE_GRAMS (egg 50, roti 40, banana 120, …) | `2 no. egg` → 100 g | 13 patterns only; default null → unresolved |
| `grams = qty × food.serving_grams` | `resolveGrams` step 3 :341 | food's own serving | `serving_grams` | `poha` → 54.6 g × 1 | INDB serving_grams noisy (poha 54.6 g is tiny; "1 plate = 836 g" flagged elsewhere) |
| `grams = 100 × qty` | `resolveGrams` step 4 :353 | last-resort assumption | qty | `dal` (no qty) → 100 g | silent under/over-count; not reflected in `confidence` |
| **Match score** = base(match-kind) − Σ penalties + Σ bonuses | `FoodSearch.score` :287 | ranking | 1000/800/500/300/200/180/40 base; PREP −45, COMPONENT −90, UNCOMMON −40, extra-token −20/−6, dish-1word −120, cooking ±70, moisture −120, `_penalty`, source ×4, dqf −150, serving +8 | "papdi chaat" → Quinoa Puffs score 130 (`all_tokens` 200 − extras − source 16) | all weights hand-tuned; no learned ranker; source pref negligible vs kind delta |
| `overlap = min(inter/|q|, inter/|food|)` → band | `_searchExact` :440 | confidence | `inter`, token counts | overlap 0.5 → 'medium' | lexical only; ignores nutrition plausibility |
| `first-token position penalty = −12 × index` | `score` (all_tokens) :318 | prefer query word early in name | index of first matched token | — | for `all_tokens` kind only |
| **Oil**: `adjKcal = max(0, baseKcal + (target−baseline)×8.84) / (100 + target − baseline) × 100` | `adjustOil` :540 | re-price for oil level | `baseKcal`, `target=OIL_LEVELS[level]`, `baseline≈fat_g` | dal 145 kcal, baseline 4.31, "low"(2): (145 + (2−4.31)×8.84)/(100−2.31)×100 ≈ 128 kcal | `baseline = fat_g` conflates intrinsic fat with added oil |
| **Atwater (Tier 4 & write-side only)**: `expected = 4P + 4C + 9F` | `atwaterConsistent` foodAI.js:367; `foodValidation.js:58` | reject broken macros/kcal | P,C,F | Curd 65 kcal vs 4·9.4+4·5.1+9·5.4 = 107 → ratio 0.61 (would pass Tier 4's 0.5–1.8, fail write-side ±35 %) | **not run on Tier-1 `estimateFood` output** |
| **kNN prediction** = Σ wᵢ · neighbourᵢ.macro, wᵢ = simᵢ / Σsim | `FallbackKnnIndex.predict` :256 | Tier-3 macro estimate | k=5 cosine sims | papdi chaat → 516 kcal/100 g (neighbours: quinoa puffs, papdi gathiya, soan papdi…) | garbage-in: all neighbours are dry snacks |
| `cookedMass += grams × yieldFactor` (raw match only) | `CompositionalCalculator.compute` :487 | Tier-2 mass after cooking | YIELD_FACTORS (rice 2.6, dal 2.5, chicken 0.75, spinach 0.45, water 0.35, …) | 40 g raw rice → 104 g cooked | keyword yield table; cooked DB match → yield 1.0 |
| `per_100g_cooked = total / cookedMass × 100` | compositional :524 | Tier-2 normalised output | totals, cookedMass | papdi chaat Tier-2 → 296 kcal/100 g | depends on yield estimates |
| Meal total: `Σ item.calories` (Math.round), `Σ macro` (round1) | `estimateFood` :472 | aggregate | item macros | — | one null-energy item silently contributes 0 kcal but real macros |
| Confidence roll-up: `worst = max(RANK[item.confidence])` | `estimateFood` :430 | meal confidence | RANK map | egg 'low' → meal 'low' | one weak item taints the meal |

---

## 28. Heuristic Inventory

| Heuristic | Exact rule | Weight/const | Why it exists | Example | Possible failure |
|---|---|---|---:|---|---|
| `and` = item separator | regex `\band\b` → `,` before split | — | food logs are lists | "rajma and rice" → 2 items | "salt and pepper" → 2 fragments |
| ` with ` / adjacency NOT a separator | not in split regex | — | avoid mangling "chicken with bone" | "roti with sabzi" stays 1 | sabzi lost |
| count word = its own food | `if !name && unit → name = unit` | — | "2 rotis" must resolve | "2 eggs" → search "egg" | "2 servings" → name "serving" (caught: not a food) |
| unit singularisation | `head.replace(/(?:es|s)$/,'')` | — | "bowls"/"rotis" hit catalogue | "rotis" → "roti" | "leaves" → "leav"; "berries" → "berri" |
| noise-word strip | fixed `NOISE` set (28 words) | — | "had 2 roti for lunch" → "roti" | works | "grilled", "leftover", "homemade" NOT stripped → reach ranker |
| exact-alias boost | `aliases[qNorm]` → score 900, kind `alias_exact`, conf `high` | 900 | canonical Indian names | "roti" → Chapati/Roti | alias points at a `data_quality_flag` row ("puri" → Poori) → dropped |
| 1-word query ⇒ wants ingredient not dish | `qTokens==1 && category=='indian_dish' && nameTokens>1` → −120 | −120 | "brinjal" → the vegetable | works for ingredients | **hurts "biryani"/"upma"/"poha" as single words** |
| extra-token penalty scaled by query specificity | 1-word: −20/token; multi-word: −6/token | 20 / 6 | "egg" shouldn't hit "Egg, chicken, whole, cooked, poached" | works | a genuinely specific 1-word food with a long canonical name loses |
| prep-word penalty | `PREP_WORDS` −45/token not in query | −45 | plain > prepared | "egg" avoids "deviled egg" | "curry"/"sauce" penalise legit dish rows for ingredient queries |
| component-part penalty | `COMPONENT_PARTS` −90/token | −90 | "egg" ≠ "egg yolk" (+160 % kcal) | works | rare |
| deli-form penalty | `/(deli|luncheon|oven.roasted|honey.roasted|cold cut|reformed|water added)/` −160 | −160 | "chicken breast" ≠ 79-kcal deli slice | works | a real "oven roasted" home dish loses 160 |
| cooking-state preference | `expectedState` ±70 | ±70 | rice cooked ≠ raw (342 kcal/150 g swing) | works | `ready_to_eat`/`unspecified` invisible; `expectedState` returns first hit only |
| wet-dish density bump | cooked + `WET_DISH_RE` & !`DRY_FINISHED_RE` → density ≥ 1.0 | 1.0 | dal makhani served as curry, not dry dal | corrects bowl bias 0.87→0.95 (claimed) | "rice" always matched wet (1.0) even for fried rice unless "fried" in name; "biryani" forced 1.0 |
| moisture-mismatch | `DRIED_RE` in name & !NORMALLY_DRY & no dry word in query → −120 | −120 | "coconut" → fresh not desiccated | works | "figs" → fresh |
| source rank | `−(SOURCE_RANK ?? 5) × 4` (INDB 0 … OFF 16) | ×4 | prefer Indian/lab data | tiny nudge | **too weak** — a branded OFF `all_tokens` match beats an INDB `regional_alias` match easily |
| `serving_grams` bonus | +8 if present | +8 | measured serving = better record | negligible | — |
| data-quality quarantine | `data_quality_flag` → score −150, `confidence:'unreliable'`, `trustworthy:false`, dropped by `estimateFood` & picker | −150 + gate | frying-bath INDB rows (72–95 % fat) must not be logged | correct in principle | **no fallback** — poori/papdi/bhaji/pakora become silent 0; contains-pass leaks them back as 'low' (§19.1) |
| count-portion beats own serving | `resolveGrams` reaches `portionToGrams` before step 3; own-serving branch limited to `{bowl,katori,plate,piece,medium_bowl}` | — | "1 egg" = 50 g not INDB's 151 g boiled-egg-dish | correct | "1 poori" can't benefit (not catalogued) |
| tie-break by name length | `sort … || (a._norm.length − b._norm.length)` | — | shorter name = more generic | "chicken breast" → shortest of the equal-scoring cooking variants | picks "stewed, skin eaten" over "grilled, skin not eaten" purely on string length |
| fuzzy only as last resort, capped 'low' | after exact+alias+token+substring+backoff all empty; tokens > 3 chars; maxDist 1–2 | — | "chapatti" typo → "chapati" | works | tokens ≤ 3 (`dal`, `roti`? 4 chars OK) never corrected |
| kNN confidence bands | sim ≥ .55 medium, ≥ .30 low, else unreliable | — | honest about a weak neighbour | — | papdi chaat sim 0.69 → 'medium' despite all neighbours being wrong-category snacks |

---

## 29. Data-Source Inventory

| Dataset | Records | Fields used at runtime | Priority (`SOURCE_RANK`) | Transformation (ingestion) | Runtime usage | Known quality issues |
|---|---:|---|---:|---|---|---|
| **INDB** (`indb:*`) | 1,004 | name, macros, `fiber_g`, micros, `serving_grams`, `serving_description`, `cooking_state`, `category='indian_dish'`, `data_quality_flag` | **0 (highest)** | `ml/src/ingestion/indb_extract.py` — cooked composite dishes; frying-bath & serving-plausibility validators add `data_quality_flag` | primary target for Indian dish queries via alias/`all_tokens`; supplies `serving_grams` for bowl/plate/piece | **223/1004 (22%) quarantined** (fried snacks: poori, papdi, pakora, bhaji, chaat, samosa); serving weights noisy (poha 54.6 g; "1 plate" up to 836 g elsewhere); dishes only — no "papdi chaat", "vada pav", "pani puri", "frankie" |
| **IFCT2017** (`ifct:*`) | 506 | macros, extensive micros, `cooking_state` (mostly `raw`), `cuisine='INDIAN'` | 1 | `ifct2017_extract*.py` — lab tables 1–12; `indianFoodAuthoritative.test.js` pins byte-fidelity | ingredient-level Indian queries (paneer, dal grains, spices); Tier-2 ingredient grounding | single ingredients only; mostly `raw`/uncooked basis; some name typos ("quial", "omlet") |
| **USDA_FDC** (`usda:*`) | 12,890 | name, macros, `fiber_g`, `sugar_g`, `sodium_mg`, `cooking_state` | 2 | `usda_extract.py` — SR Legacy + FNDDS + branded; "NFS" entries kept | dominates generic/global matches; "chicken breast", "biryani with meat", "Dal", "Upma" all come from here | many near-identical cooking variants (stewed/sauteed/rotisserie × skin/no-skin) with only string-length tie-break; "NFS" only −8; FNDDS composite dishes ("Biryani with chicken" 104 kcal/100 g) are thin |
| **CNF_CANADA** (`cnf:*`) | 4,944 | name, macros, `serving_grams`, `serving_description` | 3 | `cnf_extract.py` | fills gaps; "Indian, bread, chapati or roti" entries; egg/dairy | heavy duplication with USDA; some computed decimals to 9 dp (`306.669371197`) |
| **OPEN_FOOD_FACTS** (`off:*`) | 2,009 | name, macros, `fiber_g`, `sugar_g`, `sodium_mg`, `brand`, `cooking_state='unspecified'/'ready_to_eat'` | 4 (lowest) | `off_india_pull.py` + `off_bulk_filter.py` — India-market packaged | branded products; **the papdi-chaat match** (`off:8906151230391`); barcode index | **user-contributed, unvalidated**: impossible sodium (30 g/100 g on "Aloo Sev"), packaged-snack macros passed off as dish matches when the query is a dish name, no `serving_grams` (→ 100 g assumption or volume estimate) |
| `food_aliases.json` | 4,006 aliases / 6,248 mappings | alias → `[source_id]` | — | `build_food_aliases.py` — **generated from the DB**, not curated | exact-alias 900 boost + regional-alias token match | derived not curated → misses `poori`, `dal`, `bhindi`, `papdi chaat`; 524 ambiguous (multi-target); some point at quarantined rows |
| `fallback_v4_index.json` | (kNN corpus) | name, `energy_kcal/protein_g/fat_g/carb_g` | — | `export_fallback_v4_index.py` — TF-IDF vocab+idf on full corpus | Tier 3 only (`me.js`) | measured ~15–21 % median APE *for known families*; degenerate for out-of-corpus dishes |
| `off_barcode_index.json` | (barcodes) | product macros + serving | — | `build_barcode_index.py` | barcode scan | packaged only |
| SQL `foods` table | small (seed) | name, `serving`, `piece_g`, macros, `category`, `cuisine` | — | `init-db.js` hand-seed | **Pipeline C only** + materialisation target | tiny; the "265 kcal paneer vs lab 305" rows the JSON engine was built to replace still live here |

---

## 30. End-to-End Runtime Traces `[RUNTIME]`

All from the **real exported `estimateFood()`** unless noted.

### 30.1 `2 roti`
```
RAW            "2 roti"
splitItems     ["2 roti"]
parseFragment  {qty:2, unit:"roti", name:"roti"}          (canonicalPortion('roti')='roti'; name←unit)
search("roti") aliases["roti"]=["indb:ASC096"] → alias_exact boost 900
  TOP: indb:ASC096 "Chapati/Roti"  score 900  conf high  202.311 kcal/100g  serving_grams 36
trust gate     pass (trustworthy true)
resolveGrams   unit not MASS_VOLUME → portionToGrams('roti',2,{foodServingGrams:36})
               'roti' ∉ {bowl,katori,plate,piece,medium_bowl} → COUNT_PORTIONS.roti.grams=40 → 80 g   basis 'count'
scaleNutrition 80/100 × {202.311, P5.875, C35.65, F3.561, fiber6.311}
FINAL          grams 80 · 162 kcal · P4.7 · C28.5 · F2.9 · confidence high
```

### 30.2 `150g chicken breast`
```
parseFragment  {qty:150, unit:"g", name:"chicken breast"}
search         head_noun ("Chicken breast, <qualifier>") — ~10 rows tie at score 789
               tie-break = shortest _norm → usda:2705965 "Chicken breast, stewed, skin eaten" (181 kcal, P24.7, F8.28)
resolveGrams   unit ∈ MASS_VOLUME → toGrams(150,'g') → 150 g   basis 'measured'
FINAL          150 g · 272 kcal · P37.1 · C0 · F12.4 · confidence medium
NOTE           "stewed" + "skin eaten" chosen purely by string length among equal scorers; a plain macro-tracker means grilled skinless (~165 kcal/100g)
```

### 30.3 `2 eggs and 1 banana`
```
splitItems     ["2 eggs","1 banana"]
"2 eggs"  → {2,"egg","egg"} → COUNT_PORTIONS.egg 50 → 100 g
          → cnf:132 "Egg, chicken, whole, cooked, poached" (head_noun, conf LOW) → 145 kcal · P11.8 · F10.0
"1 banana"→ {1,"banana","banana"} → COUNT_PORTIONS.banana 120 → 120 g
          → usda:2709224 "Banana, raw" (head_noun, conf medium) → 116 kcal · C27.3
FINAL     total 261 kcal · P12.7 · C28.2 · F10.4 · meal confidence LOW  (dragged down by the egg row)
```

### 30.4 `1 bowl dal`
```
parseFragment  {qty:1, unit:"bowl", name:"dal"}      (aliases["dal"] = null)
search("dal")  usda:2707427 "Dal"  exact_name  score 1062  conf high  145 kcal/100g (no serving_grams)
resolveGrams   portionToGrams('bowl',1,{foodServingGrams:undefined})
               own-serving branch skipped (no serving_grams) → VOLUME_PORTIONS.bowl 250 mL
               effectiveDensity("Dal","cooked"): densityFor 0.85 → cooked & WET_DISH_RE("dal") & !DRY → max(0.85,1.0)=1.0
               → 250 g   basis 'volume'
scaleNutrition 250/100 × {145, P8.6, C19.17, F4.31, fiber7.5}
FINAL          250 g · 363 kcal · P21.5 · C47.9 · F10.8 · fiber 18.75 · confidence high
NOTE           the USDA "Dal" row is carb/fiber-heavy for cooked dal; 363 kcal/bowl is high but not absurd; no plausibility check runs
```

### 30.5 `81g puri`  (and `30g puri`)
```
parseFragment  {qty:81, unit:"g", name:"puri"}
search("puri") aliases["puri"]=["indb:ASC107"] → alias_exact 900
  TOP: indb:ASC107 "Poori"  737.635 kcal/100g  F77.6  data_quality_flag="frying-bath contamination: 95% of energy is fat … 1 poori derived as 125 g, above a sane maximum of 120 g"
  → confidence 'unreliable', trustworthy:false
TRUST GATE     food.trustworthy === false  →  unresolved.push({matched:"Poori", reason:<the flag text>});  continue
FINAL          items:[]  ·  total 0/0/0/0  ·  confidence null
               disclaimer "Some items could not be matched and are NOT included in the total."
```
`30g puri` is identical — same drop, 0 kcal. **`puri` never produces a number on this path.** (In `/me/foods/resolve` the row is likewise excluded from the picker; the contains-pass could surface "Bread, puri" USDA at 409 kcal/100 g as a `medium` option, or "Methi/Sweet poori" as a leaked `low` option — §19.1.)

### 30.6 `206g papdi chaat`  ← THE SCREENSHOT
```
RAW            "206g papdi chaat"
splitItems     ["206g papdi chaat"]
parseFragment  cleaned "206g papdi chaat" → parseQuantity sees "206g" glued → {qty:206, unit:"g", name:"papdi chaat"}
search("papdi chaat")
   qTokens = ["papdi","chaat"]
   aliases["papdi chaat"] = undefined  (no boost)
   Only ONE row scores at all:
     off:8906151230391 "Quinoa Puffs - Dahi Papdi Chaat"
       name tokens ⊇ {"papdi","chaat"}  → match_kind 'all_tokens'  base +200
       − extra-token penalty (name has "quinoa","puffs","dahi" extra; multi-word query → −6 each)
       − source rank OFF 4 × 4 = −16
       cooking_state 'ready_to_eat' → no ±70
       ⇒ _score ≈ 130   ⇒ overlap = min(2/2, 2/5) = 0.40  ⇒ confidence 'medium'
   The real INDB street-food rows ("Papdi" 709 kcal, "Bhel puri" 510, "Khakhra chaat" 359, "Spicy corn chaat" 480)
     ALL carry data_quality_flag → score −150 and, more importantly, would be dropped by the trust gate anyway.
   "Balaji Wafers Chaat Chaska", "Haldiram Soan Papdi" etc. do NOT contain BOTH tokens → score null.
SELECTED       off:8906151230391  (dry packaged quinoa-puff snack)
               per-100g: 422.857 kcal · P8.286 · C75.2 · F10.086 · fiber null
trust gate     pass (OFF row, no data_quality_flag → trustworthy:true)
resolveGrams   unit "g" ∈ MASS_VOLUME → toGrams(206,'g') → 206 g   basis 'measured'
scaleNutrition 206/100 × per-100g
FINAL          grams 206 · 871 kcal · P17.07 · C154.91 · F20.78 · fiber — · confidence medium
               disclaimer "Matched against measured food-composition data. Portion sizes are estimates."
Atwater check  4·17.07 + 4·154.91 + 9·20.78 = 875 ≈ 871  → macros ARE self-consistent (an Atwater check would NOT flag this)
```

**This reproduces the screenshot exactly.**

Variants `[RUNTIME]`:
- `papdi chaat` (no weight) → same row, **100 g assumed** → 423 kcal / C75.2.
- `1 plate papdi chaat` → `plate` 350 mL × density ≈ 360.5 g → **1524 kcal / C271**.
- Tier-2 `estimateCompositional([papdi, yogurt, potato, chickpeas, sev, chutney])` → **554 kcal / 187 g cooked**, `confidence high` (but `sodium_mg` = 31,980 from a bad OFF ingredient row).
- Tier-3 `estimateFoodKnn('papdi chaat', {grams:206})` → **1064 kcal** (neighbours: quinoa puffs 0.69, papdi gathiya 0.62, soan papdi 0.51 — all dry snacks).

### 30.7 `2 roti, dal and curd`  `[RUNTIME]`
```
splitItems ["2 roti","dal","curd"]
"2 roti" → indb:ASC096, 80 g, 162 kcal (as §30.1)
"dal"    → usda:2707427 "Dal" exact_name, NO qty/unit → step 4 → 100 g ASSUMED → 145 kcal · P8.6 · C19.2 · F4.3
"curd"   → off:8904057395602 "Curd" exact_name conf high, 100 g ASSUMED → 65 kcal · P9.4 · C5.1 · F5.4
           ⚠ Atwater(this row) = 4·9.4+4·5.1+9·5.4 = 107 vs stated 65  → 39 % inconsistent, USED AS-IS
FINAL total 372 kcal · P22.7 · C52.8 · F12.6 · confidence high
       disclaimer says "Portion sizes are estimates" but 2 of 3 items are silent 100 g assumptions
```

---

## 31. Current Error Taxonomy

| # | Class | What happens | Real example (`[RUNTIME]`) | Root cause |
|---|---|---|---|---|
| **A** | **Search — wrong food selected** | a lexical match to a branded/packaged/wrong-category row wins | `papdi chaat` → "Quinoa Puffs - Dahi Papdi Chaat" (871 kcal/206 g); `upma` → a USDA row, not INDB Upma; `150g chicken breast` → "stewed, skin eaten" | corpus has no right row; ranker rewards token containment; brand penalties don't cover "quinoa/puffs"; 1-word-dish −120 pushes toward generics; tie-break by name length |
| **B** | **Portion — right food, wrong grams** | count word not catalogued → 100 g or noisy `serving_grams`; two disagreeing volume tables | `poha` → 54.6 g (INDB serving); `dal`/`curd` with no qty → 100 g assumed; `1 tbsp` = 15 g via `toGrams` but 25 g via a portion chip | `COUNT_PORTIONS` gaps; `ML_PER_UNIT` ≠ `VOLUME_PORTIONS`; noisy INDB `serving_grams`; assumption not surfaced in `confidence` |
| **C** | **Nutrition-source — right food & grams, bad source values** | an OFF/USDA row's own macros are wrong or internally inconsistent | "Curd" 65 kcal with P9.4/C5.1/F5.4 (Atwater 107); OFF "Aloo Sev" sodium ~30 g/100 g | user-contributed OFF data; no read-side validation of the JSON DB; `per_100g_unreliable` flag ignored |
| **D** | **Cooking-state mismatch** | picks a raw row for a normally-cooked food or vice-versa | rare on Tier 1 due to ±70; but `ready_to_eat` gets no signal, and `expectedState` only checks the first matching token | `expectedState` is a keyword set; no yield transform so a wrong pick is a full raw↔cooked error |
| **E** | **Composite-dish — dish treated as one ingredient / half a dish** | `rajma chawal`/`dal chawal`/`chole bhature` resolve to only the curry; street foods resolve to a packaged lookalike | `chole bhature` → "Chickpeas curry" 196 kcal (bhature absent) | no decomposition on the live path; Tier 2 unrouted; corpus lacks combo rows |
| **F** | **Oil — omitted or (potentially) double-counted** | `estimateFood` never adjusts oil; fried INDB rows are quarantined so their (already-oil-inflated) values never show either | `81g puri` → 0 kcal (dropped); `papdi`/`pakora`/`samosa` as free text → 0 or a snack lookalike | oil model only reachable from `/me/foods/resolve`; frying-bath quarantine has no fallback |
| **G** | **Alias — wrong / missing synonym** | alias points at a quarantined row, or no alias exists | `puri` → Poori (dropped); `poori`, `dal`, `bhindi`, `papdi chaat` → no alias | alias file generated from the DB, not curated |
| **H** | **Confidence — mislabelled** | contains-pass items with a `data_quality_flag` labelled `low`/`undefined` instead of `unreliable`/`false`; meal confidence dominated by one weak item; branded-snack match labelled `medium` | `searchFoods('poori')` → "Methi poori" `conf=low trust=undefined` (frying-bath flagged); papdi-chaat item `confidence: 'medium'` | `searchFoods` extra-branch doesn't run the trust/confidence mapping; confidence is lexical-only |
| **I** | **Arithmetic** | none found — `× grams/100` and the sums are correct | `2.06 × 422.857 = 871.09` ✓ | (arithmetic layer is sound; it faithfully scales a wrong row) |
| **J** | **Input parsing** | ` with `/adjacency not split; ranges ("2-3 roti") not handled; adjectives reach the ranker | `roti with sabzi` → 1 fragment; `dal chawal` → 1 fragment | `splitItems` deliberately conservative on ` with `; no range grammar |

---

## Architecture Strengths (what is working — do not break)

1. **"Never fabricate" discipline.** A miss is reported in `unresolved`, never invented. `null` macros render `—`, never `0`. `data_quality_flag` rows are quarantined. Fuzzy hits are capped at `low`. Tests enforce all of this.
2. **Deterministic, inspectable, fast.** No network, no model load in Tier 1; ~14 MB JSON read once, cached for process life. Same input → same output, every time. Trivially unit-testable, and heavily tested (21 cases in `foodEstimator.test.js`, 15+ in `indianFoodAuthoritative.test.js`).
3. **Correct parsing & arithmetic for the common cases.** grams, counts (`2 roti` = 80 g), volumes, multi-item sentences, glued quantities (`150g`), glyph fractions, `dozen`/`couple` — all handled and tested. The scaling math is right.
4. **Server-authoritative macros.** The browser never computes DB-food nutrition; every quantity change re-resolves server-side; client totals are never trusted on write.
5. **Food-specific portions.** `listPortions`/`portionToGrams` size a "bowl" by the food's own density/serving — a bowl of dal ≠ a bowl of spinach.
6. **Honest uncertainty in Tier 4.** The LLM path returns a *range*, grounds each component against real rows, derives its own confidence, and never overwrites a measured value or feeds the training set.
7. **IFCT/INDB fidelity is pinned.** `indianFoodAuthoritative.test.js` asserts byte-faithful macros for a curated `source_id` set — ingestion drift would fail CI.
8. **Cost governance on Tier 4.** Provider failover chain, per-provider cooldown on 429, optional daily budget, DB-backed across serverless instances.

## Architecture Weaknesses

1. **Single-record retrieval + linear scale is the whole model.** No decomposition on the live path. For any composite Indian dish absent from the 1,510 Indian rows, the best lexical match is often a packaged product or the wrong half of the dish, and it is scaled with full confidence.
2. **No nutritional plausibility layer on Tier 1.** No kcal/100 g ceiling, no Atwater cross-check, no dish-category expected-range check on `estimateFood` output. `MAX_PLAUSIBLE_KCAL = 902` is test-only. 871 kcal / 155 g carb for a 206 g "chaat" passes silently.
3. **Corpus is 7 % Indian and 22 % of that is quarantined.** The frying-bath quarantine is correct data hygiene but has **no fallback** — poori/papdi/pakora/bhaji/samosa as free text return a silent 0 (Pipeline A) with no Tier-2/3/4 rescue.
4. **Three pipelines + two engine copies.** `estimateFood` (unused by any UI), `me.js /foods/*` (live), `/intel/*` (live, different DB), and a stale encoding-corrupted `.cjs` copy of the engine behind the meal-template builder. Same query can get different answers depending on which screen.
5. **Source preference is far too weak.** `−rank × 4` (16-point max spread) is nothing against a 200-point `all_tokens` base. An OFF branded snack routinely outranks an INDB dish.
6. **Alias file is auto-generated, not curated.** The exact words that need regional knowledge (`poori`, `dal`, `bhindi`, `papdi chaat`, `pani puri`) have no alias or a broken one.
7. **Provenance is lost at log time.** `meal_logs` keeps only 4 macros + name; `source_id`, `grams`, `cooking_state`, search-confidence all discarded — so a bad estimate can't be audited after the fact.
8. **Two internally-inconsistent volume tables** (`ML_PER_UNIT` vs `VOLUME_PORTIONS`) for tbsp/glass/bowls.
9. **Confidence is purely lexical** and doesn't account for portion assumption, ambiguity, source, or nutritional plausibility.
10. **`estimateFood` has no Tier 2/3/4 escalation at all**, while `me.js /foods/search` has 3→4. The better-engineered fallback chain isn't on the sentence-parsing path.

---

## What Is Actually ML vs Deterministic — explicit answers

| Question | Answer |
|---|---|
| Is an ML model loaded for the normal food-estimate route (`estimateFood` / `/me/foods/search` + `/resolve`)? | **No.** Tier 1 is regex + hand-weighted keyword scoring + `× grams/100`. |
| Is inference happening? | **Not in Tier 1.** Tier 3 (`estimateFoodKnn`, used only when `me.js /foods/search` returns zero rows) runs a **TF-IDF + cosine kNN** over `fallback_v4_index.json` — that's a fitted retrieval model, reproduced in pure JS. Tier 4 calls a remote LLM. |
| Embedding model / semantic similarity / vector search? | **Tier 3 only**, and it's sparse TF-IDF (word 1-2-grams + char 3-5-grams + 12 binary class cues), not dense embeddings. Tiers 1/2 are lexical/rule-based. |
| Remote AI API called? | **Tier 4 only** (`foodAI.js` → Groq/Gemini/OpenRouter/Ollama), and only on an explicit "Estimate with AI" tap after a search miss in `FoodLogSheet`/`CustomizeMealSheet`. **Never on the `/api/nutrition/.../ai-estimate` route** despite its name. |
| Is `ml/models/skos-food-v1/` runtime code? | **Partly.** `foodEstimate.reference.js` (Tier 1), `compositional.reference.js` (Tier 2), `fallbackKnn.reference.js` (Tier 3), `barcodeLookup.reference.js` are `require()`d by the live backend. The `.py` files in `ml/src/**` and `ml/models/skos-cal-v1/` are **not** loaded by the food path (skos-cal-v1 is the *workout burn* model). `ml/models/skos-food-v1/*.test.js` and `*.md` are dev artifacts. |
| Is the Python reference loaded? | **No.** Only the JS ports run in the backend. Python is training/validation/ingestion only. |
| Is the system "purely deterministic"? | **Tiers 1–3 yes** (same input → same output). **Tier 4 no** (LLM), but its output is validated, grounded against deterministic rows, range-bounded, and never written back as ground truth. |
| Does "ai-estimate" in the route name mean AI runs? | **No.** `POST /api/nutrition/clients/:id/meals/ai-estimate` is 100 % deterministic Tier 1. Only `POST /me/foods/ai-estimate` invokes an LLM. |

---

## 34. Current-System Scorecard (0–10)

| Dimension | Score | Evidence |
|---|---:|---|
| Food identification (single common foods) | **7** | `[RUNTIME]` roti, paneer, banana, chicken, dal, rice, dosa, idli all resolve to a sensible row; exact/alias/head-noun ladder + brand penalties work. Loses points for USDA cooking-variant tie-break by name length and the 1-word-dish −120. |
| Indian food coverage | **4** | 1,510/21,353 rows Indian; 223 INDB rows quarantined; no "papdi chaat", "vada pav", "pani puri", "misal", "frankie", "kathi roll", "dabeli"; combos (rajma chawal) resolve to one component. |
| Alias handling | **5** | mechanism is sound (900 boost, regional tokens) but the file is DB-generated → `poori`/`dal`/`bhindi`/`papdi chaat` missing; 524 ambiguous; some point at quarantined rows. |
| Portion detection (parsing) | **8** | `[RUNTIME]` grams, counts (`2 roti`=80 g ✓), volumes, multi-item, glued qty, fractions all correct and tested; `2 roti` bug is fixed. −2 for uncatalogued count words and ` with `/adjacency. |
| Gram accuracy (portion → grams) | **6** | count refs are reasonable; but two disagreeing volume tables, noisy INDB `serving_grams` (poha 54.6 g), and 100 g assumption for ~68 % of no-serving rows / no-qty inputs, not surfaced in confidence. |
| Nutrition accuracy (given the right row) | **7** | `× grams/100` is exact and IFCT/INDB fidelity is pinned; −3 for using OFF/USDA rows with internally inconsistent macros (Curd 65 vs Atwater 107) and no read-side validation. |
| Cooking-state handling | **5** | ±70 ranking nudge works for raw↔cooked; but no nutrition transform, `ready_to_eat`/`unspecified` invisible, `expectedState` is first-token-wins. |
| Fried-food handling | **2** | `estimateFood` never calls `adjustOil`; fried INDB rows quarantined with no fallback → poori/papdi/pakora = silent 0 or a snack lookalike. Oil model is good but unreachable from the sentence path. |
| Composite-dish handling | **2** | no decomposition on the live path; Tier 2 ported but unrouted; combos → one component; street foods → packaged lookalike. The papdi-chaat 871 kcal is the archetype. |
| Multi-food parsing | **7** | `[RUNTIME]` `2 roti, dal and curd` → 3 items; `+`, `,`, `and`, `;`, `&`, `\n` all handled and tested. −3 for ` with `/adjacency and no quantity distribution. |
| Confidence reliability | **4** | purely lexical; contains-pass leak mislabels quarantined rows as `low`/`undefined`; one weak item taints a whole meal; a branded-snack wrong match is labelled `medium`; portion assumption doesn't lower it. |
| Fallback behaviour | **5** | `estimateFood`: honest but dead-ends (silent 0, no Tier 2/3/4). `me.js /foods/search`: good — Tier 3 auto, Tier 4 on tap. Split score. |
| Test coverage | **6** | strong on parsing/units/fidelity/tiers-in-isolation/write-validation; **zero** tests for composite street food sanity, `puri` free text, Atwater on `estimateFood` output, combo completeness, the engine-copy divergence, or the contains-pass leak. |
| Production robustness | **7** | never throws, degrades to "cannot estimate" if artifacts missing, rate-limited, Tier-4 cost-governed, `null`-safe rendering. −3 for three pipelines + a corrupted engine copy, and provenance lost at log time. |

**Weighted overall (composite Indian food is the stated goal): ~4.5/10.** For Western single foods and explicit-gram logging: ~7.5/10.

---

## 35. Top 20 Problems

> Priority: **P0** = directly produces user-visible wrong numbers on common input · **P1** = wrong/again-silent on a common class · **P2** = correctness/consistency risk · **P3** = maintainability.

### P0-1 — Composite dishes resolve to one database row and are linearly scaled (no decomposition)
- **Where:** `foodEstimator.js:403` (`search.search(name,{limit:1})` → `scaleNutrition`); Tier 2 exists (`compositional.reference.js`) but no route calls it.
- **Root cause:** architecture — Tier 1 is retrieval + multiply.
- **Example:** `chole bhature` → "Chickpeas curry" 196 kcal (bhature missing); `papdi chaat` → packaged snack 871 kcal/206 g.
- **Impact:** 30–70 % error on any Indian combo/street food; the single biggest driver of the audit.
- **Frequency:** every composite-dish log (very common for Indian users).
- **Direction:** route Tier 2 for dish-shaped queries; or a curated composite table; or Tier-4 decomposition on this path.

### P0-2 — No nutritional plausibility layer on `estimateFood`
- **Where:** `foodEstimator.js:estimateFood` — no check anywhere; `MAX_PLAUSIBLE_KCAL` (reference.js:36) is test-only.
- **Root cause:** validation was built for the write side (`foodValidation.js`) and Tier 4 (`foodAI.js`), never wired to Tier 1.
- **Example:** 871 kcal + 155 g carb for a 206 g serving passes with `confidence: medium`.
- **Impact:** wrong matches are presented as confident measured data.
- **Frequency:** every out-of-corpus dish.
- **Direction:** post-selection sanity gate (kcal/100 g ≤ ~900; per-serving kcal band by dish class; carb/protein/fat density ranges) that downgrades confidence or forces `unresolved`/Tier-escalation.

### P0-3 — Branded / packaged Open Food Facts rows win dish-name queries
- **Where:** `FoodSearch.score` — `all_tokens` +200 with only `−(SOURCE_RANK)×4` against a branded OFF row; `BRAND_PENALTIES` doesn't cover generic snack words.
- **Root cause:** source preference (max 16 pts) is negligible vs match-kind base; `brand` field carries no penalty; no "is this a packaged product being matched to a dish query" guard.
- **Example:** `off:8906151230391 "Quinoa Puffs - Dahi Papdi Chaat"` beats everything for `papdi chaat`.
- **Impact:** dish queries silently answered with packaged-snack macros (dry, carb-dense).
- **Frequency:** any Indian dish with a packaged namesake (bhel, chaat, poha mix, upma mix, dhokla mix, …).
- **Direction:** heavy penalty when `brand`/`cuisine==='PACKAGED'` and the query has no brand token; or exclude `PACKAGED` from free-text dish estimation.

### P0-4 — Fried Indian snacks return a silent 0 on the sentence path
- **Where:** `foodEstimator.js:413` trust gate drops `data_quality_flag` rows; no Tier 2/3/4 fallback in `estimateFood`.
- **Root cause:** 223/1004 INDB rows quarantined (correctly), but `estimateFood` has no rescue tier.
- **Example:** `81g puri` / `2 samosa` / `1 plate pakora` → `items: []`, `total: 0`, `unresolved`.
- **Impact:** user logs a fried snack, meal total silently omits it — the exact failure `foodEstimator.js`'s own header says it fixed for the old 23-item table.
- **Frequency:** common (fried snacks are heavily logged).
- **Direction:** on a trust-gate drop, fall to Tier 3 kNN or a curated fried-snack table instead of nothing.

### P1-5 — Combo dishes (`rajma chawal`, `dal chawal`, `chole bhature`) drop half the meal
- **Where:** token/alias match lands on the curry component; the rice/bread token is absorbed or ignored.
- **Root cause:** no multi-component expansion; `splitItems` doesn't split `dal chawal`.
- **Example `[RUNTIME]`:** `chole bhature` → 196 kcal (should be ~700–900).
- **Impact:** ~50 % undercount on a common meal shape.
- **Direction:** a combo-expansion map (`rajma chawal` → rajma + rice) feeding Tier 2.

### P1-6 — `estimateFood` has no Tier 2/3/4 escalation
- **Where:** `foodEstimator.js:estimateFood` vs `me.js:483` (which does 3→4).
- **Root cause:** the escalation chain was built into the picker flow only.
- **Impact:** the sentence path dead-ends on every miss.
- **Direction:** share the `me.js` escalation logic.

### P1-7 — No frontend uses `estimateFood`, yet it's the "meal AI estimate" API
- **Where:** `[RUNTIME]` grep of `frontend/src` finds no caller of `/api/nutrition/clients/:id/meals/ai-estimate`.
- **Root cause:** UI moved to `/me/foods/*`; the route + `AskSK` (`/intel/*`) are legacy.
- **Impact:** effort spent on a path users don't hit; the screenshot likely came from the `me.js` search+resolve path (which selects the *same* wrong row).
- **Direction:** decide which path is canonical and converge; the wrong-match root cause is shared so fixing the engine fixes both.

### P1-8 — Two diverged copies of the Tier-1 engine; one is encoding-corrupted
- **Where:** `ml/models/skos-food-v1/foodEstimate.reference.js` (763 ln, current) vs `backend/src/services/skos-food/foodEstimate.reference.cjs` (677 ln, stale). The `.cjs` copy has a BOM, mojibake em-dashes, and a **corrupted combining-marks regex** (`/[╠Ç-═»]/g`) so it won't strip diacritics; it also lacks the fuzzy tier and has older backoff logic.
- **Where used:** `.cjs` → `skos-food/index.js` → `me.js:1146` (`POST /me/meals/:id/items` SKOS fallback for the meal-template builder).
- **Impact:** the meal-builder can resolve a query differently (and mis-normalise accented input) vs the rest of the app.
- **Direction:** delete the `.cjs` copy; point `skos-food/index.js` at the canonical engine.

### P1-9 — Contains-pass leaks quarantined rows into the picker as `low`/`undefined`
- **Where:** `foodEstimator.js:531` — `{...f, confidence: f.confidence || 'low'}`; raw rows have no `trustworthy`/`confidence`.
- **Example `[RUNTIME]`:** `searchFoods('poori')` → "Methi poori", "Sweet poori" as `conf=low trust=undefined` despite frying-bath flags; `FoodLogSheet` only disables `trustworthy === false`, so they're pickable.
- **Impact:** a 79 %-fat contaminated row can be logged as a "low confidence" food.
- **Direction:** run the same trust/confidence mapping (or a `data_quality_flag` filter) on the contains-pass.

### P1-10 — 100 g assumption is invisible in `confidence`
- **Where:** `resolveGrams` sets `grams_assumed:true`, `grams_basis:'assumed_100g'`; `estimateFood` never lowers `confidence` for it.
- **Example `[RUNTIME]`:** `2 roti, dal and curd` → dal & curd are 100 g guesses, meal `confidence: high`.
- **Impact:** a meal that's half-guessed reads as fully confident.
- **Direction:** cap item confidence at `medium` (or `low`) when `grams_assumed`.

### P1-11 — Internally inconsistent source macros used without a read-side check
- **Where:** `scaleNutrition` trusts the row; `validateFoodRecord` (Atwater ±35 %) is never applied to `unified_food_db.json` at read time.
- **Example `[RUNTIME]`:** "Curd" (OFF) 65 kcal vs Atwater 107 (−39 %); "Aloo Sev" sodium ≈ 30 g/100 g.
- **Impact:** wrong macros scaled confidently; huge sodium in Tier-2 sums.
- **Direction:** compute an at-load Atwater flag; downgrade confidence or prefer a consistent alternative; honour the already-present `per_100g_unreliable` field (currently dead).

### P1-12 — Two disagreeing volume→mL tables
- **Where:** `ML_PER_UNIT` (`toGrams`, used for typed units) vs `VOLUME_PORTIONS` (`portionToGrams`, used for portion chips): tbsp 15 vs 25, glass 250 vs 330, small/soup bowl differ.
- **Impact:** `1 tbsp oil` typed = 13.8 g; picked as a chip = ~23 g — a 66 % swing on the same input.
- **Direction:** one table.

### P2-13 — 1-word-query → `indian_dish` −120 penalises legitimate dish names
- **Where:** `score():346`.
- **Example `[RUNTIME]`:** `upma` → a USDA row, not INDB "Upma"; same risk for `biryani`, `poha`, `dhokla`, `khichdi`.
- **Impact:** single-word Indian dish queries drift to generics/ingredients.
- **Direction:** exempt names the query token *heads* (`_head === qNorm`), or dishes with a `serving_grams`.

### P2-14 — USDA cooking-variant ties broken by name length
- **Where:** `_searchExact:434` `|| (a._norm.length − b._norm.length)`.
- **Example `[RUNTIME]`:** `150g chicken breast` → "stewed, skin eaten" (shortest of ~10 rows at score 789), not "grilled, skin not eaten".
- **Impact:** systematic bias toward whatever cooking method has the shortest name and toward "skin eaten".
- **Direction:** tie-break on a nutrition prior (leaner/most-common method) or source rank, not string length.

### P2-15 — `estimateFood` items lose all provenance at log time
- **Where:** `meal_logs` schema has no `source_id`/`grams`/`cooking_state`; `POST /nutrition/.../meals/log` inserts macros only.
- **Impact:** a wrong estimate can't be diagnosed post-hoc; no feedback signal for the sentence path.
- **Direction:** persist `source_id`, `grams`, `grams_basis`, `confidence`.

### P2-16 — Alias file auto-generated, missing the words that need curation
- **Where:** `food_aliases.json` `generated_from: unified_food_db.json`.
- **Example `[RUNTIME]`:** no alias for `poori`, `dal`, `bhindi`, `papdi chaat`, `pani puri`; `dahi` → 84 CNF/OFF dairy rows, no Indian curd.
- **Direction:** a curated regional-name → canonical-dish overlay.

### P2-17 — `_norm` singularisation is naive (`/(es|s)$/`)
- **Where:** `parseFragment:262` (`head.replace(/(?:es|s)$/, '')`).
- **Example:** "leaves" → "leav", "berries" → "berri", "loaves" → "loav".
- **Impact:** unit/count detection misfires on irregular plurals.
- **Direction:** small irregular-plural map or a real inflector.

### P2-18 — ` with ` and adjacency are not item separators
- **Where:** `splitItems:206` (`[,\n;+&]` + `and` only).
- **Example `[RUNTIME]`:** `roti with sabzi`, `dal chawal`, `chicken rice` → one fragment; the secondary food is lost or absorbed.
- **Direction:** split on ` with `; detect known 2-food adjacency pairs.

### P2-19 — Tier-2 sums bad micro values blindly (no per-nutrient sanity)
- **Where:** `CompositionalCalculator.compute:468` — `totals[k] += v × factor` for every field.
- **Example `[RUNTIME]`:** papdi chaat Tier-2 `sodium_mg = 31,980`.
- **Direction:** clamp/flag per-nutrient outliers before summing.

### P3-20 — Three parallel food pipelines, no shared contract
- **Where:** `estimateFood` (JSON DB), `me.js /foods/*` (JSON DB + LLM), `/intel/*` (SQL `foods` table + its own `units.js` with `perPieceDefaults.roti = 35` ≠ 40).
- **Impact:** the same "2 rotis" can weigh 80 g (Pipeline A/B) or 70 g (Pipeline C); maintenance and reasoning cost.
- **Direction:** collapse Pipeline C onto the JSON engine, or explicitly retire `AskSK`'s food path.

---

## 36. Special Investigation — the fundamental architecture question

> **Which architecture does SKOS currently implement?**

```
CURRENT (live path — estimateFood, /me/foods/search + /resolve):

   query ──▶ FoodSearch.search(limit:1) ──▶ ONE database row ──▶ per-100g macros ──▶ × (grams / 100) ──▶ done
                                             (no components, no summing, no recipe)
```

**Not** this:

```
NOT IMPLEMENTED on the live path:

   dish ──▶ infer composition ──▶ estimate each ingredient's weight ──▶ price each vs measured DB ──▶ sum ──▶ dish nutrition
```

The decomposition architecture **exists in code** — `CompositionalCalculator` (`compositional.reference.js`, Tier 2, faithful port, exported as `estimateCompositional`) and the Tier-4 LLM-composition path in `foodAI.js` — but:
- Tier 2 is **called by no route** (only `compositional.test.js`).
- Tier 4 decomposition runs **only** on an explicit "Estimate with AI" tap in `FoodLogSheet`/`CustomizeMealSheet`, and only if an AI provider key is configured.

So for the routes that produced the papdi-chaat number, **it is strictly "pick one row, multiply."** This is why every composite Indian food is fragile: the dish either exists as a single pre-composited row (INDB — good, when not quarantined) or it doesn't, and then the nearest lexical neighbour (a packaged snack, or half the dish) is scaled with full confidence.

---

## 37. Special Investigation — plausibility layer

> **Does the system have any plausibility checks (kcal/100 g, macro-derived kcal, protein/carb/fat density, category ranges, dish-specific ranges)?**

**On the Tier-1 deterministic path that produced the screenshot: No nutritional plausibility layer currently exists.**

What exists elsewhere, and does **not** run on `estimateFood`:

| Check | Where | Runs on |
|---|---|---|
| `energy_kcal < 0 || > MAX_PLAUSIBLE_KCAL (902)` | `ml/models/skos-food-v1/foodEstimate.test.js:60` | **a test only** — asserts the *dataset* has no such row; not a runtime guard |
| Atwater `4P+4C+9F` within ±35 % of stated kcal; `P+C+F+fiber ≤ 100 g` | `foodValidation.js` (`validateFoodRecord`) | **write side only** — barcode/manual-label/custom foods entering the SQL `foods` table |
| serving weight ≤ 3000 g; total kcal ≤ 4000/serving; Atwater ratio 0.5–1.8; not "big kcal + all-zero macros" | `foodAI.js` (`validateAIFoodResponse`) | **Tier 4 only** |
| Atwater on an aggregated community correction | `foodFeedback.js:127` | Tier-4 cache promotion only |
| kNN confidence bands by top-similarity | `foodEstimator.js:742` | Tier 3 only |

There is **no** check anywhere for: kcal/100 g of the *scaled result*, per-serving kcal vs a dish-category expectation, carbohydrate density (155 g carb in a 206 g serving = 75 g/100 g — implausible for a wet chaat), protein/fat density ranges, or "does this row look like a dry packaged snack when the user asked for a wet dish."

---

## 38. Special Investigation — calorie/macro consistency

> **Does the system verify `calories ≈ 4·protein + 4·carbs + 9·fat`?**

- **On the Tier-1 `estimateFood` path: No.** Calories are always the stored `energy_kcal` scaled linearly; macros are the stored macros scaled linearly; the two are never compared. `[RUNTIME]`: `2 roti, dal and curd` includes a "Curd" row at 65 kcal whose own macros imply ~107 kcal (−39 %), used verbatim.
- **On Tier 4 and the write side: Yes** — `atwaterConsistent(cal, P, C, F)` (`foodAI.js:367`, ratio 0.5–1.8) and `validateFoodRecord` (`foodValidation.js`, ±35 %). Both reject/flag; neither runs for `estimateFood` or the JSON DB at read time.

> **Can that validation detect (a) mathematically inconsistent results and (b) nutritionally implausible but mathematically consistent results?**

- **(a) Mathematically inconsistent** — yes, where it runs. The Atwater ratio catches a misplaced decimal or a P/C/F↔kcal mismatch.
- **(b) Nutritionally implausible but self-consistent** — **no. Nothing in the codebase catches this.** The papdi-chaat result (871 kcal, P17/C155/F21) is *perfectly Atwater-consistent* (4·17+4·155+9·21 ≈ 875). An Atwater check would pass it. It is wrong because it's the **wrong food**, not because the arithmetic is broken. Detecting it needs a *category/plausibility* model (expected kcal & macro ranges for "a plate of chaat", "a packaged puffed snack", etc.) — which does not exist.

---

## 39. Note on scope

The papdi-chaat case is the trigger, not the target. The failure generalises to: every composite Indian dish absent from the ~1,180 usable INDB rows; every combo (`X chawal`, `X bhature`, `X pav`); every fried snack (quarantined → 0 or lookalike); and, more mildly, every USDA cooking-variant tie and every OFF row with self-inconsistent macros. Fixing "papdi chaat" specifically (e.g. adding one alias) would leave the class untouched.

---

## 40 & 41. FINAL DELIVERABLE — direct answers

### Q1 — What EXACTLY happens on `206g papdi chaat`?

`POST /api/nutrition/clients/:id/meals/ai-estimate {text:"206g papdi chaat"}` → `estimateFood("206g papdi chaat")`:
1. `splitItems` → `["206g papdi chaat"]` (no separators).
2. `parseFragment` → `parseQuantity` sees `"206g"` glued → `{ qty: 206, unit: "g", name: "papdi chaat" }`.
3. `search.search("papdi chaat", {limit:1})`: query tokens `["papdi","chaat"]`. No alias. Exactly **one** row scores > `null`: **`off:8906151230391 "Quinoa Puffs - Dahi Papdi Chaat"`** (Open Food Facts, `ready_to_eat`, per-100 g: 422.857 kcal / P8.286 / C75.2 / F10.086), via `match_kind: "all_tokens"`, `_score ≈ 130`, `overlap = 0.40` → `confidence: "medium"`. The real INDB street-food rows ("Papdi", "Bhel puri", "Khakhra chaat", "Spicy corn chaat") all carry a `data_quality_flag` and are scored −150 and would be dropped by the trust gate regardless.
4. Trust gate: OFF row has no `data_quality_flag` → `trustworthy: true` → passes.
5. `resolveGrams`: `unit "g" ∈ MASS_VOLUME` → `toGrams(206,"g")` → `206 g`, `grams_basis: "measured"`.
6. `scaleNutrition(row, 206)`: `206/100 × per-100g` → **871.09 kcal, P 17.07, C 154.91, F 20.78**, fiber `null`.
7. Response: 1 item, `total {calories: 871, protein: 17.1, carbs: 154.9, fat: 20.8}`, `confidence: "medium"`, `disclaimer: "Matched against measured food-composition data. Portion sizes are estimates."`

The same wrong row is selected by `GET /me/foods/search?q=papdi chaat` and priced identically by `POST /me/foods/resolve {grams:206}` → `871.09 kcal` (`[RUNTIME]` verified) — so the live picker UI produces the identical number.

### Q2 — Why can it produce ≈871 kcal / 17 P / 155 C / 21 F?

Because the matched row is a **dry packaged quinoa-puff snack** at **422.86 kcal and 75.2 g carbohydrate per 100 g**, and `206 g × (values / 100)` = 871 kcal / 154.9 g carb. The arithmetic is correct; the row is wrong. The macros are even internally Atwater-consistent (4·17 + 4·155 + 9·21 ≈ 875), so no consistency check could catch it.

### Q3 — Exact root cause (which mechanism)?

**Not** the parser (206 g of a dish = 206 g ✓), **not** portion resolution (explicit grams ✓), **not** the scaling arithmetic (✓), **not** oil adjustment (never invoked on this path).

**It is a combination of three things, in order of contribution:**
1. **Wrong food match (search / corpus).** There is no real "papdi chaat" dish in the 21k corpus. The only row containing both query tokens and not quarantined is a branded Open Food Facts snack product. Source preference (`−rank×4`, max 16 pts) is far too weak to matter against the `all_tokens` +200 base, and `BRAND_PENALTIES` doesn't cover "quinoa"/"puffs", so the packaged product wins with `confidence: medium`.
2. **"Total dish weight" is treated as "weight of the selected row's food" and scaled linearly** — single-record retrieval + `× grams/100`, with **no composite-dish decomposition** on the live path (Tier 2 exists but is unrouted).
3. **No plausibility layer.** Nothing checks that 871 kcal / 75 g-carb-per-100 g for "a plate of chaat" is implausible, or that a `PACKAGED`/`ready_to_eat` snack row is a poor answer to a wet-dish query.

Data-coverage bug feeding #1: the correct-ish INDB street-food rows are all `data_quality_flag`-quarantined (frying-bath contamination), removing every reasonable Indian alternative.

### Q4 — `30g puri`

`parseFragment` → `{qty:30, unit:"g", name:"puri"}`. `search("puri")` → `aliases["puri"] = ["indb:ASC107"]` → `alias_exact` boost → **`indb:ASC107 "Poori"`** (737.6 kcal/100 g, F77.6), which carries `data_quality_flag` ("frying-bath contamination: 95 % of energy is fat … 1 poori derived as 125 g, above a sane maximum of 120 g") → `confidence: "unreliable"`, `trustworthy: false`. **Trust gate drops it** → `items: []`, `total: {0,0,0,0}`, `confidence: null`, `unresolved: [{fragment:"30g puri", matched:"Poori", reason:<flag text>}]`, disclaimer *"Some items could not be matched and are NOT included in the total."* **`30g puri` contributes nothing.** (`[RUNTIME]` verified.)

### Q5 — `81g puri`

**Identical to Q4** — same match, same `trustworthy:false` drop, **0 kcal, reported unresolved.** The gram amount is irrelevant because the row is quarantined before scaling. (`[RUNTIME]` verified.)

### Q6 — `2 roti`

`parseFragment` → `{qty:2, unit:"roti", name:"roti"}` (`canonicalPortion('roti')='roti'`; name set from the unit). `search("roti")` → `aliases["roti"] = ["indb:ASC096"]` → `alias_exact` boost 900 → **`indb:ASC096 "Chapati/Roti"`** (202.311 kcal/100 g, P5.875, C35.65, F3.561, fiber 6.311; `serving_grams` 36), `confidence: "high"`, `trustworthy: true`. `resolveGrams` → `portionToGrams("roti", 2, {foodServingGrams:36})` → `'roti' ∉ {bowl,katori,plate,piece,medium_bowl}` so the own-serving branch is skipped → `COUNT_PORTIONS.roti.grams = 40` → **80 g**, `grams_basis: "count"`. `scaleNutrition` → **162 kcal, P 4.7, C 28.5, F 2.9, fiber 5.05**. Response: 1 item, `unit: "2 x roti"`, `confidence: "high"`. **The historical "2 roti bypasses COUNT_PORTIONS" bug does not reproduce in current code** (`[RUNTIME]` verified; pinned by `foodEstimator.test.js:34` and `indianFoodAuthoritative.test.js:157`).

### Q7 — `150g chicken breast`

`parseFragment` → `{qty:150, unit:"g", name:"chicken breast"}`. `search("chicken breast")` → many USDA rows named `"Chicken breast, <method>, skin (not) eaten"` match as `head_noun` and tie at `_score ≈ 789`; the tie-break `score DESC, then _norm.length ASC` picks the shortest name → **`usda:2705965 "Chicken breast, stewed, skin eaten"`** (181 kcal/100 g, P24.7, F8.28), `match_kind: "head_noun"`, `confidence: "medium"`. `resolveGrams` → `toGrams(150,"g")` → **150 g**, `grams_basis: "measured"`. `scaleNutrition` → **272 kcal, P 37.1, C 0, F 12.4**. Reasonable ballpark for chicken breast, but "stewed / skin eaten" is chosen purely by string length among ~10 equal-scoring cooking variants — a plain macro-tracker almost always means grilled/baked skinless (~165 kcal/100 g). (`[RUNTIME]` verified.)

### Q8 — The 5 biggest architectural reasons SKOS estimates can be wrong

1. **Single-record retrieval + linear scale, with no decomposition on the live path.** Any dish not present as one pre-composited row is answered by the nearest lexical neighbour (packaged product, or half the dish) scaled with full confidence. (P0-1, §15, §36)
2. **No nutritional plausibility layer on Tier 1.** No kcal/100 g ceiling, no per-serving/per-category range check, no Atwater cross-check, no "packaged snack answering a wet-dish query" guard on `estimateFood` output. Wrong matches are labelled `medium`/`high`. (P0-2, §37, §38)
3. **Corpus is 7 % Indian and 22 % of that is quarantined, with no fallback tier on the sentence path.** Fried snacks and most street food either don't exist or are dropped → silent 0 or a branded lookalike. (P0-3, P0-4, §29)
4. **Ranking is hand-weighted lexical matching with a near-zero source preference.** `−rank×4` can't stop an Open Food Facts branded row from beating an INDB dish; USDA cooking-variant ties are broken by name length; the 1-word-dish −120 pushes `biryani`/`upma`/`poha` toward generics. (P0-3, P2-13, P2-14, §6, §28)
5. **Portion/grams under-specification is invisible.** ~68 % of rows lack `serving_grams`; no-quantity inputs and uncatalogued count words fall to a 100 g assumption that never lowers `confidence`; two internally-disagreeing volume tables. (P1-10, P1-12, P2-17, §10, §11)

### Q9 — Which problems are fixable by which lever

| Lever | Problems it addresses |
|---|---|
| **Better data** | P0-4 (curated fried-snack + street-food + combo rows so the quarantine has real alternatives); P1-5 (`X chawal`/`X bhature` combo entries); P1-11 (fix/flag internally-inconsistent OFF rows; honour `per_100g_unreliable`); P2-16 (curated regional alias overlay for `poori`, `dal`, `bhindi`, `papdi chaat`, `pani puri`). Highest ROI per unit effort — the engine is fine, the corpus is thin. |
| **Better search / ranking** | P0-3 (real penalty for `PACKAGED`/branded rows on brand-less dish queries; exclude OFF from free-text dish estimation); P2-13 (exempt `_head === query` from the 1-word-dish penalty); P2-14 (tie-break on a nutrition prior / source, not string length); P1-9 (run the trust/confidence mapping on the contains-pass). |
| **Better portion parsing** | P1-12 (single volume table); P2-17 (irregular-plural handling); P2-18 (split ` with ` / known adjacency pairs); add `poori/pakora/tikki/kachori/thepla/cheela/vada pav` to `COUNT_PORTIONS`. |
| **Better heuristics** | P1-10 (cap confidence when `grams_assumed`); P2-19 (per-nutrient outlier clamp before Tier-2 summing); P2-15 (persist provenance to `meal_logs`). |
| **A deterministic nutrition/plausibility engine** | P0-2 (post-selection sanity gate: kcal/100 g ≤ ~900; per-serving kcal band by dish class; carb/protein/fat density ranges; downgrade or escalate on failure); P0-3/#8-(b) (category-model check that flags "packaged-snack macros for a wet-dish query"). This is the single missing layer that would have caught the papdi-chaat number. |
| **Composite-dish decomposition** | P0-1, P1-5, P1-6 — route the *already-built* Tier 2 `CompositionalCalculator` for dish-shaped queries, feed it from a curated dish→ingredients map (and/or Tier 4), and add the `me.js` 3→4 escalation to `estimateFood`. |
| **An ML / LLM layer** | P0-1 residual (dishes with no curated composition and no INDB row — Tier 4 already does this well in the picker; extend it to the sentence path); ambiguity resolution; better-than-lexical retrieval (a trained ranker or dense retrieval to replace the hand-weighted `score()`), only after the plausibility gate and curated data are in place. |

### Q10 — What should NOT be changed (already working)

1. **The "never fabricate" contract** — `unresolved` reporting, `null`→`—` rendering, `data_quality_flag` quarantine as a concept, fuzzy hits capped at `low`, and the tests that enforce all of it. Keep every one.
2. **`parseFragment` / `parseQuantity` / `splitItems`** — grams, counts (`2 roti` = 80 g ✓), volumes, multi-item, glued quantities, glyph fractions, `dozen`/`couple` are all correct and well-tested. Leave the parser alone (add the ` with `-split and count-word entries as *additions*, don't rewrite).
3. **`scaleNutrition`** — `× grams / 100`, 10-field, null-safe, `round2`. The arithmetic layer is sound; it faithfully scales whatever row it's given. The bug is upstream (which row), never here.
4. **Server-authoritative macros + the client re-resolving on every quantity change** (`FoodLogSheet` ↔ `/me/foods/resolve`). Don't move macro math into the browser.
5. **Food-specific portions** (`listPortions` / `portionToGrams` sizing "a bowl" by the food's own density/serving). The concept is right; only the two-table inconsistency needs fixing.
6. **Tier 4's honesty machinery** — uncertainty ranges, per-component DB grounding, backend-derived confidence, "never write an AI number into the measured DB or training set", cost governance. This is the model for how the other tiers should present uncertainty.
7. **IFCT/INDB byte-fidelity + its pinning test.** Whatever changes to ranking or data, keep `indianFoodAuthoritative.test.js` green.
8. **`adjustOil`'s delta-from-baseline, mass-conserving design** (`resolveFoodQuantity` path). The formula is right; it just needs a real per-recipe oil baseline instead of `fat_g`, and it needs to be reachable from more paths.

---

*End of audit. No source file, dataset, or database row was modified. Awaiting the next instruction before any change is made.*
