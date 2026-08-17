"""
Oil-level adjustment for skos-food-v1.

THE PRODUCT IDEA, AND WHY IT IS THE RIGHT ONE:
Measured irreducible error for name-only nutrition prediction is ~17%
median (irreducible_error_floor.py), and the dominant driver is cooking
fat -- the same dish name spans ~2x on oil absorption and ~3x on ghee and
cream. That variance is NOT recoverable from the dish name. But it is
trivially recoverable if the user just tells us how much oil they used.
This feature converts the single largest unmeasurable term in the whole
pipeline into a measured input.

THE PREREQUISITE EVERYONE GETS WRONG:
Every published dish value ALREADY contains some oil. Adding the user's
oil on top double-counts it. So adjustment must be a DELTA from the
recipe's own oil content:

    delta_g   = user_oil_g - baseline_oil_g
    delta_kcal = delta_g * 8.84

Baselines come from INDB's own ingredient lists (442 dishes with a usable
figure, extracted by extract_recipe_oil.py), divided by the recipe's
serving count -- not from a guess.

TIER VALUES ARE MEASURED, NOT INVENTED:
Taken from the real distribution across those 442 dishes (g oil per 100 g
of finished dish):

    p10  1.10      -> "low"        2.0
    p25  2.19
    p50  4.56      -> "moderate"   4.5   (the median real Indian dish)
    p75  9.87      -> "high"      10.0
    p90 16.79      -> "very high" 17.0

MASS IS CONSERVED:
Adding 10 g of oil to a dish adds 10 g of mass as well as 88 kcal. Naive
implementations add the calories but not the mass, which silently inflates
per-100g density. Both are updated here.

ENERGY DENSITY: 8.84 kcal/g, from the measured USDA value for cooking oil
(884 kcal/100 g, 100 g fat/100 g). Ghee is 876-900; one figure is used
because the spread is <3%, far below the variance being corrected.
"""
import json
import re
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
OIL_PATH = PROC / "indb_recipe_oil.json"

KCAL_PER_G_OIL = 8.84          # USDA: cooking oil 884 kcal/100 g
DEEP_FRY_MAX_G_PER_100G = 25.0  # above this a "recipe oil" is a frying bath

# Measured percentiles of g oil per 100 g finished dish (n=442 INDB dishes).
OIL_LEVELS = {
    "none":      0.0,
    "low":       2.0,    # ~p25 -- lightly tempered, minimal tadka
    "moderate":  4.5,    # ~median real Indian dish
    "high":     10.0,    # ~p75 -- generous oil, shallow fried
    "very_high": 17.0,   # ~p90 -- deep fried / rich restaurant style
}

# Fallback baselines by dish class, for foods with no recipe-level oil
# figure (USDA/IFCT rows). Derived from the same measured distribution,
# assigned by dish type. Always reported as `estimated`, never as measured.
CLASS_BASELINES = {
    "deep_fried": 12.0,
    "shallow_fried": 7.0,
    "curry_gravy": 5.0,
    "dry_sabzi": 4.0,
    "bread_griddle": 3.0,
    "rice_dish": 3.0,
    "steamed_boiled": 0.5,
    "raw_salad": 0.5,
    "beverage": 0.2,
}
CLASS_PATTERNS = [
    ("deep_fried", r"\b(samosa|pakora|pakoda|vada|puri|poori|bhatura|jalebi|"
                   r"chips|fritter|deep.fried|bhajiya|kachori|medu)\b"),
    ("shallow_fried", r"\b(fried|fry|cutlet|tikki|paratha|parantha|omelet|"
                      r"omelette|pan.fried|shallow|roast(ed)?)\b"),
    ("curry_gravy", r"\b(curry|gravy|masala|korma|kofta|makhani|rogan|"
                    r"vindaloo|jalfrezi|butter\s+chicken|kadhi)\b"),
    ("dry_sabzi", r"\b(sabzi|sabji|subji|bhurji|poriyal|thoran|dry)\b"),
    ("bread_griddle", r"\b(roti|chapati|naan|kulcha|thepla|dosa|uttapam|"
                      r"cheela|appam|pav|bread|toast)\b"),
    ("rice_dish", r"\b(rice|pulao|pilaf|biryani|khichdi|khichri)\b"),
    ("steamed_boiled", r"\b(idli|dhokla|steamed|boiled|momo|sambar|rasam|"
                       r"dal|daal|soup|stew|khichdi)\b"),
    ("raw_salad", r"\b(salad|raita|chutney|sprouts|kachumber|curd|dahi)\b"),
    ("beverage", r"\b(juice|lassi|tea|coffee|sharbat|shake|smoothie|water)\b"),
]
COMPILED = [(k, re.compile(p, re.I)) for k, p in CLASS_PATTERNS]


