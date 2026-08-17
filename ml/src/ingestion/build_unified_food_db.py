"""
Merge IFCT 2017 (Indian) + USDA FDC (global) + Open Food Facts (packaged)
into ONE food database in the shape the app's `foods` table already uses.

SOURCE PRIORITY (deliberate, not arbitrary):
  1. IFCT   -- for Indian foods. Measured on Indian samples across six
               regions. A US-measured "lentil" is a different cultivar
               grown in different soil than an Indian one; for Indian
               foods the Indian measurement is the more accurate value,
               so IFCT wins conflicts even though USDA has more columns.
  2. USDA   -- everything else. Largest verified coverage, public domain,
               and ships separately-measured raw AND cooked entries.
  3. OFF    -- packaged/branded only. Crowd-sourced (weakest provenance),
               so it never overrides a lab-measured generic food; it adds
               brand SKUs the other two structurally cannot have.

UNITS ARE NORMALIZED TO PER-100g, ALWAYS. IFCT publishes per 100g edible
portion, USDA per 100g, OFF per 100g -- so this is a straight carry, not
a conversion. Energy is normalized to kcal (IFCT publishes kJ only;
kcal = kJ / 4.184, the exact definition, not an approximation).

Every output row keeps `source` + `source_id` so any number can be traced
back to the publication it came from. Nothing here is invented: if a
source lacks a nutrient, the field is null rather than estimated.
"""
import json
import re
import unicodedata
from pathlib import Path
from collections import defaultdict

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
OUT_PATH = PROC / "unified_food_db.json"

KJ_PER_KCAL = 4.184  # exact definition

# IFCT food-code letter -> (category, is_indian_specific)
IFCT_GROUPS = {
    "A": "cereals_millets", "B": "pulses_legumes", "C": "vegetables", "D": "roots_tubers",
    "E": "fruits", "F": "nuts_seeds", "G": "condiments_spices", "H": "sugars",
    "I": "sugars", "J": "mushrooms", "K": "beverages", "L": "dairy",
    "M": "eggs", "N": "poultry", "O": "meat", "P": "fish_seafood",
    "Q": "fish_seafood", "R": "fish_seafood", "S": "misc",
}

# Foods where the Indian and Western items are genuinely the same commodity
# and USDA's richer nutrient panel is fine -- vs foods that are culturally
# Indian and must use IFCT. We do NOT try to auto-classify this; the rule is
# simply: an IFCT row always wins for its own food_code, and USDA fills in
# everything IFCT never measured. No heuristic guessing about "Indianness".

STOPWORDS = {"raw", "fresh", "whole", "the", "and", "with", "without", "of", "in"}


def normalize_name(name):
    """Lowercase, strip scientific names in parens, collapse punctuation.
    Used for dedupe + search matching, never for display."""
    n = unicodedata.normalize("NFKD", name or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"\([^)]*\)", " ", n)          # drop "(Lens culinaris)"
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


def search_key(name):
    """Aggressive key for dedupe: normalized, stopwords removed, sorted."""
    toks = [t for t in normalize_name(name).split() if t not in STOPWORDS]
    return " ".join(sorted(toks))


def kj_to_kcal(kj):
    return None if kj is None else round(kj / KJ_PER_KCAL, 1)


