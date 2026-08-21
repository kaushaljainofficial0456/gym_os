"""
Detect INDB dishes where the deep-frying OIL BATH was counted as eaten.

WHY THE EXISTING ATWATER CHECK MISSES THIS:
The Atwater gate compares stated energy against stated macros. For these
rows both are consistently wrong together -- "Potato pakora" reports
677 kcal/100g AND 71.8 g fat/100g, which agree perfectly (678 vs 677) yet
describe a food that is 95% fat by energy. Internal consistency is not
plausibility.

WHAT WENT WRONG UPSTREAM:
Recipes that specify frying oil as "for frying" have no measurable
quantity. Where INDB nonetheless folded a full bath quantity into the
nutrient computation, the dish inherits oil that is thrown away after
cooking. Real absorption for battered deep-fried food is roughly 5-15% of
food weight, not the whole bath.

TWO INDEPENDENT PLAUSIBILITY TESTS (a row must fail on its own merits):
  1. FAT ENERGY SHARE -- a fried snack is typically 40-60% fat by energy.
     Above ~80% the item is closer to oil than to food.
  2. SERVING MASS -- "1 pakoda" at 674 g is not a serving anybody eats.
     Derived serving mass is checked against sane bounds for its unit.

Flagged rows are NOT deleted and NOT silently corrected -- there is no
basis to pick a replacement number. They are marked so the search layer
can suppress them and so they never train the tier-3 model.
"""
import json
import re
from pathlib import Path

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DISHES = PROC / "indb_dishes.json"
OUT = PROC / "indb_frying_bath_flags.json"

FAT_ENERGY_SHARE_MAX = 0.80     # above this the row is essentially oil
# Serving-unit sanity bounds (grams). Deliberately generous -- the aim is
# to catch absurdities, not to police portion sizes.
UNIT_MAX_G = {
    "piece": 250, "pieces": 250, "pakoda": 200, "pakora": 200, "samosa": 250,
    "vada": 200, "idli": 150, "dosa": 400, "roti": 120, "chapati": 120,
    "parantha": 250, "paratha": 250, "puri": 120, "poori": 120,
    "ladoo": 120, "laddu": 120, "slice": 200, "cookie": 100, "biscuit": 100,
    "cutlet": 200, "tikki": 200, "kabab": 200, "kebab": 200, "spoon": 60,
    "tablespoon": 60, "teaspoon": 30, "cup": 400, "katori": 400,
    "small bowl": 350, "bowl": 600, "glass": 500, "tall glass": 600,
    "plate": 700, "tea cup": 300,
}

OIL_FOOD_RE = re.compile(r"\b(oil|ghee|butter|vanaspati|margarine|mayonnaise|"
                         r"dressing|fat)\b", re.I)


def main():
    dishes = json.loads(DISHES.read_text(encoding="utf-8"))
    flagged = []

    for d in dishes:
        name = d.get("food_name") or ""
        kcal = d.get("energy_kcal")
        fat = d.get("fat_g")
        serving_g = d.get("serving_grams")
        unit = (d.get("serving_description") or "").strip().lower()
        reasons = []

        # 1) fat energy share -- skip foods that ARE fats
        if kcal and fat is not None and kcal > 0 and not OIL_FOOD_RE.search(name):
            share = (9.0 * fat) / kcal
            if share > FAT_ENERGY_SHARE_MAX:
                reasons.append(
                    f"{share*100:.0f}% of energy is fat ({fat:.1f} g/100 g) -- "
                    "implies the frying bath was counted as consumed"
                )

        # 2) serving mass sanity
        if serving_g and unit:
            cap = None
            for k, v in UNIT_MAX_G.items():
                if k in unit:
                    cap = v if cap is None else min(cap, v)
            if cap and serving_g > cap:
                reasons.append(
                    f"1 {unit} derived as {serving_g:.0f} g, above a sane "
                    f"maximum of {cap} g for that unit"
                )

        if reasons:
            flagged.append({
                "source_id": d.get("source_id"),
                "food_name": name,
                "energy_kcal_per_100g": kcal,
                "fat_g_per_100g": fat,
                "serving_description": d.get("serving_description"),
                "serving_grams": serving_g,
                "serving_energy_kcal": d.get("serving_energy_kcal"),
                "reasons": reasons,
            })

    OUT.write_text(json.dumps(flagged, indent=2), encoding="utf-8")
    print(f"INDB dishes: {len(dishes)}")
    print(f"Flagged as frying-bath / implausible serving: {len(flagged)} "
          f"({100*len(flagged)/len(dishes):.1f}%)")

    fat_only = [f for f in flagged if any("energy is fat" in r for r in f["reasons"])]
    serv_only = [f for f in flagged if any("sane maximum" in r for r in f["reasons"])]
    print(f"   failing fat-share test:    {len(fat_only)}")
    print(f"   failing serving-mass test: {len(serv_only)}")

    print("\nWorst offenders by fat share:")
    fat_only.sort(key=lambda f: -(9.0 * (f["fat_g_per_100g"] or 0) / (f["energy_kcal_per_100g"] or 1)))
    for f in fat_only[:12]:
        share = 9.0 * f["fat_g_per_100g"] / f["energy_kcal_per_100g"] * 100
        sk = f.get("serving_energy_kcal")
        sk_txt = "n/a" if sk is None else f"{round(sk)}"
        print(f"   {f['food_name'][:42]:42s} {f['energy_kcal_per_100g']:6.0f} kcal/100g  "
              f"fat {share:4.0f}%  serving {sk_txt:>6} kcal")

    impossible = [f for f in fat_only
                  if 9.0 * f["fat_g_per_100g"] > f["energy_kcal_per_100g"]]
    print(f"\n   of which PHYSICALLY IMPOSSIBLE (fat energy exceeds total "
          f"energy): {len(impossible)}")
    print("   These pass the Atwater gate because energy and macros are")
    print("   consistently wrong TOGETHER -- internal consistency is not")
    print("   plausibility, which is exactly why this second check exists.")


if __name__ == "__main__":
    main()
