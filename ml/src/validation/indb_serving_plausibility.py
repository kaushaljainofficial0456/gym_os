"""
Flag INDB rows whose per-100 g basis is unreliable, using reference piece
weights as an independent check.

THE PROBLEM, MEASURED:
INDB's per-100 g energy disagrees with USDA for the same dish, and it does
so in BOTH directions -- so it is not a fixable offset:

    Plain dosa    INDB 380.9   USDA 210.0   1.81x HIGH
    Chapati/Roti  INDB 202.3   USDA 297.0   0.68x LOW
    Idli          INDB 137.5   USDA 128.0   1.07x  (agrees)

Only ~10 dishes overlap between the two sources, far too few to correct
broadly. But the failure leaves a fingerprint that CAN be checked on every
row, because of how the numbers relate:

    INDB publishes per-serving ENERGY directly (reliable -- a plain dosa at
    138 kcal is right), and publishes per-100 g separately. Serving GRAMS
    are then derived as  serving_kcal / per100g_kcal * 100.

So if per-100 g is inflated, the derived serving mass comes out too SMALL.
Plain dosa derives to 36 g, when a dosa is ~85 g. That is the tell.

THE CHECK:
Compare each derived serving mass against a reference weight for that unit
(a dosa is 60-120 g, an idli 30-60 g, a roti 30-50 g). A derived mass far
outside its reference range means the per-100 g basis is wrong for that
row, even though its per-serving energy is fine.

WHAT IS DONE ABOUT IT:
The row is FLAGGED, not corrected. Correcting would mean choosing a mass
we have not measured. Flagged rows keep their per-serving values -- which
are the trustworthy ones, and the ones users actually log ("1 dosa") --
while their per-100 g basis is marked unreliable so nothing downstream
presents it as firm.
"""
import json
import re
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DISHES = PROC / "indb_dishes.json"
OUT = PROC / "indb_serving_flags.json"

# Reference mass ranges (grams) for one unit of a dish. Deliberately WIDE:
# the aim is to catch a 2-3x error, not to police portion size. Values are
# ordinary published serving weights for Indian foods.
REFERENCE_RANGES = {
    "dosa": (55, 160), "idli": (25, 70), "chapati": (25, 60), "roti": (25, 60),
    "parantha": (45, 150), "paratha": (45, 150), "puri": (12, 50), "poori": (12, 50),
    "samosa": (40, 140), "vada": (25, 100), "pakoda": (12, 70), "pakora": (12, 70),
    "ladoo": (15, 70), "laddu": (15, 70), "tikki": (30, 100), "cutlet": (30, 110),
    "kabab": (25, 110), "kebab": (25, 110), "dhokla": (25, 80), "appam": (35, 110),
    "uttapam": (60, 180), "cheela": (40, 130), "thepla": (30, 90),
    "slice": (18, 90), "piece": (12, 180), "cookie": (8, 60), "biscuit": (6, 40),
    "katori": (90, 260), "bowl": (120, 420), "small bowl": (80, 260),
    "plate": (140, 520), "cup": (110, 280), "glass": (140, 320),
    "tall glass": (180, 420), "tea cup": (80, 220), "soup bowl": (150, 400),
}

# how far outside the range counts as "the basis is wrong", not "a big portion"
TOLERANCE = 1.6


# Units that are CONTAINERS, not servings. "1 glass jar" of chutney is a
# storage jar, and matching it against a drinking-glass range produced the
# worst false positive in the first run (Green chutney, 5.7x).
CONTAINER_UNITS_RE = re.compile(
    "jar|bottle|packet|tin|carton|sachet|pouch", re.I)

# Condiments are eaten in spoonfuls, so a "bowl" of pickle genuinely IS
# small. Applying main-dish ranges to them flags correct data as wrong --
# and the compositional benchmark already showed condiment servings are
# inherently arbitrary (52.4% error vs 25.7% for main dishes), so they are
# excluded here rather than double-penalised.
CONDIMENT_RE = re.compile(
    r"chutney|pickle|achar|masala|jam|dip|sauce|spread|powder|paste|"
    r"seasoning|garnish|topping|dressing", re.I)


def unit_range(unit_text):
    """Longest matching reference unit, so 'small bowl' beats 'bowl'.
    Returns None for container units, which are not serving sizes."""
    u = (unit_text or "").strip().lower()
    if CONTAINER_UNITS_RE.search(u):
        return None
    best, best_len = None, 0
    for key, rng in REFERENCE_RANGES.items():
        pattern = "(?:^|[^a-z])" + re.escape(key) + "(?:[^a-z]|$)"
        if re.search(pattern, u) and len(key) > best_len:
            best, best_len = rng, len(key)
    return best


def main():
    dishes = json.loads(DISHES.read_text(encoding="utf-8"))
    flagged, checked = [], 0

    for d in dishes:
        unit = d.get("serving_description")
        grams = d.get("serving_grams")
        if not unit or not grams:
            continue
        if CONDIMENT_RE.search(d.get("food_name") or ""):
            continue
        rng = unit_range(unit)
        if not rng:
            continue
        checked += 1
        lo, hi = rng[0] / TOLERANCE, rng[1] * TOLERANCE
        if lo <= grams <= hi:
            continue

        direction = "too small" if grams < lo else "too large"
        # implied per-100g error factor: if the true mass is the nearest
        # bound, per-100g is wrong by (derived / true)
        true_ref = rng[0] if grams < lo else rng[1]
        factor = round(true_ref / grams, 2) if grams else None
        flagged.append({
            "source_id": d.get("source_id"),
            "food_name": d.get("food_name"),
            "serving_description": unit,
            "derived_serving_grams": grams,
            "reference_range_g": list(rng),
            "direction": direction,
            "implied_per100g_error_factor": factor,
            "energy_kcal_per_100g": d.get("energy_kcal"),
            "serving_energy_kcal": d.get("serving_energy_kcal"),
            "reason": (
                f"derived serving mass {grams} g is {direction} for '{unit}' "
                f"(reference {rng[0]}-{rng[1]} g). Serving mass is derived from "
                f"the per-100 g basis, so an implausible mass indicates the "
                f"per-100 g value is wrong for this row. Per-SERVING energy "
                f"({d.get('serving_energy_kcal')} kcal) is published directly "
                f"and remains usable."
            ),
        })

    OUT.write_text(json.dumps(flagged, indent=2), encoding="utf-8")
    print(f"rows with a checkable serving unit: {checked}")
    print(f"flagged as implausible per-100g basis: {len(flagged)} "
          f"({100*len(flagged)/max(checked,1):.1f}%)")

    small = [f for f in flagged if f["direction"] == "too small"]
    large = [f for f in flagged if f["direction"] == "too large"]
    print(f"   derived mass too small (per-100g inflated): {len(small)}")
    print(f"   derived mass too large (per-100g deflated): {len(large)}")

    print("\nworst offenders:")
    for f in sorted(flagged, key=lambda x: -(x["implied_per100g_error_factor"] or 0))[:10]:
        print(f"   {f['implied_per100g_error_factor']:5.2f}x  {f['food_name'][:40]:40s} "
              f"1 {f['serving_description'][:12]:12s} = {f['derived_serving_grams']:6.1f}g "
              f"(ref {f['reference_range_g'][0]}-{f['reference_range_g'][1]})")


if __name__ == "__main__":
    main()