def load(path):
    p = PROC / path
    if not p.exists():
        print(f"  [warn] missing {p.name}, skipping")
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def build_ifct():
    """IFCT macros (Table 1) joined with minerals (Table 5), water-soluble
    vitamins (Table 2), and Tables 3/4/6/7/8 (fat-soluble vitamins,
    carotenoids, sugars, fatty acids, amino acids) on food_code."""
    t1 = load("ifct2017_table1_proximate.json")
    t5 = {r["food_code"]: r for r in load("ifct2017_table5_minerals.json")}
    t2 = {r["food_code"]: r for r in load("ifct2017_table2_vitamins.json")}
    # Tables 3,4,6,7,8 -- fat-soluble vitamins, carotenoids, sugars, fatty
    # acids, amino acids. All validated against physical laws before merge
    # (validation/ifct_micronutrient_check.py): fatty acids sum to 0.83 of
    # total fat as the glycerol backbone predicts, free sugars never exceed
    # carbohydrate, and every essential amino acid's share of protein sits
    # in its expected biological band.
    t3 = {r["food_code"]: r for r in load("ifct2017_table3_fat_soluble_vitamins.json")}
    t4 = {r["food_code"]: r for r in load("ifct2017_table4_carotenoids.json")}
    t6 = {r["food_code"]: r for r in load("ifct2017_table6_sugars.json")}
    t7 = {r["food_code"]: r for r in load("ifct2017_table7_fatty_acids.json")}
    t8 = {r["food_code"]: r for r in load("ifct2017_table8_amino_acids.json")}
    EXTRA_TABLES = [
        (t3, ["vitamin_d2_ug", "vitamin_e_mg", "vitamin_k1_ug",
              "tocopherol_alpha_mg", "tocotrienol_alpha_mg"]),
        (t4, ["beta_carotene_ug", "alpha_carotene_ug", "lutein_ug",
              "zeaxanthin_ug", "lycopene_ug", "total_carotenoids_ug"]),
        (t6, ["starch_g", "fructose_g", "glucose_g", "sucrose_g", "maltose_g"]),
        (t7, ["fa_saturated_mg", "fa_monounsat_mg", "fa_polyunsat_mg",
              "fa_c18_2n6_mg", "fa_c18_3n3_mg", "fa_epa_mg", "fa_dha_mg"]),
        (t8, ["aa_leucine_mg", "aa_lysine_mg", "aa_isoleucine_mg",
              "aa_valine_mg", "aa_threonine_mg", "aa_methionine_mg",
              "aa_histidine_mg", "aa_phenylalanine_mg", "aa_tryptophan_mg",
              "aa_leucine_g_per_100g_protein"]),
    ]
    VITAMIN_FIELDS = [
        "thiamine_b1_mg", "riboflavin_b2_mg", "niacin_b3_mg",
        "pantothenic_acid_b5_mg", "vitamin_b6_mg", "biotin_b7_ug",
        "folate_b9_ug", "vitamin_c_mg",
    ]
    out = []
    for r in t1:
        code = r["food_code"]
        m = t5.get(code, {})
        v = t2.get(code, {})
        energy_kcal = kj_to_kcal(r.get("energy_kj"))
        rec = {
            "source": "IFCT2017",
            "source_id": f"ifct:{code}",
            "food_name": r["food_name"],
            "category": IFCT_GROUPS.get(code[0], "misc"),
            "cuisine": "INDIAN",
            "cooking_state": "raw",   # IFCT preface: all data raw except eggs
            "energy_kcal": energy_kcal,
            "protein_g": r.get("protein_g"),
            "fat_g": r.get("fat_g"),
            "carb_g": r.get("carb_by_difference_g"),
            "fiber_g": r.get("fiber_total_g"),
            "sugar_g": None,          # IFCT Table 6, not extracted
            "sodium_mg": m.get("sodium_mg"),
            "calcium_mg": m.get("calcium_mg"),
            "iron_mg": m.get("iron_mg"),
            "potassium_mg": m.get("potassium_mg"),
            "magnesium_mg": m.get("magnesium_mg"),
            "zinc_mg": m.get("zinc_mg"),
            "phosphorus_mg": m.get("phosphorus_mg"),
            "brand": None,
        }
        for vf in VITAMIN_FIELDS:
            rec[vf] = v.get(vf)
        for table, fields in EXTRA_TABLES:
            src = table.get(code, {})
            for f in fields:
                rec[f] = src.get(f)
        if r.get("suspected_source_anomaly"):
            rec["data_quality_flag"] = r["suspected_source_anomaly"]
            rec["energy_kcal"] = None   # refuse to serve a value we believe is wrong
        if r.get("manually_corrected"):
            rec["manually_corrected"] = True
        out.append(rec)
    return out


