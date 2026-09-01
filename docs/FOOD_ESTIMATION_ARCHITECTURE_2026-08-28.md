# SKOS Universal Food & Nutrition Estimation Architecture

**Date:** 2026-08-28
**Status:** Proposal — design only. **No code has been modified.** Awaiting explicit approval before any change.
**Baseline:** [`docs/FOOD_ESTIMATION_AUDIT_2026-08-28.md`](FOOD_ESTIMATION_AUDIT_2026-08-28.md)
**Relates to:** [`ml/docs/CONTRACT_skos-food-v1.md`](../ml/docs/CONTRACT_skos-food-v1.md) — this proposes an additive evolution of the `food-v1` schema toward `food-v2`, not a silent edit.

**Design stance:** no food-specific hacks. Every mechanism below is justified as improving an entire *class* of estimation, and is cross-referenced to a class, not an example. `papdi chaat / puri / roti / chicken breast / rajma chawal / chole bhature` appear only as regression anchors.

---

## Table of contents

1. Current architecture
2. Ideal architecture (principles)
3. Gap analysis
4. Proposed pipeline
5. Food ontology
6. Retrieval architecture
7. Ranking architecture
8. Portion architecture
9. Preparation-state architecture
10. Composite-food architecture
11. Nutrition calculation architecture
12. Cooking-transformation architecture
13. Data-quality architecture
14. Plausibility architecture
15. Confidence architecture
16. Uncertainty architecture
17. LLM / ML architecture
18. Database architecture
19. API architecture
20. Performance architecture
21. Testing architecture
22. Benchmark architecture
23. Migration strategy
24. Rollback strategy
25. Risk analysis
26. Prioritisation (P0–P4)
27. Implementation plan (Phases 1–10)
28. What stays / improves / redesigned / removed / introduced
29. Final quality bar — how the engine answers the 10 questions

---

## 1. Current Architecture

Established in the audit; summarised here as the "before".

```
                       ┌─────────────────────────────────────────────┐
Pipeline A  (no UI)     │ POST /nutrition/…/meals/ai-estimate          │
                        │   → estimateFood(text)   foodEstimator.js    │
                        │   splitItems → parseFragment → resolveGrams  │
                        │   → FoodSearch.search(limit:1) → hits[0]     │
                        │   → trust gate → scaleNutrition(× g/100)     │  Tier 1 ONLY
                        └─────────────────────────────────────────────┘
                       ┌─────────────────────────────────────────────┐
Pipeline B  (live UI)  │ GET /me/foods/search  → searchFoods()        │
FoodLogSheet.jsx       │ POST /me/foods/resolve → resolveFoodQuantity()│  Tier 1
CustomizeMealSheet.jsx │ + estimateFoodKnn() when 0 results           │  + Tier 3 (kNN, fallback only)
                        │ POST /me/foods/ai-estimate → estimateFoodAI()│  + Tier 4 (LLM, explicit tap)
                        └─────────────────────────────────────────────┘
                       ┌─────────────────────────────────────────────┐
Pipeline C  (live UI)  │ POST /intel/parse-food → parseFoodInput()    │  SEPARATE engine
AskSK.jsx              │   resolveFood() over the SQLite `foods` table│  intelligence/*.js
                        │   computeNutrition() (units.js multipliers)  │  NOT the JSON DB
                        └─────────────────────────────────────────────┘
                       ┌─────────────────────────────────────────────┐
Stale 4th copy         │ backend/src/services/skos-food/              │  encoding-corrupted
                        │   foodEstimate.reference.cjs (677 ln)        │  used by me.js meal-builder
                        └─────────────────────────────────────────────┘

Data: ml/data/processed/unified_food_db.json (21,353 rows, 7% Indian, 22% of INDB quarantined)
      + food_aliases.json (4,006 auto-generated aliases)
      + fallback_v4_index.json (Tier-3 TF-IDF), off_barcode_index.json
```

**Defining property:** identity, portion, and nutrition are collapsed into "pick one row, multiply by grams/100". No classifier, no plausibility layer, no decomposition on the live path. Confidence = lexical token overlap.

---

## 2. Ideal Architecture (principles)

An excellent general-purpose engine treats food estimation as a **pipeline of independent sub-problems**, each with its own evidence and uncertainty, composed into a final number that is auditable end-to-end.

| # | Principle | Consequence for SKOS |
|---|---|---|
| P-1 | **Separate the sub-problems.** Identity, structure, portion, preparation, nutrition, plausibility are distinct stages with typed contracts. | Refactor the monolithic `estimateFood` into composable stages. |
| P-2 | **Classify before you resolve.** A single ingredient, a prepared food, a composite dish, a branded product, and a meal need different resolution strategies. | Add a `classifyFood` stage that routes. |
| P-3 | **Retrieve candidates; decide separately.** Retrieval produces a *set with evidence*; ranking and strategy selection are downstream. | Split `FoodSearch.search` into `retrieve` + `rank`. |
| P-4 | **Cheapest sufficient tier wins.** Deterministic lexical resolves the majority; semantic and LLM escalate only on low margin or genuine structural unknowns. | Formal escalation ladder T0–T5 with a `margin` gate. |
| P-5 | **Numbers come from one place.** Only a deterministic compute+validate stage produces nutrition. ML ranks; LLM proposes structure; neither emits final macros that are used. | `foodAI.js`'s `resolveComponents` pattern generalised and made mandatory. |
| P-6 | **Plausibility is category-aware, never a global cap.** A result can be Atwater-perfect and still nutritionally wrong (wrong food). | `category_plausibility[class][prep_state]` ranges. |
| P-7 | **Uncertainty propagates; confidence composes it.** Confidence is evidence-based, not a search score. | Per-stage `(value, rel_unc, reason)`; a composer. |
| P-8 | **Never a silent zero.** A quarantined/absent/low-evidence food degrades to an explicitly-labelled estimate or an explicit `unresolved` — never drops from a total unseen. | Quarantine gets a fallback path. |
| P-9 | **One canonical core.** Every route calls it; no parallel nutrition logic. | New `backend/src/services/food/` engine; A/B/C converge. |
| P-10 | **Minimum complexity for maximum reliable accuracy.** Every layer must pay for itself on the benchmark or it doesn't ship. | Phase gates tied to §22 metrics. |
| P-11 | **Data quality is first-class.** The best source depends on the query. Quarantine, completeness, Atwater, region-match travel with every candidate. | `quality_profile` on every candidate; context-dependent source preference. |
| P-12 | **Generalise, don't patch.** Overlays (aliases, composite templates, plausibility ranges) are *data* covering classes, not `if food == X` branches. | Curated JSON overlays, version-controlled, benchmark-gated. |

---

## 3. Gap Analysis