class OilAdjuster:
    def __init__(self, oil_path=OIL_PATH):
        self.by_code = {}
        p = Path(oil_path)
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            for r in data.get("with_oil", []):
                if r.get("oil_g_per_100g") is None:
                    continue
                if r.get("oil_baseline_unreliable"):
                    continue
                # A recipe whose frying oil is written "for frying" has no
                # number attached, so whatever DID parse is only the small
                # tempering oil -- e.g. pakora parsed to 0.34 g/100g, which
                # would label a deep-fried food as essentially oil-free and
                # make every adjustment from it wrong. Defer to the dish-class
                # estimate in that case rather than trust a partial figure.
                if r.get("deep_fried_unquantified") and r["oil_g_per_100g"] < 5.0:
                    continue
                self.by_code[r["food_code"]] = r
            # recipes with no fat ingredient at all are a genuine zero
            self.zero_oil_codes = set(data.get("no_oil_recipe_codes", []))
        else:
            self.zero_oil_codes = set()

    # ---------- baseline ----------
    def baseline_oil_per_100g(self, food):
        """Oil already present in this food's published numbers.
        Returns (grams_per_100g, provenance)."""
        sid = food.get("source_id") or ""
        if sid.startswith("indb:"):
            code = sid.split(":", 1)[1]
            rec = self.by_code.get(code)
            if rec:
                return rec["oil_g_per_100g"], "recipe_measured"
            if code in self.zero_oil_codes:
                return 0.0, "recipe_no_fat_ingredient"

        name = food.get("food_name") or ""
        for cls, rx in COMPILED:
            if rx.search(name):
                return CLASS_BASELINES[cls], f"class_estimate:{cls}"
        return None, "unknown"

    # ---------- adjustment ----------
    def adjust(self, food, level="moderate", custom_oil_g_per_100g=None,
               portion_g=None):
        """Re-price a food for a different oil level.

        `level` is one of OIL_LEVELS, or "custom" with
        `custom_oil_g_per_100g`. If `portion_g` is given, the custom value
        is interpreted as grams of oil in THAT PORTION, which is how a user
        actually thinks ("I used 2 tsp for this bowl").

        Returns a dict with adjusted values and full provenance. Never
        mutates the input food.
        """
        base_kcal = food.get("energy_kcal")
        if base_kcal is None:
            return {"error": "food has no energy value; cannot adjust"}

        baseline, provenance = self.baseline_oil_per_100g(food)
        if baseline is None:
            return {
                "adjusted": False,
                "reason": (
                    "no oil baseline known for this food, and its dish type is "
                    "unrecognised -- adjusting would mean inventing the starting "
                    "point, so the published value is returned unchanged"
                ),
                "energy_kcal": base_kcal,
                "baseline_provenance": provenance,
            }

        if level == "custom":
            if custom_oil_g_per_100g is None:
                return {"error": "level='custom' requires custom_oil_g_per_100g"}
            target = float(custom_oil_g_per_100g)
            if portion_g:
                # user gave grams for their portion -> convert to per-100g
                target = target / portion_g * 100.0
        else:
            if level not in OIL_LEVELS:
                return {"error": f"unknown oil level '{level}'; "
                                 f"expected one of {sorted(OIL_LEVELS)} or 'custom'"}
            target = OIL_LEVELS[level]

        if target < 0:
            return {"error": "oil quantity cannot be negative"}

        delta_g = target - baseline

        # Mass conservation: the extra oil is extra mass, so per-100g values
        # must be renormalised against the new total, not just incremented.
        new_mass = 100.0 + delta_g
        if new_mass <= 0:
            return {"error": "implied negative food mass; oil baseline is wrong"}

        new_energy_abs = base_kcal + delta_g * KCAL_PER_G_OIL
        if new_energy_abs < 0:
            new_energy_abs = 0.0
        adj_kcal = new_energy_abs / new_mass * 100.0

        out = {
            "adjusted": True,
            "oil_level": level,
            "baseline_oil_g_per_100g": round(baseline, 2),
            "target_oil_g_per_100g": round(target, 2),
            "delta_oil_g_per_100g": round(delta_g, 2),
            "baseline_provenance": provenance,
            "energy_kcal_original": round(base_kcal, 1),
            "energy_kcal_adjusted": round(adj_kcal, 1),
            "energy_delta_pct": round((adj_kcal - base_kcal) / base_kcal * 100, 1)
            if base_kcal else None,
        }

        # fat scales with the oil added/removed, on the same new mass basis
        if food.get("fat_g") is not None:
            new_fat_abs = max(0.0, food["fat_g"] + delta_g)
            out["fat_g_original"] = round(food["fat_g"], 1)
            out["fat_g_adjusted"] = round(new_fat_abs / new_mass * 100.0, 1)

        # protein and carbs are unchanged in absolute terms, but their
        # per-100g concentration shifts because total mass changed
        for k in ("protein_g", "carb_g"):
            if food.get(k) is not None:
                out[k + "_adjusted"] = round(food[k] / new_mass * 100.0, 1)

        if portion_g:
            out["portion_g"] = portion_g
            out["portion_kcal_original"] = round(base_kcal * portion_g / 100.0, 1)
            out["portion_kcal_adjusted"] = round(adj_kcal * portion_g / 100.0, 1)

        if provenance.startswith("class_estimate"):
            out["caveat"] = (
                "baseline oil was estimated from dish type, not read from a "
                "recipe -- the adjustment direction is reliable, the absolute "
                "starting point less so"
            )
        return out