def build_usda():
    out = []
    for r in load("usda_foods.json"):
        out.append({
            "source": "USDA_FDC",
            "source_id": r["source_id"],
            "food_name": r["food_name"],
            "category": None,
            "cuisine": "GLOBAL",
            "cooking_state": r.get("cooking_state", "unspecified"),
            "energy_kcal": r.get("energy_kcal"),
            "protein_g": r.get("protein_g"),
            "fat_g": r.get("fat_g"),
            "carb_g": r.get("carb_g"),
            "fiber_g": r.get("fiber_g"),
            "sugar_g": r.get("sugar_g"),
            "sodium_mg": r.get("sodium_mg"),
            "calcium_mg": r.get("calcium_mg"),
            "iron_mg": r.get("iron_mg"),
            "potassium_mg": r.get("potassium_mg"),
            "magnesium_mg": None,
            "zinc_mg": None,
            "phosphorus_mg": None,
            "brand": None,
        })
    return out


def build_off_bulk():
    """India products from the OFFICIAL bulk export. The paginated API
    started returning 401/503 mid-pull and only yielded 10 of 226 pages;
    the bulk route gave 1,723 usable India products vs 677 from the API,
    and is the access method Open Food Facts actually asks bulk consumers
    to use. Already normalised to per-100g with mg minerals."""
    out = []
    for r in load("off_india_bulk.json"):
        if r.get("energy_kcal") is None:
            continue
        out.append({
            "source": "OPEN_FOOD_FACTS",
            "source_id": r["source_id"],
            "food_name": (r.get("food_name") or "").strip(),
            "category": (r.get("categories") or "").split(",")[0].strip() or None,
            "cuisine": "PACKAGED",
            "cooking_state": "unspecified",
            "energy_kcal": r.get("energy_kcal"),
            "protein_g": r.get("protein_g"),
            "fat_g": r.get("fat_g"),
            "carb_g": r.get("carb_g"),
            "fiber_g": r.get("fiber_g"),
            "sugar_g": r.get("sugar_g"),
            "sodium_mg": r.get("sodium_mg"),
            "calcium_mg": r.get("calcium_mg"),
            "iron_mg": r.get("iron_mg"),
            "brand": (r.get("brands") or "").split(",")[0].strip() or None,
        })
    return out


def build_off():
    out = []
    for p in load("off_india_products.json"):
        n = p.get("nutriments", {})
        kcal = n.get("energy-kcal_100g")
        if kcal is None:
            continue
        sodium_g = n.get("sodium_100g")
        out.append({
            "source": "OPEN_FOOD_FACTS",
            "source_id": f"off:{p.get('code')}",
            "food_name": (p.get("product_name") or "").strip(),
            "category": (p.get("categories") or "").split(",")[0].strip() or None,
            "cuisine": "PACKAGED",
            "cooking_state": "unspecified",
            "energy_kcal": kcal,
            "protein_g": n.get("proteins_100g"),
            "fat_g": n.get("fat_100g"),
            "carb_g": n.get("carbohydrates_100g"),
            "fiber_g": n.get("fiber_100g"),
            "sugar_g": n.get("sugars_100g"),
            # OFF reports sodium in GRAMS per 100g; app schema uses mg.
            "sodium_mg": None if sodium_g is None else round(sodium_g * 1000, 1),
            "calcium_mg": None,
            "iron_mg": None,
            "potassium_mg": None,
            "magnesium_mg": None,
            "zinc_mg": None,
            "phosphorus_mg": None,
            "brand": (p.get("brands") or "").split(",")[0].strip() or None,
        })
    return out