| Capability | Current | Ideal | Gap | Priority |
|---|---|---|---|---|
| **Food-type classification** | none — every query treated identically | classifier routes ingredient / prepared / composite / branded / meal / beverage | **full** | P0 |
| **Composite decomposition on the live path** | none (`CompositionalCalculator` built, unrouted) | classifier → pre-composited row → template → recipe → LLM structure → sum, with mass reconciliation | **full on Pipeline A/B** | P0 |
| **Nutritional plausibility** | none on Tier 1; `MAX_PLAUSIBLE_KCAL` is test-only | category+prep-aware ranges on the *scaled result*, Atwater, per-serving band | **full** | P0 |
| **Branded vs generic disambiguation** | `brand` field carries no signal; source pref = −rank×4 (negligible) | namespace filter + intent inference from query | **full** | P0 |
| **Quarantine handling** | hard drop → silent 0, no fallback | drop for *direct use*, but fall to estimate/transform with disclaimer | **partial** | P0 |
| **Retrieval** | exact/alias/token/substring/backoff + last-resort fuzzy | + semantic kNN as a *candidate generator*, + LLM query understanding on low margin | **semantic + LLM understanding missing** | P2 |
| **Ranking** | hand-tuned weights in `score()`; tie-break by name length | feature vector + systematic/learned scorer + `top1_margin` output | **systematic/learned model missing** | P1 |
| **Preparation state** | `cooking_state` string, ±70 ranking nudge, no transform | normalised `prep_state` enum, prep-compatible ranking, transform model | **normalisation + transform missing** | P1 |
| **Portion** | two disagreeing volume tables; count catalog is a fixed list; 100 g assumption invisible to confidence | one table; `food_class`-driven; portion uncertainty recorded | **consistency + uncertainty missing** | P1 |
| **Cooking transformations** | `adjustOil` only (baseline ≈ `fat_g`), unreachable from Pipeline A; no water/yield | `prep_state × food_class` yield/oil tables, applied only on state-mismatch, anti-double-count guard | **water/yield missing; oil baseline wrong; unreachable** | P1 |
| **Confidence** | = lexical overlap band | composed from identity/portion/source/prep/composite/plausibility evidence | **full redesign** | P1 |
| **Uncertainty range** | Tier 4 only | every path emits a range | **missing on Tier 1/3** | P1 |
| **Canonical core** | 3 pipelines + stale `.cjs` copy | 1 engine, all routes call it | **full consolidation** | P1 |
| **Data quality** | `data_quality_flag` (223 rows), `per_100g_unreliable` (94, **dead**), no dedup, messy `cooking_state` | quality_profile per row, dedup clusters, Atwater flags, serving_grams fill | **structured quality layer missing** | P2 |
| **Provenance persistence** | `meal_logs` keeps 4 macros + name | `source_id`, `grams`, `basis`, `confidence` persisted | **missing** | P2 |
| **Benchmark** | ranking fixture (`foodSearchBenchmark.test.js`); no nutrition-accuracy set | 300–500 labelled items, cuisine/class/prep/portion strata, calibration | **full** | P2 |
| **Semantic index** | Tier-3 TF-IDF used only as last-resort *answer* | same index reused as *candidate generator* | **role change** | P2 |
| **Working parts to keep** | parsing, `× g/100` math, "never fabricate", IFCT/INDB fidelity, food-specific portions, Tier-4 honesty machinery | unchanged | — | keep |

---

## 4. Proposed Pipeline

A single ordered pipeline, `estimateMeal(text, ctx) → MealEstimate`. Each stage has a typed input/output and emits `(value, rel_uncertainty, reason)` telemetry. Stages are individually unit-testable and individually flag-gated during migration.

```
                                 estimateMeal(text, ctx)
                                          │
  T0  NORMALISE ───────────────────────── │  text → NFKD, transliteration map, script detect, lowercase,
                                          │  keep [letters digits . / -], collapse. ctx = {cuisine_hint, locale, user_tz}
                                          ▼
  T0  SEGMENT ─────────────────────────── │  sentence → Fragment[]  { raw, qty, unit, name_phrase, modifiers[],
                                          │  relation: 'standalone'|'with'|'and'|'combo' }
                                          │  splits: , ; + & \n  "and"  "with"  known 2-food adjacency pairs
                                          ▼
  ┌───────────────────────── per Fragment ─────────────────────────────────────────────┐
  │                                                                                     │
  │  1  CLASSIFY ──────────────  Fragment → FoodClassification                          │
  │       { kind: ingredient|prepared|composite|branded|beverage|meal,                  │
  │         prep_intent: raw|boiled|steamed|grilled|roasted|baked|fried|cooked_wet|…|null,│
  │         cuisine_hint, brand_token?, modifiers_normalised[] }                        │
  │       deterministic rules first (modifier lexicon, DB head-noun lookup);            │
  │       LLM only when rules abstain AND retrieval margin (below) is low               │
  │                                                                                     │
  │  2  RETRIEVE ──────────────  name_phrase → Candidate[]  (each: row + evidence)      │
  │       L0 exact/alias  ·  L1 token/phrase/backoff  ·  L2 semantic kNN               │
  │       (L3 LLM query-understanding only if L0–L2 return nothing above a floor)       │
  │                                                                                     │
  │  3  FILTER ────────────────  drop: quarantined (for direct use) · prep-incompatible │
  │       · namespace-incompatible (generic query ↔ branded row & vice-versa)           │
  │       keep a "rescue pool" of the dropped-for-quality rows for strategy D/F         │
  │                                                                                     │
  │  4  RANK ──────────────────  feature vector → score → ranked Candidate[] + top1_margin│
  │                                                                                     │
  │  5  SELECT STRATEGY ───────  by (classification.kind, top candidate quality, margin)│
  │       A direct single-row        strong match, kind∈{ingredient,prepared,branded}   │
  │       B prep-variant             right food, wrong prep_state → pick sibling row    │
  │       C decompose               kind=composite AND no good pre-composited row:      │
  │            pre-composited row → composite_map template → DB recipe → LLM structure  │
  │       D semantic estimate       no candidate above floor → kNN neighbour estimate   │
  │       E LLM reasoning           structure genuinely unknown (rare)                  │
  │       F rescue                  only a quarantined row exists → estimate + heavy    │
  │                                  confidence penalty + explicit disclaimer           │
  │       G unresolved              evidence insufficient → report, never 0-in-total    │
  │                                                                                     │
  │  6  PORTION ───────────────  grams = explicit mass/vol  >  food-specific portion    │
  │       > standard portion × density  >  row.serving_grams × n  >  category default   │
  │       emits portion_rel_unc  (explicit 0 · standard .15 · vague .4 · default .5)    │
  │                                                                                     │
  │  7  TRANSFORM ─────────────  apply ONLY if source prep_state ≠ target prep_state    │
  │       and not already baked in:  water yield · oil absorption · edible-portion      │
  │       anti-double-count guard: matched row already fried/wet → no oil/water added   │
  │                                                                                     │
  │  8  COMPUTE ───────────────  DETERMINISTIC.  per-100g × grams/100  (single row)     │
  │       or  Σ component (resolved rows × component grams)  (decompose)                │
  │       — the ONLY stage that produces nutrition numbers                              │
  │                                                                                     │
  │  9  PLAUSIBILITY ──────────  vs category_plausibility[class][prep_state]:           │
  │       kcal/100g range · protein/carb/fat density ranges · per-serving kcal band     │
  │       · Atwater 4P+4C+9F consistency  (separate check)                              │
  │       pass → ok ;  soft-fail → widen range + downgrade confidence + reason ;        │
  │       hard-fail → re-enter SELECT STRATEGY with this candidate excluded, else G     │
  │                                                                                     │
  │  10 UNCERTAINTY ──────────  combine per-stage rel_unc → total_rel_unc               │
  │       range = estimate × (1 ± total_rel_unc)  (per macro + kcal)                    │
  │                                                                                     │
  │  11 CONFIDENCE ───────────  band = f(total_rel_unc, hard flags, margin, coverage)   │
  │                                                                                     │
  └─────────────────────────────────────────────────────────────────────────────────────┘
                                          │
  AGGREGATE ────────────────────────────  Σ items → MealEstimate
                                          { items[], totals, range, confidence,
                                            unresolved[], assumptions[], alternatives[],
                                            provenance[], schema_version:'food-v2' }
```

**Escalation gate (P-4):** a query exits at the first stage that produces a candidate with `top1_margin ≥ MARGIN_FLOOR` **and** a passing plausibility check. Only low-margin / structurally-unknown / plausibility-failing queries reach L2 semantic, and only those reach T4 LLM. Target: ≥ 85 % resolve at L0–L1, < 5 % reach LLM.

---

## 5. Food Ontology

