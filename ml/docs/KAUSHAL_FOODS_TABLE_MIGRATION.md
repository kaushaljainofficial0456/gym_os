# MIGRATION SPEC — `foods` table for skos-food-v1

**For:** Kaushal (backend + database) · **From:** Sambhav (ML)
**Blocks:** integration of skos-food-v1. This is open item #1 from
`CONTRACT_skos-food-v1.md`.

I have **not** written this migration myself — `database/` is yours. Below is the
exact change set, why each column is needed, and the two traps that would cause
silent wrong numbers if missed.

---

## 0. The two things to read before anything else

### Trap 1 — units. `foods` is per-SERVING; skos-food-v1 is per-100 g.

Today's `foods` rows store nutrition **per whatever `serving` says** (the column
comment reads *"base serving, e.g. 100 g, 200 ml, 1 pc"*, and
`services/intelligence/nutrition.js` scales by `qty / base_qty`).

skos-food-v1 is **always per 100 g**, without exception.

So when loading ML rows you must set:

```sql
serving = '100 g'
```

If you leave `serving` NULL or as something else, `computeNutrition()` will
scale against the wrong base and every number will be wrong by that ratio — a
food loaded with `serving = '1 pc'` would report per-piece values as if they
were per-100 g. **This is the single most likely way to break this integration,
and it fails silently.**

### Trap 2 — column names differ, and one is a false friend

| `foods` column | skos-food-v1 field | Note |
|---|---|---|
| `calories` | `energy_kcal` | same quantity |
| `protein` | `protein_g` | same |
| `carbs` | `carb_g` | same |
| `fat` | `fat_g` | same |
| `fiber` | `fiber_g` | same |
| `sugar` | `sugar_g` | same |
| `sodium` | `sodium_mg` | **both mg — but confirm your existing rows are mg, not g.** Open Food Facts publishes sodium in **grams**; I convert to mg on ingest. If any existing rows are in grams they are 1000× off. |

---

## 1. Columns to add

All **nullable with no default**, so every existing `INSERT INTO foods (...)` in
`routes/intelligence.js:450` and `routes/me.js:208` keeps working untouched.
Nothing below is required by existing code.

```sql
-- ---- identity & provenance ----
ALTER TABLE foods ADD COLUMN source_id      TEXT;     -- 'ifct:L003', 'usda:171287'
ALTER TABLE foods ADD COLUMN source_dataset TEXT;     -- IFCT2017 | USDA_FDC | CNF_CANADA | INDB | OPEN_FOOD_FACTS

-- ---- retrieval quality (contract §3.2) ----
ALTER TABLE foods ADD COLUMN confidence         TEXT; -- high | medium | low | unreliable
ALTER TABLE foods ADD COLUMN data_quality_flag  TEXT; -- non-null => do NOT present the value

-- ---- state (contract §4) ----
ALTER TABLE foods ADD COLUMN cooking_state          TEXT;    -- raw | cooked | ready_to_eat | unspecified
ALTER TABLE foods ADD COLUMN cooking_state_inferred INTEGER; -- 1 => derived from name, not measured

-- ---- portions: users log "1 katori", not "150 g" ----
ALTER TABLE foods ADD COLUMN serving_description TEXT;  -- '1 katori', '1 dosa'
ALTER TABLE foods ADD COLUMN serving_grams       REAL;  -- 150.0

-- ---- micronutrients (all per 100 g; NULL = not measured, never 0) ----
ALTER TABLE foods ADD COLUMN calcium_mg    REAL;
ALTER TABLE foods ADD COLUMN iron_mg       REAL;
ALTER TABLE foods ADD COLUMN potassium_mg  REAL;
ALTER TABLE foods ADD COLUMN magnesium_mg  REAL;
ALTER TABLE foods ADD COLUMN zinc_mg       REAL;
ALTER TABLE foods ADD COLUMN phosphorus_mg REAL;
ALTER TABLE foods ADD COLUMN vitamin_c_mg  REAL;
ALTER TABLE foods ADD COLUMN folate_b9_ug  REAL;
ALTER TABLE foods ADD COLUMN vitamin_e_mg  REAL;

-- ---- fat quality (IFCT Table 12 + Table 7) ----
ALTER TABLE foods ADD COLUMN fa_saturated_mg  REAL;
ALTER TABLE foods ADD COLUMN fa_monounsat_mg  REAL;
ALTER TABLE foods ADD COLUMN fa_polyunsat_mg  REAL;

-- ---- protein quality: leucine drives muscle protein synthesis ----
ALTER TABLE foods ADD COLUMN aa_leucine_mg REAL;
```

Both PostgreSQL and SQLite accept `ALTER TABLE ... ADD COLUMN` with a nullable
column and no default, so this stays portable per the schema header. Run them as
separate statements — SQLite allows only one `ADD COLUMN` per `ALTER`.

