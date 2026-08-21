"""
Extract per-food macros + key minerals from USDA FoodData Central
(SR Legacy + Foundation Foods). Public domain -- no licensing constraint.

FDC ships relational: food.csv (one row per food) joined to
food_nutrient.csv (one row per food x nutrient) via fdc_id. This
pivots that into one flat row per food with named macro columns,
which is the shape the app's `foods` table actually needs.

ENERGY SOURCE PRECEDENCE (matters for accuracy):
  1008 "Energy" KCAL              -- the standard reported value
  2048 "Energy (Atwater Specific)"-- per-food specific factors
  2047 "Energy (Atwater General)" -- general 4/9/4 factors
Prefer 1008; fall back in that order. Never average them -- they are
alternative derivations of the same quantity, not repeat measurements.

RAW vs COOKED: not inferred or converted here. USDA already ships
separately-measured raw and cooked entries as distinct foods (e.g.
"Chicken, breast, raw" and "...roasted"), so cooking state is read
from the description text and carried as a flag. A directly measured
cooked food always beats applying a retention factor to a raw one.
"""
import csv
import json
import re
import sys
from pathlib import Path

RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "usda"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "usda_foods.json"

DATASETS = [
    ("sr_legacy", RAW_DIR / "FoodData_Central_sr_legacy_food_csv_2018-04"),
    ("foundation", RAW_DIR / "FoodData_Central_foundation_food_csv_2026-04-30"),
    # FNDDS/Survey: prepared, composite, as-consumed DISHES (incl. some
    # Indian ones -- Dosa, Biryani, Samosa, Palak Paneer, Naan, Dal).
    # SR Legacy and Foundation are overwhelmingly single ingredients, so
    # without this the DB can price "rice" and "chicken" but not "biryani".
    ("survey_fndds", RAW_DIR / "FoodData_Central_survey_food_csv_2024-10-31"),
]

# nutrient_id -> output field. Verified against nutrient.csv, not guessed.
NUTRIENT_FIELDS = {
    "1003": "protein_g",
    "1004": "fat_g",
    "1005": "carb_g",
    "1079": "fiber_g",
    "2000": "sugar_g",
    "1063": "sugar_g",       # "Sugars, Total NLEA" - same quantity, newer method
    "1093": "sodium_mg",
    "1087": "calcium_mg",
    "1089": "iron_mg",
    "1092": "potassium_mg",
}
ENERGY_PRECEDENCE = ["1008", "2048", "2047"]

COOKED_RE = re.compile(
    r"\b(cooked|boiled|roasted|baked|fried|grilled|broiled|steamed|braised|"
    r"sauteed|saut\xe9ed|stewed|toasted|microwaved|poached|blanched|canned|"
    r"prepared|heated)\b", re.I)
RAW_RE = re.compile(r"\braw\b", re.I)


def read_csv_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def build_nutrient_key_map(base_dir):
    """FDC is not internally consistent about how food_nutrient.csv keys
    nutrients: SR Legacy / Foundation use the internal `nutrient_id`
    (1008 = Energy), while FNDDS/Survey uses the legacy `nutrient_nbr`
    (208 = Energy). Hardcoding either scheme silently drops an entire
    dataset -- that is exactly what happened on the first FNDDS run (all
    5,432 dishes dropped as "no energy value").

    So resolve against each dataset's OWN nutrient.csv and accept both
    keys. Returns (field_by_key, energy_ranks_by_key)."""
    field_by_key, energy_rank = {}, {}
    npath = base_dir / "nutrient.csv"
    if not npath.exists():
        return NUTRIENT_FIELDS, {k: i for i, k in enumerate(ENERGY_PRECEDENCE)}

    for row in read_csv_rows(npath):
        nid = (row.get("id") or "").strip()
        nnbr = (row.get("nutrient_nbr") or "").strip()
        # nutrient_nbr is written as "208" or "208.0" depending on file
        if nnbr.endswith(".0"):
            nnbr = nnbr[:-2]
        keys = {k for k in (nid, nnbr) if k}

        if nid in NUTRIENT_FIELDS:
            for k in keys:
                field_by_key[k] = NUTRIENT_FIELDS[nid]
        if nid in ENERGY_PRECEDENCE:
            rank = ENERGY_PRECEDENCE.index(nid)
            unit = (row.get("unit_name") or "").upper()
            # Only accept KCAL rows as energy. nutrient_nbr 268 is the kJ
            # twin of 208 -- mapping it here would store kJ as if it were
            # kcal, a silent 4.184x error on every affected food.
            if unit == "KCAL":
                for k in keys:
                    energy_rank[k] = rank
    return field_by_key, energy_rank


