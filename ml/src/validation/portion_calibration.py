"""
Calibrate the household-portion catalogue against real measured servings.

WHY THIS IS NEEDED:
`portion_catalog.py` converts a portion to grams as volume x food density.
Both halves are assumptions until checked. INDB publishes ~900 Indian
dishes with BOTH a serving name and that serving's mass, which is exactly
the ground truth needed: for each dish, predict the mass of its stated
serving and compare against the published figure.

WHAT A FAILURE WOULD MEAN:
  * systematic bias  -> the assumed volume for that portion is wrong
  * huge scatter     -> density is not being resolved per food
  * one-sided error  -> a whole food class has the wrong density
So the report separates bias from scatter rather than showing a single
error number, because they call for different fixes.

WHAT "GOOD" LOOKS LIKE:
A "bowl" is not a defined unit -- real bowls vary, and INDB's own bowl
servings span 166-354 g (p25-p75). So per-dish error cannot beat that
spread, and the honest target is that the MEDIAN prediction sits inside
the observed range with bias near 1.0. Beating the spread would mean the
test set was leaking, not that the model is better than reality.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))

from inference.portion_catalog import canonical, portion_to_grams        # noqa: E402
from inference.portion_units import density_for                          # noqa: E402

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"
OUT = PROC / "portion_calibration.json"


def main():
    dishes = json.loads((PROC / "indb_dishes.json").read_text(encoding="utf-8"))

    rows, by_portion = [], defaultdict(list)
    skipped_unknown = 0

    for d in dishes:
        unit = (d.get("serving_description") or "").strip()
        truth = d.get("serving_grams")
        if not unit or not truth or not (1 < truth < 2000):
            continue
        if d.get("data_quality_flag"):
            continue
        key = canonical(unit)
        if key is None:
            skipped_unknown += 1
            continue

        pred, basis, note = portion_to_grams(
            key, 1, food_name=d.get("food_name", ""), density_fn=density_for,
            cooking_state=d.get("cooking_state"))
        if pred is None:
            continue

        ratio = pred / truth
        rows.append({
            "food_name": d.get("food_name"),
            "portion": key, "predicted_g": pred, "measured_g": truth,
            "ratio": round(ratio, 3), "basis": basis,
        })
        by_portion[key].append(ratio)

    ratios = np.array([r["ratio"] for r in rows])
    OUT.write_text(json.dumps(rows, indent=2), encoding="utf-8")

    print(f"dishes with a usable measured serving: {len(rows)}")
    print(f"portion names not in the catalogue (skipped): {skipped_unknown}\n")

    if not len(ratios):
        print("nothing comparable")
        return

    print("OVERALL predicted / measured")
    print(f"  median ratio {np.median(ratios):.2f}   "
          f"p25 {np.quantile(ratios, .25):.2f}   p75 {np.quantile(ratios, .75):.2f}")
    within2x = ((ratios >= 0.5) & (ratios <= 2.0)).mean() * 100
    within50 = ((ratios >= 0.67) & (ratios <= 1.5)).mean() * 100
    print(f"  within 1.5x: {within50:.1f}%     within 2x: {within2x:.1f}%")
    print("  (a 'bowl' is not a defined unit -- INDB's own bowl servings span")
    print("   166-354 g, so this spread is reality, not model error)\n")

    print("BY PORTION (bias = median ratio; 1.00 is unbiased)")
    print(f"  {'portion':16s} {'n':>4s} {'bias':>6s} {'p25':>6s} {'p75':>6s}  verdict")
    summary = {}
    for key, vals in sorted(by_portion.items(), key=lambda x: -len(x[1])):
        if len(vals) < 5:
            continue
        a = np.array(vals)
        bias = float(np.median(a))
        verdict = ("ok" if 0.8 <= bias <= 1.25
                   else "VOLUME TOO LARGE" if bias > 1.25 else "VOLUME TOO SMALL")
        summary[key] = {"n": len(a), "bias": round(bias, 2),
                        "p25": round(float(np.quantile(a, .25)), 2),
                        "p75": round(float(np.quantile(a, .75)), 2),
                        "verdict": verdict}
        print(f"  {key:16s} {len(a):4d} {bias:6.2f} "
              f"{np.quantile(a, .25):6.2f} {np.quantile(a, .75):6.2f}  {verdict}")

    (PROC / "portion_calibration_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8")

    print("\nSUGGESTED VOLUME CORRECTIONS (current_ml / bias):")
    from inference.portion_catalog import VOLUME_PORTIONS
    for key, s in summary.items():
        if s["verdict"] != "ok" and key in VOLUME_PORTIONS:
            cur = VOLUME_PORTIONS[key]["ml"]
            print(f"  {key:16s} {cur:5.0f} ml -> {cur / s['bias']:5.0f} ml")


if __name__ == "__main__":
    main()
