"""
Measure the IRREDUCIBLE error floor for name-only nutrition prediction.

WHY THIS MATTERS:
Tuning the tier-3 retrieval model plateaued at ~21.6% median APE, and
abstaining on low-similarity matches did not help (error stayed ~21% even
when restricted to the 30% best-matched foods). That pattern says the
error is not a modelling failure -- it is variance that no name-only
model can remove.

This file tests that claim instead of asserting it, two ways:

  1. SAME-NAME VARIANCE. Where two rows share an identical normalised
     name, a perfect name-only model must return one number for both.
     The spread between them is therefore error it cannot avoid.

  2. NEAR-NAME VARIANCE. Foods whose names differ by one qualifier
     ("samosa" vs "potato samosa") -- how much does energy move? This is
     the variance a model faces when the user types a slightly different
     phrase than the database stores.

If the measured floor is close to the model's achieved error, then the
model is near-optimal for its input and further tuning is wasted effort --
the honest response is to widen tier 1 coverage (measured values) rather
than chase the model.
"""
import json
import re
import unicodedata
from pathlib import Path
from collections import defaultdict

import numpy as np

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "irreducible_error_floor.json"


def normalize(text):
    n = unicodedata.normalize("NFKD", text or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = n.lower()
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9\s]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def pairwise_ape(values):
    """Median |a-b|/mean(a,b) across all pairs in a group -- the error an
    oracle single-value predictor would still incur inside this group."""
    out = []
    for i in range(len(values)):
        for j in range(i + 1, len(values)):
            a, b = values[i], values[j]
            m = (a + b) / 2
            if m > 1:
                out.append(abs(a - b) / m)
    return out


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    foods = [f for f in db
             if f.get("energy_kcal") is not None
             and not f.get("data_quality_flag")
             and 0 < f["energy_kcal"] <= 900]

    # ---- 1) identical normalised name ----
    by_name = defaultdict(list)
    for f in foods:
        by_name[normalize(f["food_name"])].append(f["energy_kcal"])

    same_name_apes = []
    groups_used = 0
    for name, vals in by_name.items():
        if len(vals) < 2:
            continue
        apes = pairwise_ape(vals)
        if apes:
            same_name_apes.extend(apes)
            groups_used += 1

    # ---- 2) same head noun, differing qualifiers ----
    by_head = defaultdict(list)
    for f in foods:
        head = normalize(f["food_name"]).split()
        if head:
            by_head[head[0]].append(f["energy_kcal"])

    near_name_apes = []
    for head, vals in by_head.items():
        if len(vals) < 2 or len(vals) > 60:
            continue
        v = np.array(vals, dtype=float)
        med = np.median(v)
        if med > 1:
            near_name_apes.extend(list(np.abs(v - med) / med))

    def pct(a, q):
        return round(float(np.quantile(a, q) * 100), 1) if len(a) else None

    report = {
        "identical_name_variance": {
            "description": (
                "Rows sharing an identical normalised food name. A perfect "
                "name-only model must output one value for all of them, so "
                "this spread is unavoidable error."
            ),
            "groups": groups_used,
            "pairs": len(same_name_apes),
            "median_ape_pct": pct(same_name_apes, 0.50),
            "p75_ape_pct": pct(same_name_apes, 0.75),
            "p90_ape_pct": pct(same_name_apes, 0.90),
        },
        "same_head_noun_variance": {
            "description": (
                "Foods sharing a head noun but differing in qualifiers "
                "(the situation when a user types a shorter phrase than the "
                "database stores). Deviation from the group median."
            ),
            "groups": sum(1 for v in by_head.values() if 2 <= len(v) <= 60),
            "samples": len(near_name_apes),
            "median_ape_pct": pct(near_name_apes, 0.50),
            "p75_ape_pct": pct(near_name_apes, 0.75),
        },
    }

    OUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("IRREDUCIBLE ERROR FLOOR FOR NAME-ONLY PREDICTION\n")
    a = report["identical_name_variance"]
    print(f"1) Identical names ({a['groups']} groups, {a['pairs']} pairs)")
    print(f"   median APE {a['median_ape_pct']}%   p75 {a['p75_ape_pct']}%   p90 {a['p90_ape_pct']}%")
    b = report["same_head_noun_variance"]
    print(f"\n2) Same head noun ({b['groups']} groups, {b['samples']} samples)")
    print(f"   median APE {b['median_ape_pct']}%   p75 {b['p75_ape_pct']}%")

    print("\nINTERPRETATION")
    print("   tier-3 retrieval model achieves ~21.6% median APE (measured)")
    print(f"   identical-name spread is only ~{a['median_ape_pct']}% -- so when two sources")
    print("     name the same food identically they agree closely. Naming is not the problem.")
    print(f"   the floor that actually applies to tier 3 is ~{b['median_ape_pct']}%:")
    print("     tier 3 runs only when NO exact match exists, so the best information")
    print("     available is the head noun, and foods sharing a head noun genuinely")
    print(f"     vary by ~{b['median_ape_pct']}%. Comparing against the 5.1% identical-name")
    print("     figure would be wrong -- that case is tier 1, never tier 3.")
    if b["median_ape_pct"] is not None:
        print(f"   real headroom: ~{21.6 - b['median_ape_pct']:.1f} percentage points, not 16.5")


if __name__ == "__main__":
    main()