def cooking_state(description):
    d = description or ""
    if RAW_RE.search(d):
        return "raw"
    if COOKED_RE.search(d):
        return "cooked"
    return "unspecified"


def extract_dataset(label, base_dir):
    food_csv = base_dir / "food.csv"
    fn_csv = base_dir / "food_nutrient.csv"
    if not food_csv.exists() or not fn_csv.exists():
        print(f"  [skip] {label}: missing food.csv/food_nutrient.csv", file=sys.stderr)
        return {}

    # Only keep the actual food entries. Foundation Foods' food.csv also
    # carries sample_food / market_acquisition / sub_sample_food rows, which
    # are sampling provenance records, NOT distinct foods -- including them
    # would multiply-count the same item.
    keep_types = {"sr_legacy_food", "foundation_food", "survey_fndds_food"}
    foods = {}
    for row in read_csv_rows(food_csv):
        if row.get("data_type") not in keep_types:
            continue
        fdc_id = row["fdc_id"]
        desc = (row.get("description") or "").strip()
        foods[fdc_id] = {
            "source_id": f"usda:{fdc_id}",
            "food_name": desc,
            "source": "USDA_FDC",
            "source_dataset": label,
            "cooking_state": cooking_state(desc),
            "basis": "per_100g",
        }

    field_by_key, energy_rank_by_key = build_nutrient_key_map(base_dir)

    energy_seen = {}
    for row in read_csv_rows(fn_csv):
        fdc_id = row.get("fdc_id")
        if fdc_id not in foods:
            continue
        nid = (row.get("nutrient_id") or "").strip()
        if nid.endswith(".0"):
            nid = nid[:-2]
        val = row.get("amount")
        if val in (None, ""):
            continue
        try:
            val = float(val)
        except ValueError:
            continue

        if nid in energy_rank_by_key:
            rank = energy_rank_by_key[nid]
            prev = energy_seen.get(fdc_id)
            if prev is None or rank < prev:
                energy_seen[fdc_id] = rank
                foods[fdc_id]["energy_kcal"] = val
                foods[fdc_id]["energy_source_nutrient_id"] = nid
        elif nid in field_by_key:
            field = field_by_key[nid]
            # 2000 and 1063 both map to sugar_g; keep the first seen rather
            # than letting one silently overwrite the other.
            foods[fdc_id].setdefault(field, val)

    return foods


def main():
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    all_foods = {}
    for label, base in DATASETS:
        print(f"Extracting {label} from {base.name} ...")
        got = extract_dataset(label, base)
        print(f"  {len(got)} foods")
        all_foods.update(got)

    records = [f for f in all_foods.values() if f.get("energy_kcal") is not None]
    dropped = len(all_foods) - len(records)
    OUT_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(f"\nWrote {len(records)} foods -> {OUT_PATH}")
    print(f"Dropped {dropped} with no energy value (unusable for calorie estimation)")

    states = {}
    for r in records:
        states[r["cooking_state"]] = states.get(r["cooking_state"], 0) + 1
    print("cooking_state distribution:", states)


if __name__ == "__main__":
    main()