def build_indb():
    """Indian composite DISHES (masala dosa, biryani, khichdi...). This is
    the layer IFCT structurally cannot provide -- IFCT is raw ingredients
    only, and users log dishes, not ingredients."""
    # Rows where the deep-frying oil BATH was counted as consumed. These
    # pass the Atwater gate (energy and macros are consistently wrong
    # together) but are implausible as food -- "Dum aloo" at 4,576 kcal per
    # serving, dishes at 98-121% of energy from fat. 201 of 1,014 rows.
    # See validation/indb_frying_bath_check.py.
    bath_flags = {}
    for f in load("indb_frying_bath_flags.json"):
        bath_flags[f["source_id"]] = "; ".join(f["reasons"])

    out = []
    for r in load("indb_dishes.json"):
        rec = {
            "source": "INDB",
            "source_id": r["source_id"],
            "food_name": r["food_name"],
            "category": "indian_dish",
            "cuisine": "INDIAN",
            "cooking_state": "cooked",
            "energy_kcal": r.get("energy_kcal"),
            "protein_g": r.get("protein_g"),
            "fat_g": r.get("fat_g"),
            "carb_g": r.get("carb_g"),
            "fiber_g": r.get("fiber_g"),
            "sugar_g": r.get("sugar_g"),
            "sodium_mg": r.get("sodium_mg"),
            "calcium_mg": r.get("calcium_mg"),
            "iron_mg": r.get("iron_mg"),
            "potassium_mg": r.get("potassium_mg"),
            "magnesium_mg": r.get("magnesium_mg"),
            "zinc_mg": r.get("zinc_mg"),
            "phosphorus_mg": r.get("phosphorus_mg"),
            "brand": None,
            "serving_description": r.get("serving_description"),
            "serving_grams": r.get("serving_grams"),
            "serving_energy_kcal": r.get("serving_energy_kcal"),
        }
        if r.get("data_quality_flag"):
            rec["data_quality_flag"] = r["data_quality_flag"]
        if r.get("source_id") in bath_flags:
            existing = rec.get("data_quality_flag")
            msg = "frying-bath contamination: " + bath_flags[r["source_id"]]
            rec["data_quality_flag"] = f"{existing}; {msg}" if existing else msg
        out.append(rec)
    return out


# INDB outranks IFCT for the dishes it covers (a measured assembled dish
# beats summing raw ingredients), and IFCT outranks USDA for Indian
# ingredients (measured on Indian samples). They mostly do not collide:
# INDB is dishes, IFCT is ingredients.
def build_cnf():
    """Canadian Nutrient File -- 5,993 generic foods, Open Government
    Licence. Added because the benchmark showed error concentrates in
    LOW/MEDIUM-confidence matches, and confidence is driven by whether the
    food is present at all. CNF is generic-food-heavy (not brand-heavy),
    which is the shape that converts low-confidence guesses into matches,
    and 99% of its rows carry a household measure ("1 cup", "1 medium")
    with a gram weight -- directly useful, since users log portions."""
    out = []
    for r in load("cnf_foods.json"):
        rec = dict(r)
        rec.setdefault("category", None)
        rec.setdefault("brand", None)
        out.append(rec)
    return out


# CNF sits just below USDA: both are rigorous national lab databases, and
# USDA is larger and already carries the raw/cooked pairs this project
# depends on, so it stays the primary reference for global foods.
SOURCE_RANK = {"INDB": 0, "IFCT2017": 1, "USDA_FDC": 2, "CNF_CANADA": 3,
               "OPEN_FOOD_FACTS": 4}


# Pure fat is ~900 kcal/100 g, so nothing edible exceeds it. Crowd-sourced
# rows occasionally carry unit-entry errors (a muesli at 955 kcal/100 g was
# caught by the test suite, not by inspection).
MAX_PLAUSIBLE_KCAL = 902.0


