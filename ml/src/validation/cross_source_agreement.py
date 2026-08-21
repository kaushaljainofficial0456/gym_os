"""
Cross-source agreement check for the unified food DB.

THE IDEA (same principle as the external plausibility envelope built for
skos-cal-v1): where two INDEPENDENT sources measured the same food, their
agreement is a free, unbiased estimate of how much to trust that value --
no new data collection required.

This is not a correction step. Nothing is averaged or adjusted: averaging
two independent measurements of an ambiguously-defined food ("dosa" --
how thick? how much oil?) invents a third number that neither lab
measured. Instead disagreement is recorded as a CONFIDENCE signal that
travels with the food.

Worked example that motivated this file -- per-100g energy for the same
dish, measured independently:

    Plain dosa    INDB 380.9   USDA 210.0   ratio 1.81   <- large disagreement
    Idli          INDB 137.5   USDA 128.0   ratio 1.07   <- agrees
    Chapati/roti  INDB 202.3   USDA 297.0   ratio 0.68   <- disagrees, other way

So the disagreement is real and bidirectional -- it is not a fixable
systematic offset in one source, and picking a "winner" globally would be
wrong. It has to be per-food.
"""
import json
import re
import unicodedata
from pathlib import Path
from collections import defaultdict

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "cross_source_agreement.json"

# Ratio bands for the confidence label. Deliberately wide: two labs
# measuring "samosa" are measuring genuinely different samosas, so modest
# spread is expected and is not evidence of error.
AGREE_HI = 1.25     # within +/-25% -> sources corroborate
DISAGREE_HI = 1.60  # beyond +/-60% -> materially different answers


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()



# Words that do not change WHICH food this is, only how it was described.
# Everything else is treated as identifying and must match.
NON_IDENTIFYING = {
    "plain", "fresh", "raw", "cooked", "commercially", "prepared", "includes",
    "foods", "for", "usda", "s", "food", "distribution", "program", "all",
    "varieties", "type", "types", "unenriched", "enriched", "nfs",
}


def match_key(food):
    """Key foods for cross-source comparison on their FULL identifying
    name, not just the head noun.

    An earlier version keyed on head noun alone and produced almost
    entirely false disagreements: it paired IFCT "Pepper, black" (218
    kcal, correct) with USDA "Peppers, sweet, green" (27 kcal, also
    correct) and reported an 8x "dispute". Both values were right; the
    matcher was wrong. Same for peas (dried vs fresh) and apricot (dried
    vs fresh) -- exactly the qualifiers a head-noun key discards are the
    ones that determine the calorie content.

    Shipping that as a confidence signal would have flagged correct data
    as untrustworthy, which is worse than having no signal at all."""
    name = normalize(food.get("food_name") or "")
    toks = sorted(t for t in name.split() if t not in NON_IDENTIFYING)
    return (" ".join(toks), food.get("cooking_state"))


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for f in db:
        if f.get("energy_kcal") is None:
            continue
        groups[match_key(f)].append(f)

    results = []
    for key, foods in groups.items():
        sources = {f["source"] for f in foods}
        if len(sources) < 2:
            continue  # no independent second opinion available
        by_source = {}
        for f in foods:
            by_source.setdefault(f["source"], f)
        vals = {s: f["energy_kcal"] for s, f in by_source.items()}
        lo, hi = min(vals.values()), max(vals.values())
        if lo <= 0:
            continue
        ratio = hi / lo
        if ratio <= AGREE_HI:
            label = "corroborated"
        elif ratio <= DISAGREE_HI:
            label = "partial"
        else:
            label = "disputed"
        results.append({
            "food": key[0],
            "cooking_state": key[1],
            "sources": vals,
            "ratio": round(ratio, 2),
            "agreement": label,
        })

    results.sort(key=lambda r: -r["ratio"])
    OUT_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")

    counts = defaultdict(int)
    for r in results:
        counts[r["agreement"]] += 1
    total = len(results)
    print(f"Foods with >=2 independent sources: {total}")
    for label in ("corroborated", "partial", "disputed"):
        n = counts[label]
        pct = 100 * n / total if total else 0
        print(f"  {label:14s} {n:5d}  ({pct:.1f}%)")

    print("\nLargest disagreements (these should NOT be presented as precise):")
    for r in results[:12]:
        srcs = "  ".join(f"{s}={v:.0f}" for s, v in r["sources"].items())
        print(f"  {r['ratio']:5.2f}x  {r['food'][:34]:34s} [{r['cooking_state']}]  {srcs}")


if __name__ == "__main__":
    main()
