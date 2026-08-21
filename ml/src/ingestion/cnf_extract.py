"""
Extract the Canadian Nutrient File (CNF) -- 5,993 foods, Open Government
Licence Canada.

WHY ADD ANOTHER WESTERN DATABASE WHEN THE GOAL IS INDIAN ACCURACY:
The end-to-end benchmark showed error concentrates in MEDIUM and LOW
confidence matches (~48% median APE) while high-confidence matches sit at
25%. Confidence is driven by how completely the query matches a stored
food, so the fix is having the food at all. Every additional generic
whole-food entry is a chance to turn a low-confidence guess into a
high-confidence match -- and CNF is generic-food-heavy rather than
brand-heavy, which is exactly the shape that helps.

CNF also ships `measure_weight_conversion` -- household measures ("1 cup",
"1 medium") mapped to grams. That is the same class of data as INDB's
katori/bowl servings and is directly useful, since users log portions, not
grams.

CNF is relational like USDA FDC: food_name joins to nutrient_amount via
Food_Code, and nutrient identity comes from nutrient_name. Values are per
100 g, matching the rest of this project.
"""
import csv
import json
import re
from pathlib import Path
from collections import defaultdict

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "cnf"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "cnf_foods.json"

# CNF NutrientID -> our field. Verified against nutrient_name.csv rather
# than assumed; CNF uses its own numbering, NOT USDA's.
WANTED_SYMBOLS = {
    "ENERC_KCAL": "energy_kcal",
    "KCAL": "energy_kcal",
    "PROCNT": "protein_g",
    "FAT": "fat_g",
    "FATNLEA": "fat_g",
    "CHOCDF": "carb_g",
    "FIBTG": "fiber_g",
    "SUGAR": "sugar_g",
    "NA": "sodium_mg",
    "CA": "calcium_mg",
    "FE": "iron_mg",
    "K": "potassium_mg",
    "MG": "magnesium_mg",
    "ZN": "zinc_mg",
    "P": "phosphorus_mg",
    "VITC": "vitamin_c_mg",
    "FOL": "folate_b9_ug",
    "THIA": "thiamine_b1_mg",
    "RIBF": "riboflavin_b2_mg",
    "NIA": "niacin_b3_mg",
}

COOKED_RE = re.compile(
    r"\b(cooked|boiled|roasted|baked|fried|grilled|broiled|steamed|braised|"
    r"stewed|toasted|microwaved|poached|canned|prepared|heated)\b", re.I)
RAW_RE = re.compile(r"\braw\b", re.I)


def read(name):
    p = RAW / name
    if not p.exists():
        return []
    with open(p, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def cooking_state(desc):
    if RAW_RE.search(desc or ""):
        return "raw"
    if COOKED_RE.search(desc or ""):
        return "cooked"
    return "unspecified"


def main():
    names = read("food_name.csv")
    nutrients = read("nutrient_name.csv")
    amounts = read("nutrient_amount.csv")
    measures = read("measure_weight_conversion.csv")
    measure_names = {m["Measure_Code"]: m.get("Measure_Description_and_Unit_EN")
                     for m in read("measure_name.csv") if m.get("Measure_Code")}

    # Map NutrientID -> our field via the nutrient SYMBOL, which is stable,
    # rather than via the free-text name.
    # CNF stores the stable INFOODS code in `Tagname` (PROCNT, FIBTG, ...)
    # while `Nutrient_Symbol` holds CNF's own shorthand (PROT). Matching on
    # Tagname keeps this aligned with USDA/IFCT naming.
    field_by_nid = {}
    for n in nutrients:
        nid = n.get("Nutrient_Code")
        tag = (n.get("Tagname") or "").strip().upper()
        sym = (n.get("Nutrient_Symbol") or "").strip().upper()
        unit = (n.get("Nutrient_Unit") or "").strip().lower()
        key = tag if tag in WANTED_SYMBOLS else sym
        if not nid or key not in WANTED_SYMBOLS:
            continue
        field = WANTED_SYMBOLS[key]
        # Guard against picking up a kJ energy row and storing it as kcal --
        # a silent 4.184x error, the same trap FNDDS set in the USDA import.
        # CNF spells the unit "kilocalorie", not "kcal", so match either
        # form; an over-strict check here silently dropped EVERY energy row
        # and produced zero usable foods.
        if field == "energy_kcal":
            u = unit.replace(" ", "")
            if u and not ("kcal" in u or "kilocalorie" in u):
                continue
        field_by_nid[nid] = field

    by_food = defaultdict(dict)
    for a in amounts:
        fid, nid = a.get("Food_Code"), a.get("Nutrient_Code")
        field = field_by_nid.get(nid)
        if not fid or not field:
            continue
        try:
            val = float(a.get("Nutrient_Amount"))
        except (TypeError, ValueError):
            continue
        by_food[fid].setdefault(field, val)

    # household measures -> grams, keep the most "standard-looking" one
    # Measure_Weight_Conversion is the gram weight of that measure for that
    # food -- already grams, NOT a multiplier. Treating it as a factor would
    # inflate every portion 100x.
    serving_by_food = {}
    for m in measures:
        fid = m.get("Food_Code")
        try:
            g = float(m.get("Measure_Weight_Conversion", 0))
        except (TypeError, ValueError):
            continue
        label = measure_names.get(m.get("Measure_Code")) or ""
        if not fid or not label or not (1 <= g <= 2000):
            continue
        cur = serving_by_food.get(fid)
        # prefer a simple "1 cup"/"1 medium" style measure over odd fractions
        rank = 0 if re.match(r"^\s*1\s", label) else 1
        if cur is None or rank < cur[0]:
            serving_by_food[fid] = (rank, label.strip(), round(g, 1))

    out = []
    for f in names:
        fid = f.get("Food_Code")
        desc = (f.get("Food_Description_EN") or "").strip()
        vals = by_food.get(fid)
        if not fid or not desc or not vals or vals.get("energy_kcal") is None:
            continue
        rec = {
            "source": "CNF_CANADA",
            "source_id": f"cnf:{fid}",
            "food_name": desc,
            "category": None,
            "cuisine": "GLOBAL",
            "cooking_state": cooking_state(desc),
            "brand": None,
        }
        rec.update(vals)
        s = serving_by_food.get(fid)
        if s:
            rec["serving_description"] = s[1]
            rec["serving_grams"] = s[2]
        out.append(rec)

    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"CNF foods with energy: {len(out)} -> {OUT_PATH.name}")
    print(f"  with household serving: {sum(1 for r in out if r.get('serving_grams'))}")

    # Same Atwater plausibility gate applied to every other source.
    flagged = 0
    for r in out:
        p, fa, c, e = r.get("protein_g"), r.get("fat_g"), r.get("carb_g"), r.get("energy_kcal")
        if None in (p, fa, c) or not e:
            continue
        est = 4 * p + 9 * fa + 4 * c
        if est >= 20 and not (0.6 <= e / est <= 1.5):
            flagged += 1
    print(f"  Atwater-inconsistent rows: {flagged}")

    states = defaultdict(int)
    for r in out:
        states[r["cooking_state"]] += 1
    print(f"  cooking_state: {dict(states)}")


if __name__ == "__main__":
    main()
