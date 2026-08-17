"""
END-TO-END ACCURACY BENCHMARK: our system's answer vs independent lab
measurement.

WHY THE EXISTING NUMBERS DO NOT ANSWER "HOW ACCURATE IS IT":
Every metric reported so far measures a COMPONENT. Worse, the obvious
"test" is circular: for a food in the database, the system returns the
lab value, so comparing it to the lab value scores 100% and proves
nothing.

A real test needs ground truth the system cannot see. So:

    IFCT 2017 is REMOVED from the database entirely, then each IFCT food
    is queried by its common name. The system must answer using USDA +
    INDB + Open Food Facts only. Its answer is compared against IFCT's
    independently measured value.

That is a genuinely independent comparison -- different labs, different
countries, different samples, different analytical methods. It measures
the whole pipeline as a user experiences it: query -> retrieval ->
ranking -> cooking-state default -> returned macros.

WHAT THIS MEASURES THAT COMPONENT METRICS DO NOT:
  * retrieval failure (right number, wrong food) counts as error, as it
    should -- to a user those are identical
  * cooking-state defaults are exercised
  * the whole tier stack participates

IMPORTANT CAVEAT, STATED UP FRONT:
Some spread here is REAL biological difference, not model error. Indian
and American cultivars of the same vegetable genuinely differ, and IFCT
sampled Indian produce specifically. So this is a conservative,
lower-bound estimate of accuracy -- the true error is somewhat smaller
than what this reports.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
DB_PATH = PROC / "unified_food_db.json"
OUT_PATH = PROC / "end_to_end_benchmark.json"
TMP_DB = PROC / "_benchmark_db_no_ifct.json"

TARGETS = ["energy_kcal", "protein_g", "fat_g", "carb_g"]


def clean_query(name):
    """Turn an IFCT catalogue name into what a user would actually type.
    'Rajmah, red (P haseolus vu lgaris)' -> 'rajmah red'
    Scientific names and catalogue qualifiers are dropped; this is the
    query, not the matching key."""
    n = unicodedata.normalize("NFKD", name or "")
    n = "".join(c for c in n if not unicodedata.combining(c))
    n = re.sub(r"\([^)]*\)", " ", n)          # drop Latin binomial
    n = n.lower()
    n = re.sub(r"[^a-z0-9\s,]", " ", n)
    # keep only the head noun plus first qualifier -- users type short
    parts = [p.strip() for p in n.split(",") if p.strip()]
    q = " ".join(parts[:2]) if parts else n
    q = re.sub(r"\b(all varieties|whole|raw|fresh|dried|type|var)\b", " ", q)
    return re.sub(r"\s+", " ", q).strip()


def ape(pred, true):
    if true is None or pred is None or true <= 0:
        return None
    return abs(pred - true) / true * 100.0


def main():
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    ifct = [f for f in db if f.get("source") == "IFCT2017"]
    rest = [f for f in db if f.get("source") != "IFCT2017"]
    print(f"Ground truth (IFCT, held out): {len(ifct)} foods")
    print(f"Database the system may use:   {len(rest)} foods\n")

    TMP_DB.write_text(json.dumps(rest), encoding="utf-8")

    # Aliases still apply, but any alias pointing only at a removed IFCT
    # row simply resolves to nothing -- which is the correct behaviour and
    # is counted as a miss, not silently skipped.
    from inference.food_search import FoodSearch  # noqa: E402
    fs = FoodSearch(db_path=TMP_DB)

    rows = []
    misses = 0
    for gt in ifct:
        if gt.get("energy_kcal") is None or gt.get("data_quality_flag"):
            continue
        q = clean_query(gt["food_name"])
        if not q or len(q) < 3:
            continue
        res = fs.search(q, limit=1)
        if not res:
            misses += 1
            rows.append({"query": q, "truth_name": gt["food_name"],
                         "matched": None, "resolved": False})
            continue
        r = res[0]
        entry = {
            "query": q,
            "truth_name": gt["food_name"],
            "matched": r["food_name"],
            "matched_source": r["source"],
            "resolved": True,
            "trustworthy": r.get("trustworthy", True),
        }
        for t in TARGETS:
            tv, pv = gt.get(t), r.get(t)
            entry[f"truth_{t}"] = tv
            entry[f"pred_{t}"] = pv
            entry[f"ape_{t}"] = ape(pv, tv)
        rows.append(entry)

    resolved = [r for r in rows if r["resolved"]]
    print(f"Queries attempted : {len(rows)}")
    print(f"Resolved to a food: {len(resolved)}  ({100*len(resolved)/len(rows):.1f}%)")
    print(f"No match at all   : {misses}\n")

    print("ACCURACY vs INDEPENDENT LAB MEASUREMENT (IFCT 2017)")
    print(f"  {'nutrient':12s} {'n':>5s} {'median APE':>11s} {'mean APE':>9s} "
          f"{'within 10%':>11s} {'within 25%':>11s}")
    summary = {}
    for t in TARGETS:
        vals = [r[f"ape_{t}"] for r in resolved if r.get(f"ape_{t}") is not None]
        if not vals:
            continue
        a = np.array(vals)
        summary[t] = {
            "n": len(a),
            "median_ape": round(float(np.median(a)), 1),
            "mean_ape": round(float(np.mean(a)), 1),
            "within_10pct": round(float((a <= 10).mean() * 100), 1),
            "within_25pct": round(float((a <= 25).mean() * 100), 1),
            "within_50pct": round(float((a <= 50).mean() * 100), 1),
        }
        s = summary[t]
        print(f"  {t:12s} {s['n']:5d} {s['median_ape']:10.1f}% {s['mean_ape']:8.1f}% "
              f"{s['within_10pct']:10.1f}% {s['within_25pct']:10.1f}%")

    # Where the system found an EXACT-ish name match, error should be much
    # lower -- separating this shows how much of the error is retrieval
    # (wrong food) rather than nutrition (right food, different sample).
    def norm(s):
        s = re.sub(r"\([^)]*\)", " ", (s or "").lower())
        return re.sub(r"[^a-z0-9]+", " ", s).strip()

    close = [r for r in resolved
             if r.get("matched") and norm(r["query"]).split()[0] in norm(r["matched"]).split()]
    if close:
        vals = [r["ape_energy_kcal"] for r in close if r.get("ape_energy_kcal") is not None]
        a = np.array(vals)
        print(f"\n  head-noun agreed ({len(a)} of {len(resolved)}): "
              f"median APE {np.median(a):.1f}%   within 25%: {(a<=25).mean()*100:.1f}%")

    payload = {
        "method": "IFCT 2017 held out of the database, queried by common name",
        "ground_truth_foods": len(ifct),
        "queries": len(rows),
        "resolved": len(resolved),
        "resolution_rate_pct": round(100 * len(resolved) / len(rows), 1),
        "accuracy": summary,
        "caveat": (
            "Some spread is genuine biological difference: IFCT sampled Indian "
            "cultivars, USDA sampled American ones. This is therefore a "
            "conservative lower bound on accuracy, not an upper bound on error."
        ),
    }
    OUT_PATH.write_text(json.dumps({"summary": payload, "rows": rows}, indent=2), encoding="utf-8")
    print(f"\nWrote {OUT_PATH}")

    worst = sorted((r for r in resolved if r.get("ape_energy_kcal") is not None),
                   key=lambda r: -r["ape_energy_kcal"])[:10]
    print("\nWorst energy mismatches (diagnostic -- mostly retrieval failures):")
    for r in worst:
        print(f"   {r['ape_energy_kcal']:6.0f}%  '{r['query'][:26]:26s}' -> "
              f"{r['matched'][:34]:34s} {r['pred_energy_kcal']:6.0f} vs truth "
              f"{r['truth_energy_kcal']:6.0f}")

    try:
        TMP_DB.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