## 2. Indexes

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_foods_source_id ON foods(source_id)
  WHERE source_id IS NOT NULL;        -- PostgreSQL partial index
CREATE INDEX IF NOT EXISTS idx_foods_cooking_state ON foods(cooking_state);
```

**`source_id` must be UNIQUE.** It is the identity the app persists against a
user's log; a duplicate silently splits or collides their history. My own test
suite caught 23 duplicates in the ML data (the OFF API pull and bulk export
overlap by barcode) — they are fixed on my side, but the constraint is what
stops it recurring.

SQLite supports partial indexes from 3.8.0. If your SQLite is older, use a plain
unique index and load only rows that have a `source_id`.

## 3. Loading the ML data

Source: `ml/data/processed/unified_food_db.json` on `ml-sambhav`
(**21,353 rows**, 13.9 MB).

```js
// values are per 100 g -> serving MUST be '100 g' (see Trap 1)
{
  id:            nanoid(),
  source_id:     f.source_id,
  source_dataset:f.source,
  name:          f.food_name,
  serving:       '100 g',
  unit:          'g',
  calories:      f.energy_kcal,
  protein:       f.protein_g,
  carbs:         f.carb_g,
  fat:           f.fat_g,
  fiber:         f.fiber_g,
  sugar:         f.sugar_g,
  sodium:        f.sodium_mg,
  brand:         f.brand,
  category:      f.category,
  cuisine:       f.cuisine,
  source:        'VERIFIED_DATABASE',     // existing enum; ML rows are lab-measured
  is_global:     1,
  org_id:        null,
  client_id:     null,
  cooking_state: f.cooking_state,
  serving_description: f.serving_description,
  serving_grams: f.serving_grams,
  confidence:    null,                    // per-QUERY, not per-row — see §4
  data_quality_flag: f.data_quality_flag ?? null,
  // micronutrients copy across 1:1 by name
}
```

**`source: 'VERIFIED_DATABASE'`** — reuse the existing enum rather than adding a
value; these rows are lab-measured national food composition data.

**Idempotency:** upsert on `source_id` so a re-run updates rather than
duplicates.

## 4. `confidence` is per-QUERY, not per-row — do not store it as truth

The column exists so a *resolved* match can be persisted alongside a user's log
entry (i.e. "this entry was matched with low confidence"). But confidence is a
property of **how a query matched**, not of the food itself: `paneer` → Paneer is
high confidence, while a vague query landing on the same row is not.

So: leave it NULL when bulk-loading, and set it only when writing a resolved
match into `meal_items` / `meal_logs`.

Please also **don't re-derive confidence in the backend.** It is calibrated
against the held-out benchmark, and two earlier schemes of mine were measurably
*inverted* — "high" was less accurate than "medium" — before token-overlap fixed
it. `foodEstimate.reference.js` computes it correctly; port from there.

## 5. What I am deliberately NOT asking for

- **No change to existing columns.** No renames, no type changes, no
  backfilling of existing rows. Everything above is additive.
- **No new table.** ML rows are `foods` rows with `is_global = 1`, which the
  scoping in `foodSearch.js` already handles.
- **No FK to anything ML-owned.** The ML side owns no tables.

## 6. Rollback

Every column is nullable and unused by existing code, so rollback is dropping
them:

```sql
ALTER TABLE foods DROP COLUMN source_id;   -- ...and the rest
DROP INDEX IF EXISTS idx_foods_source_id;
DROP INDEX IF EXISTS idx_foods_cooking_state;
```

SQLite gained `DROP COLUMN` in 3.35.0. On older versions the rollback is a table
rebuild — worth checking your version before you run this in an environment you
cannot rebuild.

## 7. Verifying the load

Four checks that catch the failure modes that actually happen:

```sql
-- 1. no duplicate identities
SELECT source_id, COUNT(*) c FROM foods
  WHERE source_id IS NOT NULL GROUP BY source_id HAVING c > 1;   -- expect 0 rows

-- 2. energy is physically possible (pure fat is ~900 kcal/100 g)
SELECT COUNT(*) FROM foods WHERE calories > 902 OR calories < 0; -- expect 0

-- 3. every ML row is on the per-100g basis
SELECT COUNT(*) FROM foods
  WHERE source_id IS NOT NULL AND serving <> '100 g';            -- expect 0

-- 4. sanity: paneer should read ~305 kcal, not 66
SELECT name, calories FROM foods WHERE source_id = 'ifct:L003';
```

Check 4 is not arbitrary — paneer at 66 kcal/100 g is exactly what a units or
parsing bug produces, and it is what my own extractor did before the Atwater
cross-check caught it.

## 8. Questions

If any shape here conflicts with something in the backend I have not seen, tell
me before working around it — I would rather change the artifact than have the
two sides diverge. Contract shapes are versioned (`food-v1`), so a real change
ships as `food-v2` with notice rather than a silent edit.