def sanitize(rec):
    """Final plausibility pass applied to EVERY source, so a per-source
    filter cannot be forgotten -- the 955 kcal muesli slipped in because the
    bulk path capped energy and the API path did not.

    Returns None to drop the row outright, otherwise the cleaned row."""
    e = rec.get("energy_kcal")
    if e is not None and not (0 <= e <= MAX_PLAUSIBLE_KCAL):
        return None

    for field in ("protein_g", "fat_g", "carb_g", "fiber_g", "sugar_g"):
        v = rec.get(field)
        if v is None:
            continue
        if v < 0:
            # "Carbohydrate by difference" is 100 - water - protein - fat -
            # ash, so accumulated rounding can push it a hair below zero
            # (observed: -0.15 g). A small negative is an arithmetic
            # artefact and clamps to 0; a large one means the row is wrong.
            if v > -1.0:
                rec[field] = 0.0
                rec["macro_clamped"] = True
            else:
                return None
    return rec


def merge(records):
    """Dedupe on (search_key, cooking_state). Lower SOURCE_RANK wins.
    Branded items are keyed with their brand so two different brands of
    the same product don't collapse into one row."""
    # source_id must be unique: it is the identity callers persist, and a
    # duplicate silently splits or collides a user's saved log. The OFF API
    # pull and the OFF bulk export overlap by barcode, so the same product
    # can arrive twice -- keep the first (bulk is merged first and is the
    # more complete record).
    seen_ids = set()
    buckets = defaultdict(list)
    for r in records:
        if not r.get("food_name") or r.get("energy_kcal") is None:
            continue
        r = sanitize(r)
        if r is None:
            continue
        sid = r.get("source_id")
        if sid in seen_ids:
            continue
        if sid:
            seen_ids.add(sid)
        key_name = r["food_name"]
        if r.get("brand"):
            key_name = f"{r['brand']} {key_name}"
        buckets[(search_key(key_name), r.get("cooking_state"))].append(r)

    merged, collisions = [], 0
    for _, group in buckets.items():
        group.sort(key=lambda r: SOURCE_RANK.get(r["source"], 9))
        winner = dict(group[0])
        if len(group) > 1:
            collisions += len(group) - 1
            # Fill nulls from lower-priority duplicates rather than discarding
            # data outright -- USDA can legitimately supply a mineral IFCT
            # never measured, without overriding any IFCT value.
            for other in group[1:]:
                for k, v in other.items():
                    if winner.get(k) is None and v is not None and k not in ("source", "source_id"):
                        winner[k] = v
            winner["merged_from"] = [g["source_id"] for g in group[1:]][:5]
        winner["search_name"] = normalize_name(winner["food_name"])
        merged.append(winner)
    return merged, collisions


def main():
    print("Loading sources ...")
    indb, ifct, usda, off = build_indb(), build_ifct(), build_usda(), build_off()
    cnf = build_cnf()
    off_bulk = build_off_bulk()
    print(f"  INDB: {len(indb)}   IFCT: {len(ifct)}   USDA: {len(usda)}   "
          f"CNF: {len(cnf)}   OFF-api: {len(off)}   OFF-bulk: {len(off_bulk)}")

    merged, collisions = merge(indb + ifct + usda + cnf + off_bulk + off)
    merged.sort(key=lambda r: r["food_name"].lower())

    OUT_PATH.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"\nUnified DB: {len(merged)} foods -> {OUT_PATH}")
    print(f"  deduped away: {collisions} duplicate rows")

    by_source, by_state = defaultdict(int), defaultdict(int)
    for r in merged:
        by_source[r["source"]] += 1
        by_state[r.get("cooking_state")] += 1
    print("  by source:", dict(by_source))
    print("  by cooking_state:", dict(by_state))
    complete = sum(1 for r in merged if all(r.get(k) is not None for k in ("protein_g", "fat_g", "carb_g")))
    print(f"  full macro panel (P/F/C): {complete} ({100*complete/len(merged):.1f}%)")


if __name__ == "__main__":
    main()