def _demo():
    db = json.loads((PROC / "unified_food_db.json").read_text(encoding="utf-8"))
    by_name = {}
    for f in db:
        by_name.setdefault(f["food_name"], f)
    adj = OilAdjuster()

    print("OIL LEVELS (g per 100 g finished dish, from measured INDB distribution)")
    for k, v in OIL_LEVELS.items():
        print(f"   {k:10s} {v:5.1f} g/100g   ({v * KCAL_PER_G_OIL:5.1f} kcal/100g from oil)")

    probes = ["Potato pakora/pakoda (Aloo pakoda)", "Chickpeas curry (Safed channa curry)",
              "Plain parantha/paratha", "Idli", "Vegetable pulao"]
    for name in probes:
        f = by_name.get(name)
        if not f:
            continue
        base, prov = adj.baseline_oil_per_100g(f)
        print(f"\n{name[:52]}")
        print(f"   published {f['energy_kcal']:.0f} kcal/100g | baseline oil "
              f"{base if base is None else round(base,2)} g/100g ({prov})")
        for lvl in ("low", "moderate", "high", "very_high"):
            r = adj.adjust(f, lvl)
            if r.get("adjusted"):
                print(f"     {lvl:10s} -> {r['energy_kcal_adjusted']:6.1f} kcal/100g "
                      f"({r['energy_delta_pct']:+6.1f}%)")


if __name__ == "__main__":
    _demo()
