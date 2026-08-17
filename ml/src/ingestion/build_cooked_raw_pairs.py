"""
Link raw <-> cooked forms of the same food, using USDA's separately
MEASURED entries rather than applying a generic retention factor.

WHY MEASURED PAIRS BEAT RETENTION FACTORS:
The textbook approach is raw value x yield factor x retention factor.
But USDA already publishes "Chicken, breast, raw" AND "Chicken, breast,
roasted" as two independent lab measurements. Using both directly is
strictly more accurate than measuring one and modelling the other -- the
measured cooked value already embodies the true water loss, fat rendering
and nutrient degradation for that specific food and method, with no
modelling assumption at all.

Retention factors remain the right tool ONLY where no measured cooked
entry exists. This file quantifies how far that gets us, so the gap is
known rather than assumed.

WHAT THIS ENABLES:
"100g chicken" is ambiguous -- raw (~120 kcal) or cooked (~165 kcal)?
That is a ~35% error either way, larger than almost any other error in
this pipeline. Knowing both forms lets the app ask, or default sensibly,
instead of silently picking one.
"""
import json
import re
import unicodedata
from pathlib import Path
from collections import defaultdict

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "cooked_raw_pairs.json"

COOK_WORDS = {
    "cooked", "boiled", "roasted", "baked", "fried", "grilled", "broiled",
    "steamed", "braised", "stewed", "toasted", "microwaved", "poached",
    "blanched", "heated", "sauteed", "rotisserie", "simmered",
}
RAW_WORDS = {"raw", "uncooked", "dried", "dry"}
# Words that describe HOW it was cooked or trimmed -- not which food it is.
NOISE = COOK_WORDS | RAW_WORDS | {
    "with", "without", "and", "or", "the", "of", "in", "a", "skin", "eaten",
    "meat", "only", "added", "no", "fat", "salt", "drained", "solids",
    "includes", "foods", "for", "usda", "s", "food", "distribution",
    "program", "prepared", "commercially", "all", "varieties", "nfs",
}


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def identity_key(name):
    """The food's identity with preparation words removed, so raw and
    cooked forms of the SAME food collapse to one key while different
    foods stay apart."""
    toks = [t for t in normalize(name).split() if t not in NOISE]
    return " ".join(sorted(toks))


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    groups = defaultdict(lambda: {"raw": [], "cooked": []})

    for f in db:
        state = f.get("cooking_state")
        if state not in ("raw", "cooked"):
            continue
        if f.get("energy_kcal") is None:
            continue
        groups[identity_key(f["food_name"])][state].append(f)

    pairs = []
    for key, g in groups.items():
        if not g["raw"] or not g["cooked"]:
            continue
        # Prefer the least-qualified entry on each side as the representative
        raw = min(g["raw"], key=lambda f: len(f["food_name"]))
        cooked = min(g["cooked"], key=lambda f: len(f["food_name"]))
        if raw["energy_kcal"] <= 0:
            continue
        pairs.append({
            "identity": key,
            "raw_name": raw["food_name"],
            "raw_kcal": raw["energy_kcal"],
            "raw_source_id": raw["source_id"],
            "cooked_name": cooked["food_name"],
            "cooked_kcal": cooked["energy_kcal"],
            "cooked_source_id": cooked["source_id"],
            # Energy density ratio, NOT a yield factor: both are per 100g of
            # their own state, so this captures the net effect of water
            # loss/gain on density. Useful as a sanity bound, not a
            # conversion coefficient for arbitrary foods.
            "cooked_to_raw_density_ratio": round(cooked["energy_kcal"] / raw["energy_kcal"], 3),
        })

    pairs.sort(key=lambda p: -p["cooked_to_raw_density_ratio"])
    OUT_PATH.write_text(json.dumps(pairs, indent=2), encoding="utf-8")
    print(f"Measured raw<->cooked pairs: {len(pairs)} -> {OUT_PATH}")

    ratios = [p["cooked_to_raw_density_ratio"] for p in pairs]
    if ratios:
        import statistics
        print(f"  density ratio  median {statistics.median(ratios):.2f}  "
              f"min {min(ratios):.2f}  max {max(ratios):.2f}")
        denser = sum(1 for r in ratios if r > 1)
        print(f"  cooked is MORE energy-dense in {denser}/{len(ratios)} "
              f"({100*denser/len(ratios):.0f}%) -- expected, since cooking usually drives off water")

    print("\n  examples:")
    for p in pairs[:6] + pairs[-4:]:
        print(f"   {p['cooked_to_raw_density_ratio']:5.2f}x  {p['raw_name'][:38]:38s} "
              f"{p['raw_kcal']:6.0f} -> {p['cooked_kcal']:6.0f}")

    total_states = sum(1 for f in db if f.get("cooking_state") in ("raw", "cooked"))
    covered = sum(1 for p in pairs) * 2
    print(f"\n  coverage: {covered}/{total_states} raw-or-cooked rows sit in a matched pair "
          f"({100*covered/total_states:.0f}%) -- the rest have only one state measured")


if __name__ == "__main__":
    main()