The 21k rows **stay per-100 g and unchanged**. Add a **derived metadata layer** (built offline, cached exactly like today's `FoodSearch` lazy singleton) and a small **curated overlay layer** (hand-maintained JSON, version-controlled).

### 5.1 Derived per-row metadata (`ml/data/processed/food_metadata.json`, keyed by `source_id`)

| Field | Values | Derivation |
|---|---|---|
| `food_class` | `ingredient` · `dish` · `recipe` · `branded_product` · `beverage` · `condiment` · `supplement` | rules over `category`, `cuisine`, `brand`, name morphology, `source` |
| `prep_state` | `raw` · `boiled` · `steamed` · `grilled` · `roasted` · `baked` · `fried` · `cooked_wet` · `cooked_dry` · `ready_to_eat` · `unspecified` | normalise the messy `cooking_state` (+ `cooking_state_inferred`) + name keywords |
| `namespace` | `generic` · `branded` | `brand` present OR `cuisine === 'PACKAGED'` → branded |
| `head_noun`, `qualifiers[]` | strings | `food_name` split on first comma / parenthetical (generalises the existing `_head`) |
| `cuisine_norm`, `region` | ISO-ish region tags | `cuisine` + name + source heuristics |
| `portion_class` | `piece_small` · `piece_large` · `flatbread` · `liquid` · `semisolid` · `dry_loose` · `spreadable` · … | for density + standard-portion selection |
| `quality_profile` | object (see §13) | `source_rank`, `completeness`, `atwater_ok`, `has_serving`, `quarantined`, `per100g_unreliable`, `dup_cluster_id` |
| `embedding` | sparse TF-IDF vec (reuse `fallbackKnn` vectoriser) or small quantised dense | offline build |
| `components` | `[{source_id?, name, fraction}]` \| null | populated where INDB recipe data exists (`indb_recipe_oil.json`, `indb_dishes.json`); else null |

### 5.2 Curated overlays (`ml/data/overlays/`)

| File | Shape | Size target | Purpose / class it covers |
|---|---|---|---|
| `alias_overlay.json` | `{ "<alias>": {canonical_source_id? , canonical_name, region?} }` | ~300–800 | regional / transliterated / colloquial names the auto-generated `food_aliases.json` misses or mis-maps (`poori`, `dal`, `bhindi`, `papdi chaat`, plus non-Indian: `pho`, `pierogi`, `shawarma`, …) |
| `composite_map.json` | `{ "<dish>": { class, components:[{name, typical_fraction, prep_state}], typical_serving_g, cuisine } }` | ~200–500 high-frequency dishes **across all cuisines** | composite dishes with no reliable single row (combos, layered, stuffed, street food, bowls, plates) |
| `category_plausibility.json` | `{ "<food_class>": { "<prep_state>": { kcal_100g:[lo,hi], protein_100g:[lo,hi], carb_100g:[lo,hi], fat_100g:[lo,hi], serving_kcal:[lo,hi] } } }` | ~60 class×prep cells | the plausibility engine (§14) |
| `portion_overlay.json` | `{ "<food or portion_class>": { "<portion>": grams } }` | ~100 | corrections where the generic portion table is wrong for a class |
| `transform_model.json` | `{ "<food_class>": { "<from_state>→<to_state>": { yield, oil_g_100g, note } } }` | ~40 | cooking transformations (§12) |

**Overlays are data, not code.** A reviewer changes JSON; the benchmark (§22) is the gate. No `if (name === 'papdi chaat')` anywhere.

---

## 6. Retrieval Architecture

`retrieve(name_phrase, classification, ctx) → Candidate[]` — a **candidate generator**, not an answerer. Layered, cheapest first; each layer *adds* to the pool, dedup by `source_id`.

| Layer | Mechanism | Cost | Notes |
|---|---|---|---|
| **L0** | exact `_norm` match · `alias_overlay` · `food_aliases.json` | ~0 | current `_searchExact` exact + alias boost, kept |
| **L1** | token-set ⊆ name · phrase (contiguous) · name-prefix · substring · progressive backoff (drop trailing *and* leading token) | ~ms | current logic, with the backoff bug fixed (drop from both ends) |
| **L2** | semantic kNN over `embedding` (reuse `FallbackKnnIndex` machinery), top-K by cosine | ~ms | **role change**: today it's a last-resort *estimate*; here it's *candidate generation* feeding RANK. Returns rows, not numbers. |
| **L3** | LLM query-understanding: `text → {canonical_name, food_class, prep_state, components?}` → re-run L0–L2 on the canonical name | ~s, $ | **only** when L0–L2 return nothing with `token_coverage ≥ 0.5`, or classifier says `composite` with no `composite_map` hit. Never supplies numbers. |

The pool carries every candidate's `evidence`: `{match_kind, token_coverage, phrase_match, semantic_sim, head_noun_match, prep_compatible, namespace_match, cuisine_match, quality_profile}`. FILTER then removes quarantined-for-direct-use and hard-incompatible rows (keeping a rescue pool); RANK orders the rest.

---

## 7. Ranking Architecture

`rank(candidates, classification, ctx) → { ranked: Candidate[], top1_margin }`

**Phase 1 (systematic, transparent):** a documented linear model over a **feature vector**, replacing the ad-hoc additions in `FoodSearch.score`. Weights grouped and rationale'd, not scattered magic numbers.

| Feature group | Features | Direction |
|---|---|---|
| Lexical | exact, head-noun, phrase, token-coverage, prefix, first-token-position | + |
| Semantic | cosine similarity (L2) | + |
| Structural | `food_class` matches `classification.kind`; specificity (name length vs query) | + / context |
| Preparation | `prep_state` compatible with `prep_intent` (hard-ish: incompatible → large −) | + / − |
| Namespace | branded query ↔ branded row; generic query ↔ generic row | + match / − mismatch |
| Cuisine / region | `cuisine_norm` vs `ctx.cuisine_hint` / `classification.cuisine_hint` | + |
| Data quality | `source_rank` (context-weighted, see §13 — *not* a flat −rank×4), `completeness`, `atwater_ok`, `has_serving` | + |
| Anti-patterns | `PREP_WORDS` / `COMPONENT_PARTS` / deli / offal tokens not in query (kept from current) | − |
| Hard filter | `quarantined` (removed pre-rank), `per100g_unreliable` (heavy −) | drop / − |

**`top1_margin`** = `score[0] − score[1]` normalised. Drives: escalation (low margin → try L2/L3), strategy selection (low margin + composite → decompose), and confidence.

**Tie-break:** by `quality_profile` composite then `source_rank`, **never `_norm.length`** (the current name-length tie-break is nutritionally arbitrary — audit §28, P2-14).

**Phase 2 (learned, optional):** once the benchmark (§22) exists, train a pairwise LambdaMART / logistic ranker on the same feature vector. Ship only if it beats the linear model on held-out benchmark identity accuracy. The feature vector stays the contract; the scorer is swappable.

---

## 8. Portion Architecture

`resolvePortion(fragment, food, classification) → { grams, basis, rel_unc }`

**One** volume/density table (kills the `ML_PER_UNIT` vs `VOLUME_PORTIONS` split — audit §11, P1-12).

Precedence:

| Rank | Source | `basis` | `rel_unc` |
|---|---|---|---|
| 1 | explicit user mass/volume (`g`, `kg`, `oz`, `lb`, `ml`, `l`) | `explicit` | 0 |
| 2 | explicit user volume needing density (`cup`, `tbsp`, `bowl`, `katori`, `glass`, `ladle`, `handful`, `plate`, `scoop`, `packet`) → `ml × density(portion_class, prep_state)` | `volume` | 0.12 |
| 3 | food-specific count portion (`roti`, `egg`, `idli`, `dosa`, `slice`, `samosa`, …) driven by `portion_class`/`head_noun`, **not** a fixed list | `count` | 0.15 |
| 4 | `food.serving_grams × n` (row's own measured serving) | `serving` | 0.20 |
| 5 | category default by `food_class`/`portion_class` (e.g. `dish` → 250 g, `beverage` → 250 ml, `condiment` → 20 g) | `category_default` | 0.40 |
| 6 | 100 g (last resort) | `assumed_100g` | 0.50 |

Rules:
- Explicit mass is **authoritative** — no override by a food's own serving (current step-2 `foodServingGrams` override for `{bowl,katori,plate,piece,medium_bowl}` stays, but only when the user gave a *portion word*, not grams).
- `density` comes from `portion_class` + `prep_state` (a bowl of cooked-wet dal ≈ 1.0 g/ml, a bowl of dry namkeen ≈ 0.4) — generalises `effectiveDensity`'s keyword hack.
- `rel_unc` feeds §16. A meal that's half 100 g-assumptions can no longer read "high confidence" (audit P1-10).
- Count-portion catalog expanded and driven by class: any `portion_class ∈ {piece_small, piece_large, flatbread}` gets a per-piece weight from `portion_overlay` or a class default, so `pakora / tikki / kachori / thepla / cheela / dumpling / cookie / cracker` all work without new code.

---

## 9. Preparation-State Architecture

**Normalise** `cooking_state` → `prep_state` enum (§5.1) once, offline.

**Infer target `prep_state`** in CLASSIFY, from:
1. explicit modifier in the query (`grilled`, `deep-fried`, `boiled`, `raw`, `steamed`, `tandoori`, `air-fried`, …) via a modifier→state lexicon;
2. else the food's default eaten-state from a `food_class`/`head_noun` map (generalises `expectedState`'s two hard-coded sets into a table covering all cuisines — grains cooked, fruit raw, cured meats ready_to_eat, etc.);
3. else `unspecified`.

**Use it:**
- RANK: `prep_compatible` feature (compatible +, adjacent ± , contradictory −−).
- SELECT STRATEGY **B**: if the best identity match is the right food in the *wrong* prep_state and a sibling row in the right state exists (same `head_noun`, different `prep_state`), pick the sibling.
- else TRANSFORM (§12) if a transform is defined and the mismatch is bridgeable;
- else keep the row but record `prep_rel_unc` high and note it in `assumptions`.

`ready_to_eat` and `unspecified` become first-class (currently invisible to `score()`).

---

## 10. Composite-Food Architecture

CLASSIFY marks a fragment `composite` when: `head_noun` is a known dish token with `components` in the ontology/overlay, OR the phrase contains a combo pattern (`X chawal`, `X rice`, `X bhature`, `X pav`, `X with Y`), OR the LLM classifier says so. **Simple foods are never decomposed** — the gate is explicit.

Resolution order (SELECT STRATEGY **C**):

| Order | Source of structure | When | How nutrition is computed |
|---|---|---|---|
| C1 | **Pre-composited DB row** (`food_class = dish`, passes quality, `top1_margin` ok) | the dish exists as one good row (INDB "Pav bhaji", "Masala dosa", "Biryani") | direct single-row (Strategy A) — **no decomposition** |
| C2 | **`composite_map` template** | curated template exists | components → each resolved as a sub-query (bounded recursion, depth ≤ 2) → portioned by `typical_fraction × total_edible_g` (or per-component default) → `CompositionalCalculator.compute` sums measured rows |
| C3 | **DB recipe data** (`components` from `indb_recipe_oil.json` / `indb_dishes.json`) | present for this dish | same as C2 with data-derived fractions |
| C4 | **LLM structure inference** (T4) | none of the above, and it's clearly composite | LLM returns `components[] + rough grams`; **every component re-resolved against the DB** (existing `resolveComponents`); LLM macros used *only* for a component with no DB match, flagged `db_grounded:false` |
| C5 | **semantic estimate / unresolved** | structure genuinely unknowable | Strategy D or G |

**Mass reconciliation (hard invariant):** `|Σ component_grams − total_edible_g| / total_edible_g ≤ 0.25`, else re-scale component grams proportionally to the stated/typical total. The LLM may never emit a final calorie number that is used directly (P-5).

**Per-component nutrition** always comes from COMPUTE against a validated row (or a flagged AI fallback). The dish total is the sum, then it passes PLAUSIBILITY as a whole.

---

## 11. Nutrition Calculation Architecture

The **only** stage that produces numbers. Deterministic. Pure.

```
computeSingle(row, grams):            totals[k] = row[k] == null ? null : round2(row[k] * grams/100)   // k ∈ the ~15 macro+micro fields
computeComposite(components):         totals[k] = Σ computeSingle(c.row, c.grams)[k]  (null-safe: null term skipped, tracked in coverage)
```

- Keep `scaleNutrition`'s null-safety (null = not measured, never 0) and rounding discipline — audit says this layer is sound; do not rewrite it.
- Extend the scaled field set to the micros the DB actually carries (`fiber`, `sugar`, `sodium`, `calcium`, `iron`, `potassium`, `magnesium`, `zinc`, plus key vitamins) so composite sums and the UI can surface them.
- Calories: **still the stored `energy_kcal` scaled** — never recomputed from macros. But PLAUSIBILITY (§14) now cross-checks stored kcal vs `4P+4C+9F` and flags divergence (it does not silently "fix" it — consistent with `foodValidation.js`'s stance).
- Output carries `computation` provenance: which row(s), which grams, which basis, per-component breakdown.

---

## 12. Cooking-Transformation Architecture

`transform(row, from_state, to_state, food_class) → { row', applied, note, rel_unc }`, driven by `transform_model.json`.

Principles:
- **Only applied on a genuine state mismatch** that RANK/Strategy-B could not resolve by picking a better row.
- **Anti-double-count guard (P-8 lesson generalised):** if `row.prep_state` already ∈ {`fried`, `cooked_wet`, `roasted`, `baked`}, the preparation is *already reflected* — do **not** add oil/water again. This is exactly why the INDB frying-bath rows are quarantined (oil counted twice); the correct fix is a transform-aware correction, not a blanket drop.
- Transform types: **water yield** (raw grain/legume/pasta → cooked: dilute per-100 g by the yield factor — reuse `compositional.reference.js`'s `YIELD_FACTORS`), **oil absorption** (→ fried: add `oil_g_100g` from the model, mass-conserving, reuse `adjustOil`'s delta math but with a real baseline from the model **not** `fat_g`), **edible-portion** (bone/peel/shell removal).
- Every transform widens `rel_unc` and adds an `assumptions` line.
- **Optional, benchmark-gated:** un-quarantine the ~223 frying-bath INDB rows behind a "subtract the frying-bath excess" correction (their flag text even states the excess: *"92 % of energy is fat"*), converting a silent-0 into a corrected estimate with wide uncertainty. Ship only if it beats "drop + semantic fallback" on the benchmark.

---

## 13. Data-Quality Architecture

Every candidate carries `quality_profile` (built offline):

| Field | Meaning | Used by |
|---|---|---|
| `source_rank` | INDB/IFCT/USDA/CNF/OFF ordinal | RANK — **context-weighted** (below) |
| `completeness` | fraction of core macro+serving fields present | RANK, CONFIDENCE |
| `atwater_ok` | `|4P+4C+9F − kcal| / kcal ≤ 0.25` | RANK, PLAUSIBILITY, CONFIDENCE |
| `has_serving` | `serving_grams > 0` | RANK, PORTION |
| `quarantined` | `data_quality_flag` present | FILTER (hard, for direct use) |
| `per100g_unreliable` | the currently-**dead** DB flag, now honoured | FILTER (heavy −) / RANK |
| `dup_cluster_id` | near-duplicate cluster (USDA/CNF overlap) | dedup in RETRIEVE |
| `region_match(ctx)` | computed per query | RANK |

**Context-dependent source preference (replaces flat −rank×4):** the source weight is a function of `classification` — for an Indian `composite`/`dish` query, INDB/IFCT get a strong bonus and OFF a strong penalty; for a `branded` query, OFF is preferred; for a generic Western `ingredient`, USDA is fine. This is what stops a branded OFF snack winning a dish query (audit P0-3) without globally suppressing OFF (which barcode/packaged flows need).

Offline data-quality pass (Phase 9): compute `atwater_ok` & `completeness` for all rows; cluster duplicates; normalise `cooking_state`; fill `serving_grams` from `portion_class` defaults where absent; emit a data-quality report (missing cuisines, quarantine density by class, bad-record list) to drive corpus work (§28).

---

## 14. Plausibility Architecture

`checkPlausibility(result, classification) → { verdict: ok|soft_fail|hard_fail, reasons[] }`

Against `category_plausibility[food_class][prep_state]`:

| Check | Rule | On fail |
|---|---|---|
| **kcal density** | scaled-result implied kcal/100 g within `[lo, hi]` for the class×state | outside by <25 % → `soft_fail`; ≥25 % → `hard_fail` |
| **macro density** | protein/carb/fat g per 100 g each within class ranges | soft/hard as above |
| **per-serving band** | total kcal within `serving_kcal[lo,hi]` for the class | soft/hard |
| **Atwater consistency** | `|4P+4C+9F − kcal| / kcal ≤ 0.35` | `soft_fail` + note (never auto-correct) |
| **portion sanity** | grams within a class max (e.g. a single `dish` serving ≤ 1500 g; a `condiment` ≤ 100 g) | `hard_fail` |
| **component sanity** (composite) | no single component > 90 % of total kcal unless its `typical_fraction` says so | `soft_fail` |

- **`ok`** → proceed.
- **`soft_fail`** → keep the estimate, **widen the range**, **downgrade confidence** one band, attach `reasons` to `assumptions`.
- **`hard_fail`** → re-enter SELECT STRATEGY with this candidate excluded; if nothing else qualifies → Strategy G (`unresolved`, reported, never counted).

**This is the single highest-leverage addition.** It is category-aware, not a global cap (the papdi-chaat number is Atwater-perfect — only a *class* expectation ("a plate of chaat is ~150–250 kcal/100 g, not 420") catches it). It generalises: any wrong-class match (packaged snack for a wet dish, raw for cooked, ingredient for meal) trips a density or per-serving bound.

---

## 15. Confidence Architecture

Confidence is **composed from evidence**, never equal to a search score (audit P1, §17).

```
confidence_inputs = {
  identity:    f(top1_margin, semantic_sim, classifier_confidence, exact/alias?),
  portion:     1 − portion_rel_unc,
  source:      f(source_rank_ctx, completeness, atwater_ok),
  preparation: {matched:1, sibling:0.9, transformed:0.7, mismatch_kept:0.4, unknown:0.5},
  composite:   component_coverage  (resolved / total, weighted by fraction)   // 1.0 for single-food
  plausibility:{ok:1, soft_fail:0.6, (hard_fail never reaches here)}
}
band = combine(confidence_inputs)  →  high | medium | low | unreliable
hard overrides: quarantined-rescue → max 'low'; grams assumed → max 'medium'; Strategy D/E → max 'medium'
```

Meal confidence = the worst item's band (kept from current), but now each item's band is honestly derived.

---

## 16. Uncertainty Architecture

Every stage emits `rel_unc ∈ [0, ~0.6]` with a reason. The engine combines them (root-sum-square of independent sources, capped):

```
total_rel_unc = clamp( sqrt( identity_unc² + portion_unc² + source_unc² + prep_unc² + composite_unc² ) + plausibility_penalty , 0.05, 0.6 )
range.kcal    = [ round(kcal * (1 − total_rel_unc)), round(kcal * (1 + total_rel_unc)) ]
range.<macro> = same, with a per-macro floor widening (fat widest, protein narrowest — mirrors foodAI.js's resolveUncertainty spreads)
```

- Every API response (Pipeline A **and** B) now carries a range — currently only Tier 4 does (audit §17).
- No false precision: an `assumed_100g` + `semantic estimate` result shows e.g. "≈ 300 kcal (likely 180–450)", not "300".
- Reasons are surfaced: `["portion assumed (no serving size on record)", "matched a similar food, not an exact record"]`.

---

## 17. LLM / ML Architecture — the escalation ladder

| Tier | Name | Deterministic? | Cost | Runs when | Produces |
|---|---|---|---|---|---|
| **T0** | Normalise + Segment + Classify (rules) | yes | ~0 | always | fragments, classification |
| **T1** | Lexical retrieval + rank (L0–L1) | yes | ~ms | always | ranked candidates + margin |
| **T2** | Structured resolution: strategy A/B/C1–C3, portion, transform, compute, plausibility, uncertainty, confidence | yes | ~ms | always | a full estimate for most queries |
| **T3** | Semantic retrieval (L2) + re-rank; kNN estimate (strategy D) | yes (fitted, offline) | ~ms | `top1_margin < FLOOR` after T1, or plausibility hard-fail | more candidates, or a labelled neighbour estimate |
| **T4** | LLM: query understanding (L3) and/or composite structure (C4) and/or classification tie-break | **no** | ~s, $ | T1–T3 gave nothing above `token_coverage 0.5`, OR composite with no template/recipe | canonical name / `components[]` / class — **never final macros that are used** |
| **T5** | Compute + validate | yes | ~ms | always | the numbers |

Guardrails (mostly already present in `foodAI.js`, generalised):
- LLM output → `validateAIFoodResponse` (weight ≤ 3000 g, kcal ≤ 4000/serving, not all-zero, Atwater) **plus** the new PLAUSIBILITY stage.
- Every LLM-proposed component re-resolved against the DB (`resolveComponents`); mass reconciled (§10).
- LLM cost governor (`ai_provider_cost_state`, cooldown, daily budget) reused unchanged.
- LLM result cached (`ai_food_estimates`) unchanged; **never** written to the measured DB or ML training set.
- ML ranker (T3 Phase-2) is a *ranking* model — it reorders candidates, it does not emit nutrition.

**Where each is genuinely useful:**
- **Deterministic** — identity for common foods, all portion math, all nutrition math, all validation. ~90 % of the work.
- **ML (semantic + learned rank)** — disambiguating near-ties, retrieving foods whose name shares no tokens with any row, ranking the long tail. Not numbers.
- **LLM** — *structure* of an unseen composite dish, canonicalising a messy/transliterated/natural-language phrase, classifying an ambiguous name. Rare, bounded, never authoritative on numbers.
- **Better data (overlays + corpus)** — the real fix for coverage gaps; see §28. Cheaper and more reliable than either model for the cases that matter most.

---

## 18. Database Architecture

**Do not add a new primary database.** The 21k JSON corpus + in-memory index is adequate for the row count.

| Layer | Storage | Build | Loaded |
|---|---|---|---|
| Primary rows | `unified_food_db.json` (unchanged) | ML ingestion (unchanged) | lazy singleton (as today) |
| Derived metadata | `food_metadata.json` (new) | offline `build_food_metadata` (Python or JS), reproducible | merged into the index at build |
| Semantic index | `food_embedding_index.json` (new; or extend `fallback_v4_index.json`) | offline, reuse `fallbackKnn` vectoriser | lazy singleton |
| Curated overlays | `ml/data/overlays/*.json` (new) | hand-maintained, PR-reviewed, benchmark-gated | lazy singleton, hot-reload in dev |
| Barcode | `off_barcode_index.json` (unchanged) | unchanged | unchanged |

- Retire the SQLite `foods`-table search path for estimation (Pipeline C) — keep the `foods` table only for user-owned custom foods + barcode cache + materialised picks (its real jobs).
- Optional later: promote the derived index to SQLite/pg tables (`food_meta`, `food_alias`, `food_component`, `plausibility_range`) for query flexibility and multi-instance consistency — **only if** profiling shows the in-memory build is a cold-start problem on serverless. Not in the initial plan.
- `meal_logs` gains `source_id`, `grams`, `grams_basis`, `confidence`, `range_kcal_lo/hi` (guarded migration) so estimates are auditable post-hoc (audit P2-15).

---

## 19. API Architecture

**One canonical core:** `backend/src/services/food/` —

| Export | Replaces | Callers |
|---|---|---|
| `estimateMeal(text, ctx)` | `estimateFood` | `POST /nutrition/…/meals/ai-estimate`; `/intel/parse-food` (migrated) |
| `resolveFood(query, ctx)` → ranked candidates + evidence | `searchFoods` / `intelligence/foodSearch.resolveFood` | `GET /me/foods/search`; `/intel/*` (migrated); `intelligence.js /foods/model-search` |
| `priceFood(foodRef, portion, ctx)` → nutrition + range | `resolveFoodQuantity` | `POST /me/foods/resolve` |
| `estimateFromBarcode` | unchanged | unchanged |
| internal stages: `normalize`, `segment`, `classify`, `retrieve`, `rank`, `selectStrategy`, `resolvePortion`, `transform`, `compute`, `checkPlausibility`, `composeConfidence` | — | unit-tested individually |

- **Schema:** additive `food-v2` — every `food-v1` field kept; new fields (`range`, `alternatives[]`, `assumptions[]`, `strategy`, richer `provenance`, `classification`) added. Frontend can adopt incrementally; the `ml/docs/CONTRACT` doc gets a `food-v2` section.
- **Route behaviour unchanged externally** in Phase 1 (pure refactor behind the same responses); new fields appear as later phases land, behind a per-route `engine=v2` flag until the benchmark clears them.
- Delete `backend/src/services/skos-food/foodEstimate.reference.cjs` and point `skos-food/index.js` at the canonical engine (audit P1-8).
- `foodAI.js` becomes the T4 adapter *inside* the engine, not a parallel entry point; `me.js`'s "Estimate with AI" still calls it, now via `estimateMeal(text, {force_tier: 4})` or a thin wrapper.

---

## 20. Performance Architecture

| Concern | Approach |
|---|---|
| Cold start | index + metadata + overlays + embeddings built once per process, lazy, cached for lifetime (as today's `FoodSearch`). Target first-call < 600 ms, warm call < 15 ms for T1–T2. |
| Escalation cost | `MARGIN_FLOOR` tuned so ≥ 85 % of queries never touch L2, < 5 % touch T4. Instrument `tier_used` per request. |
| Semantic index size | sparse TF-IDF (proven in `fallbackKnn`, ~MB) or 64–128-dim quantised dense; built offline, no runtime model. |
| LLM latency/cost | existing cost governor (cooldown, daily budget, provider failover) + cache; T4 is opt-in on Pipeline B, auto only on Pipeline A low-margin composites. Hard timeout (`FOOD_AI_TIMEOUT_MS`). |
| Serverless multi-instance | index is per-instance and read-only (fine); cost state and cache are DB-backed (already). |
| Batch (`estimateMeal` with N fragments) | fragments resolved in parallel; shared index; no N+1. |
| Budget | p50 < 25 ms, p95 < 400 ms (no LLM), p95 < 6 s (with LLM). Enforced by a latency test in CI. |

---

## 21. Testing Architecture

Three tiers of tests, all gating CI:

1. **Stage unit tests** — each pipeline stage (`classify`, `retrieve`, `rank`, `resolvePortion`, `transform`, `compute`, `checkPlausibility`, `composeConfidence`) tested in isolation with fixtures. Deterministic core → golden-file parity (like the existing `fallbackKnn.parity.test.js`).
2. **Regression suite** — categories **A–Q** (from the prompt), ~10–20 cases each, asserting **bounds not exact numbers**:

| Cat | Class | Example assertions (bounds) |
|---|---|---|
| A | single ingredients | `100g paneer` → 280–330 kcal; `1 medium apple` → 140–200 g, 70–120 kcal |
| B | prepared foods | `1 masala dosa` → 300–500 kcal; `1 slice pizza` → 200–350 kcal |
| C | raw/cooked variants | `100g cooked rice` < `100g raw rice`; `100g boiled potato` < `100g fried potato` |
| D | fried foods | `2 samosa` → 250–450 kcal (never 0, never > 700); `100g fries` → 250–380 kcal |
| E | composite dishes | `1 plate papdi chaat` → 250–550 kcal, carb 30–70 g; `1 bowl bibimbap` → 450–750 kcal |
| F | meals | `2 roti, dal and curd` → 350–600 kcal, 3 items, none 0 |
| G | branded products | `Amul Taaza 200ml` → picks a branded row; `Lay's Classic 52g` → 260–320 kcal |
| H | generic products | bare `milk` / `bread` / `yogurt` → generic row, not a brand |
| I | ambiguous foods | `egg` → whole egg 60–90 kcal/piece, never a yolk-only row; `dal` → a cooked lentil dish 100–180 kcal/100 g |
| J | international | `100g hummus` 150–200 kcal; `1 bowl pho` 350–550 kcal; `1 taco` 150–250 kcal |
| K | Indian/regional | `1 katori rajma` → 150–260 kcal; `poha` → 150–350 kcal/serving |
| L | portions | `1 tbsp` any oil → 12–15 g (typed **and** chip agree); `1 bowl dal` 200–320 g |
| M | explicit weights | `250g X` → grams exactly 250; explicit mass never overridden |
| N | natural language | `"I had two rotis with dal and some curd"` → 3 items |
| O | multi-food | `"3 eggs, 2 bananas and a glass of milk"` → 3 items, correct counts |
| P | malformed | `""`, `null`, `"quantum flux capacitor"`, `"-5 g rice"` → no crash, no fabricated number |
| Q | low-confidence | out-of-corpus dish → labelled estimate + range, or `unresolved`, **never** a confident wrong number |

3. **Benchmark run** (§22) — not pass/fail per case; aggregate metrics with regression thresholds.

Every phase's PR must keep 1 & 2 green and not regress 3.

---

## 22. Benchmark Architecture

`ml/data/benchmark/food_eval_set.json` — **300–500 labelled items**, stratified:

- **Cuisine:** Indian, South/East Asian, Middle Eastern, European, American, Latin American, African, Mediterranean (≥ 25 each).
- **Class:** ingredient / prepared / composite / branded / beverage / meal.
- **Prep state:** raw / boiled / steamed / grilled / roasted / baked / fried / cooked-wet.
- **Portion type:** explicit grams / count / household / vague.

Each item: `{ input_text, reference: { grams, kcal, protein_g, carb_g, fat_g, food_class, is_composite }, source_of_truth }` — references from IFCT/USDA ground truth, authoritative recipe databases, and published restaurant data.

**Metrics** (runner: `backend/test/foodBenchmark.test.js` or a script emitting JSON):

| Metric | Definition | Initial target |
|---|---|---|
| Identity accuracy | top-1 `food_class` + head-noun correct | ≥ 80 % |
| Portion MAPE | median `|grams − ref| / ref` | ≤ 20 % |
| Calorie MAPE | median `|kcal − ref| / ref` | ≤ 25 % (matches CONTRACT's Tier-1 measured figure) |
| Macro MAPE | median over P/C/F | ≤ 30 % |
| Composite decomposition accuracy | for `is_composite`: total within 25 % of ref | ≥ 60 % |
| Confidence calibration (ECE) | binned confidence vs actual accuracy | ≤ 0.1 |
| False-confident rate | `confidence ∈ {high,medium}` **and** kcal error > 50 % | ≤ 5 % |
| Unresolved rate | fragments returning no estimate | ≤ 15 % |
| Silent-zero rate | items dropped from a total with no `unresolved` entry | **0 %** |
| LLM-call rate | fraction of queries reaching T4 | ≤ 5 % |
| Latency p50 / p95 (no LLM) | | ≤ 25 ms / ≤ 400 ms |

Baseline the **current** engine on this set first (so every phase is measured against a real "before").

---

## 23. Migration Strategy — strangler fig

1. **Phase 1** builds `food/` as a behaviour-identical refactor: `estimateMeal`/`resolveFood`/`priceFood` wrap the *existing* logic, all current tests stay green. No user-visible change.
2. Each later phase adds a stage **behind a flag** (`FOOD_ENGINE_V2` env, or per-route `?engine=v2`, default off). The route runs v1; v2 runs in **shadow mode** on a sampled % of real traffic, logging `{input, v1_result, v2_result, diff}` — no user impact.
3. Weekly: review the shadow diff + run the benchmark. A phase's flag flips to default-on for a route **only when** v2 ≥ v1 on identity accuracy, calorie MAPE, and false-confident rate on the benchmark, **and** the shadow diff shows no regression class.
4. Route cutover order: `POST /nutrition/…/meals/ai-estimate` first (no live UI — safest), then `/me/foods/*`, then `/intel/*` (or retire `AskSK`'s food path).
5. v1 code stays in the tree until v2 has been default-on and clean for a defined bake period.

---

## 24. Rollback Strategy

| Change type | Rollback |
|---|---|
| Engine stage behind a flag | flip `FOOD_ENGINE_V2` / per-route flag to `off` — instant, no deploy if env-driven |
| Overlay JSON (`alias_overlay`, `composite_map`, `category_plausibility`, …) | revert the file / stop loading it — additive, zero code impact |
| Derived index (`food_metadata`, embeddings) | engine falls back to computing `_head`/`_penalty` inline as today if the artifact is absent (same "degrade gracefully" contract as `getFoodSearch`) |
| `meal_logs` migration | new columns are nullable & additive; old writers keep working; a down-migration drops them |
| Ranker swap (linear → learned) | config points back to the linear scorer; feature vector unchanged |
| `.cjs` deletion | git revert; but Phase 1 first proves `skos-food/index.js` works on the canonical engine |

No phase is irreversible. No phase deletes a live path before its replacement wins the benchmark.

---

## 25. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Plausibility ranges too tight → good estimates rejected | med | med | `soft_fail` (widen+downgrade) is the default; `hard_fail` only at ≥ 25 % out-of-band; ranges tuned on the benchmark, not guessed |
| Composite decomposition worse than a single-row guess for some dishes | med | med | C1 (pre-composited row) always tried first; decomposition gated on `is_composite` + no good row; mass-reconciliation invariant; benchmark cat E as the gate |
| LLM cost/latency creep | med | med | strict `MARGIN_FLOOR` escalation gate; existing cost governor + cache; `tier_used` telemetry with an alarm on LLM-rate > target |
| Overlays become an unmaintained pile of special-cases | med | med | overlays are *class-covering data* with a size budget; every entry PR-reviewed against "does this help a class?"; benchmark is the acceptance test |
| Refactor regresses the strong Western-single-food case (~7.5/10) | low | high | Phase 1 is behaviour-identical with all existing tests as the gate; regression suite cat A/G/H/L/M |
| Embedding index build cost on serverless cold start | low | med | offline-built artifact loaded like today's index; sparse TF-IDF keeps it small; profile before dense |
| `classify` misroutes (calls a simple food "composite") | med | med | rules abstain → treat as `ingredient` (safe default); decomposition also gated on a good template/row existing; benchmark cat A/E |
| Two engines diverge again during the multi-phase migration | med | med | one canonical module from Phase 1; `.cjs` deleted in Phase 1; CI test asserts no second `FoodSearch` definition |
| Un-quarantining frying-bath rows reintroduces double-counted oil | low | high | strictly optional, benchmark-gated; anti-double-count guard; only ships if it beats "drop + fallback" on cat D |
| Scope creep / over-engineering | high | med | P-10 phase gates; each layer must move a benchmark metric or it's cut |

---

## 26. Prioritisation

Ranked by **expected impact across the whole food-estimation domain**, not by how visible any single bug is.

### P0 — fundamental correctness
1. **Category-aware plausibility gate** (§14) on `estimateMeal`/`priceFood`. Stops the entire "confident wrong number" class (any wrong-class match). *The one addition that would have caught the papdi-chaat number.*
2. **Composite handling** (§10): `classify` + `composite_map` + route the existing `CompositionalCalculator`, with pre-composited-row check first and mass reconciliation. Stops the "half a dish" and "packaged snack for a dish" classes.
3. **Branded vs generic disambiguation** (§13 context-weighted source pref + §7 namespace feature). Stops branded OFF rows winning dish/ingredient queries without globally suppressing OFF.
4. **Quarantine fallback** (§4 Strategy F, §12 optional correction). Turns silent-0 into a labelled estimate — never drop food from a total unseen.
5. **Canonical core + delete `.cjs` + fix the contains-pass trust leak** (§19; audit P1-8, P1-9).

### P1 — major accuracy
6. Curated **overlays**: `alias_overlay`, `composite_map`, `portion_overlay` (§5.2). Highest accuracy-per-effort — the engine is largely fine, the *coverage* is thin.
7. **Prep-state normalisation + prep-compatible ranking + transform model** (§9, §12).
8. **Feature-based ranker** with `top1_margin`, non-length tie-break (§7 Phase 1).
9. **Evidence-composed confidence + uncertainty ranges on every path** (§15, §16).
10. **Unified portion/volume table + portion uncertainty** (§8).
11. **Persist provenance to `meal_logs`** (§18).

### P2 — important robustness
12. **Semantic retrieval as a candidate generator** (§6 L2 role change).
13. **Data-quality pass**: dedup, Atwater flags, `serving_grams` fill, `cooking_state` normalise, honour `per_100g_unreliable` (§13).
14. **Benchmark dataset + calibration harness** (§22) — the measurement backbone; do early enough to gate later phases.
15. **Migrate `/intel/*` to the core** or retire `AskSK`'s food path (§19).

### P3 — optimisation
16. Learned pairwise ranker trained on the benchmark (§7 Phase 2).
17. LLM escalation tuning, cache warming, `MARGIN_FLOOR` calibration.
18. Latency profiling & p95 budget enforcement in CI.

### P4 — future enhancement (architecture-compatible, not built)
19. Image-based estimation (a new `classify`/`retrieve` front-end feeding the same T2–T5).
20. Personalised portion learning (per-user `portion_overlay` from `meal_logs` history).
21. Menu/restaurant estimation, recipe import, multilingual input, feedback-learning loop (`ai_food_feedback` already exists as a hook).

---

## 27. Implementation Plan

Each phase: behind a flag, benchmark-run before/after, existing + regression tests green. `ctx` = the request context object threaded through.

### Phase 1 — Foundational (behaviour-preserving)
- **Files:** new `backend/src/services/food/{engine.js,index.js,types.js}`; `backend/src/routes/nutrition.js`, `me.js` (call the wrapper); `backend/src/services/skos-food/index.js` (point at canonical engine); **delete** `backend/src/services/skos-food/foodEstimate.reference.cjs`; `backend/src/services/foodEstimator.js:531` (contains-pass: run the trust/confidence mapping); `database/schema.sql` + `backend/scripts/init-db.js` (guarded migration: `meal_logs.source_id, grams, grams_basis, confidence, range_kcal_lo, range_kcal_hi`).
- **Functions:** `estimateMeal`, `resolveFood`, `priceFood` wrap `estimateFood`/`searchFoods`/`resolveFoodQuantity` **unchanged**; extract `normalize`, `segment`, `parseFragment` into `food/` as-is.
- **DB:** additive nullable columns only.
- **Tests:** all existing green (parity); new "no second `FoodSearch` definition" lint test; contains-pass leak regression.
- **Benefit:** one core, one engine copy, provenance persisted, the trust leak closed.
- **Risk:** low (no behaviour change). **Dependencies:** none.

### Phase 2 — Plausibility + quarantine fallback  *(P0-1, P0-4)*
- **Files:** new `ml/data/overlays/category_plausibility.json`; new `backend/src/services/food/plausibility.js`; `food/engine.js` (wire post-COMPUTE); Strategy F/G in `engine.js` (on trust-gate drop → `estimateFoodKnn` + disclaimer, never 0).
- **Functions:** `checkPlausibility(result, classification)`; `selectStrategy` gains F (rescue) and G (unresolved-not-zero).
- **DB:** none. **Deps:** Phase 1.
- **Tests:** regression cat E, P, Q; a broad "confident wrong number" sweep over out-of-corpus dishes; "silent-zero rate = 0" benchmark metric.
- **Benefit:** kills the P0 confident-wrong and silent-0 classes. **Risk:** range tuning — mitigated by `soft_fail` default + benchmark tuning.

### Phase 3 — Classification + composite routing  *(P0-2)*
- **Files:** new `food/classify.js`; new `ml/data/overlays/composite_map.json` (~200 dishes across cuisines, seeded from `indb_dishes.json` + curation); new `food/decompose.js`; wire existing `ml/models/skos-food-v1/compositional.reference.js` `CompositionalCalculator` as the summation engine; `food/engine.js` (Strategy C1–C4).
- **Functions:** `classifyFood(fragment, ctx)`; `decompose(dish, totalGrams, ctx)` with mass-reconciliation invariant; `selectStrategy` C-branch.
- **DB:** none (overlay). **Deps:** Phase 1, 2.
- **Tests:** cat E, F; "don't decompose a simple food" (A); mass-reconciliation invariant; benchmark composite-decomposition-accuracy.
- **Benefit:** P0 composite class. **Risk:** misrouting → safe `ingredient` default; C1 (good row) always tried first.

### Phase 4 — Food ontology / derived index  *(P1-6 enabler)*
- **Files:** new `ml/src/inference/build_food_metadata.py` (or `.js`); new `ml/data/processed/food_metadata.json`; `food/index.js` (merge metadata into the singleton); `food/ranking.js`, `food/portion.js` consume it.
- **Functions:** offline builder emitting `food_class`, normalised `prep_state`, `namespace`, `head_noun`, `quality_profile`.
- **DB:** none (artifact). **Deps:** Phase 1.
- **Tests:** builder unit tests; coverage stats (`% rows classified`, `% prep_state ≠ unspecified`); "engine works with artifact absent" (degrade path).
- **Benefit:** unblocks 5, 6, 7. **Risk:** classification accuracy — allow `unspecified`, measure.

### Phase 5 — Portion architecture  *(P1-10)*
- **Files:** `food/portion.js` (refactor `resolveGrams` + `portionToGrams` into one precedence chain, one volume table); new `ml/data/overlays/portion_overlay.json`; remove the `ML_PER_UNIT` vs `VOLUME_PORTIONS` split.
- **Functions:** `resolvePortion(fragment, food, classification) → {grams, basis, rel_unc}`.
- **DB:** none. **Deps:** Phase 4.
- **Tests:** cat L, M; "typed tbsp == chip tbsp"; explicit-mass-never-overridden; portion MAPE on benchmark.
- **Benefit:** P1 gram accuracy + portion uncertainty into confidence. **Risk:** low.

### Phase 6 — Preparation state + cooking transforms  *(P1-7)*
- **Files:** `food/classify.js` (prep_intent inference + modifier lexicon); `food/ranking.js` (prep_compatible feature); new `food/transform.js`; new `ml/data/overlays/transform_model.json`; `food/engine.js` (Strategy B + TRANSFORM stage).
- **Functions:** `inferPrepState`, `transform(row, from, to, class)`; Strategy B (sibling-row selection).
- **DB:** none. **Deps:** Phase 4, 5.
- **Tests:** cat C, D; anti-double-count guards; "cooked < raw" invariants; benchmark cat C/D MAPE.
- **Benefit:** P1 fried/cooked accuracy; makes the quarantine correction (optional) possible.
- **Risk:** transform multipliers wrong → wide `rel_unc`, benchmark-gated; guard prevents double-count.

### Phase 7 — Confidence + uncertainty  *(P1-9)*
- **Files:** new `food/confidence.js`, `food/uncertainty.js`; every stage emits `(value, rel_unc, reason)`; API responses gain `range`, `assumptions`, `alternatives` (`food-v2`, additive); `ml/docs/CONTRACT_skos-food-v1.md` → add `food-v2` section.
- **Functions:** `composeConfidence(inputs)`, `combineUncertainty(stageUncs)`.
- **DB:** `meal_logs.range_kcal_lo/hi` already added in Phase 1. **Deps:** Phases 2–6.
- **Tests:** cat Q; calibration harness (ECE); "grams-assumed caps confidence at medium".
- **Benefit:** P1 trust; honest ranges everywhere. **Risk:** low (additive).

### Phase 8 — Semantic retrieval as candidate generator  *(P2-12)*
- **Files:** new `ml/data/processed/food_embedding_index.json` (offline; reuse `fallbackKnn` vectoriser) or extend `fallback_v4_index.json`; `food/retrieval.js` (L2 layer → candidates, not answers); `food/ranking.js` (semantic_sim feature).
- **Functions:** `retrieveSemantic(phrase, K)`; `selectStrategy` uses L2 pool when `top1_margin < FLOOR`.
- **DB:** none (artifact). **Deps:** Phase 4, 7.
- **Tests:** cat I, J; "token-less match" cases (e.g. `"cottage cheese" → paneer` without an alias); benchmark identity accuracy delta.
- **Benefit:** P2 long-tail + ambiguity accuracy. **Risk:** index size — sparse first.

### Phase 9 — Benchmark + data-quality pass  *(P2-13, P2-14)*
- **Files:** new `ml/data/benchmark/food_eval_set.json` (300–500 items); new `backend/test/foodBenchmark.test.js` (or a script) emitting the §22 metrics JSON; `ml/src/inference/data_quality_pass.py` (dedup clusters, Atwater flags, `cooking_state` normalise, `serving_grams` fill) writing back into `food_metadata.json`; a data-quality report artifact.
- **DB:** none. **Deps:** Phases 4–8 (so v2 can be measured).
- **Tests:** the benchmark itself becomes a CI gate with regression thresholds; calibration report.
- **Benefit:** the measurement backbone; identifies the real corpus gaps (§28). **Risk:** reference-data effort — start at 300, grow.

### Phase 10 — Production hardening + cutover  *(P2-15, P3)*
- **Files:** `backend/src/routes/{nutrition,me,intelligence}.js` (flag → default-on per route as benchmarks clear); shadow-diff logger; `AskSK.jsx` / `/intel/parse-food` (migrate to `estimateMeal` or retire the food path); malformed-input fuzz test; latency budget test in CI; `MARGIN_FLOOR` calibration from benchmark.
- **DB:** none. **Deps:** all.
- **Tests:** cat P (fuzz), latency p95, "one engine only" lint, end-to-end shadow parity report.
- **Benefit:** P3 + single-source-of-truth; Pipeline C gone. **Risk:** cutover — mitigated by the shadow period and instant flag rollback.

---

## 28. What stays / improves / redesigned / removed / introduced

| | Item |
|---|---|
| **Stays (do not touch)** | The "never fabricate" contract (`unresolved`, `null`→`—`, fuzzy capped `low`); `parseFragment`/`parseQuantity`/`segment` parsing; `scaleNutrition`'s `× g/100` + null-safety + rounding; food-specific portion sizing concept; Tier-4 honesty machinery (ranges, component grounding, backend-derived confidence, "never write AI numbers to the DB", cost governor); IFCT/INDB byte-fidelity + `indianFoodAuthoritative.test.js`; `adjustOil`'s delta-from-baseline mass-conserving *design*. |
| **Improves (evolve in place)** | `FoodSearch.score` → feature-based `rank` with `top1_margin`, non-length tie-break; `food_aliases.json` ← `alias_overlay` corrections; `cooking_state` ± 70 nudge → normalised `prep_state` + compatibility feature + transforms; portion precedence → one table + `rel_unc`; confidence → evidence composition; `adjustOil` baseline `fat_g` → `transform_model` oil table; source preference `−rank×4` → context-weighted. |
| **Redesigned** | The top-level flow: monolithic `estimateFood` → the T0–T5 staged pipeline with a classifier and strategy router; confidence; the retrieval role of the embedding index (last-resort answer → candidate generator). |
| **Removed** | `backend/src/services/skos-food/foodEstimate.reference.cjs` (stale, corrupted); the SQLite-`foods`-table estimation path in `intelligence/{parseFoods,foodSearch,nutrition,units}.js` (migrated to the core; the `foods` table keeps its custom-food/barcode/materialisation jobs); the contains-pass trust leak; the dead `per_100g_unreliable` (now honoured). |
| **Introduced** | `classify` stage + food ontology (`food_metadata.json`); curated overlays (`alias_overlay`, `composite_map`, `category_plausibility`, `portion_overlay`, `transform_model`); `plausibility` stage; `uncertainty` + `confidence` composition stages; composite `decompose` on the live path; semantic retrieval as candidate generation; the benchmark dataset + metrics runner; `meal_logs` provenance columns; the `food-v2` (additive) schema. |

---

## 29. Final Quality Bar — how the engine answers the 10 questions

| Question | Stage(s) that answer it | Evidence used |
|---|---|---|
| What is this food? | CLASSIFY + RETRIEVE + RANK | modifier lexicon, DB head-noun, lexical + semantic match, `top1_margin` |
| What preparation/state is it? | CLASSIFY (`prep_intent`) + RANK (`prep_compatible`) + Strategy B | query modifiers, `food_class` default eaten-state, row `prep_state` |
| How much is present? | PORTION | explicit mass > food-specific portion > standard × density > `serving_grams` > category default; `rel_unc` recorded |
| What reliable data represents it? | FILTER + RANK (`quality_profile`, context source pref) | source, completeness, Atwater, region-match, quarantine |
| Single food or a composition? | CLASSIFY (`kind`) + "good pre-composited row?" check | dish token + `components`, combo pattern, LLM tie-break |
| If composition, what components? | DECOMPOSE (C1 row / C2 template / C3 recipe / C4 LLM) | `composite_map`, DB recipe data, LLM structure (re-grounded) |
| How much does each contribute? | DECOMPOSE portioning + COMPUTE per component | `typical_fraction × total_edible_g`, mass reconciliation, per-component DB rows |
| Is the result plausible? | PLAUSIBILITY | `category_plausibility[class][prep_state]` ranges + Atwater + per-serving band |
| How certain are we? | UNCERTAINTY + CONFIDENCE | composed per-stage `rel_unc`, `top1_margin`, coverage, hard flags |
| What if evidence is insufficient? | Strategy D (semantic estimate, labelled) / F (quarantine rescue, disclaimer) / G (`unresolved`, reported) | **never** a silent 0, **never** a confident number without evidence |

Every answer is produced by the appropriate mix of **database evidence** (rows + `quality_profile`), **deterministic rules** (classify, portion, transform, plausibility), **retrieval** (lexical + semantic), **ML** (learned rank, later), **LLM** (structure/canonicalisation only, rare), and **deterministic nutrition calculation** (the sole source of numbers).

---

*End of architecture proposal. No repository file has been modified. Awaiting explicit approval before implementing any phase.*
