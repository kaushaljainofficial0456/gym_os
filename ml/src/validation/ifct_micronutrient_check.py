"""
Internal-consistency validation for the newly extracted IFCT tables.

THE PRINCIPLE, same as the Atwater gate used on every other source:
a table can be checked against ANOTHER table that measures the same
underlying quantity a different way. Where two independent measurements of
the same food must agree by physical law, disagreement localises the error.

THREE CHECKS, each with a law behind it:

1. AMINO ACIDS vs PROTEIN (Table 8 vs Table 1)
   Protein IS amino acids. Summing the 18 measured amino acids should
   approach the Kjeldahl protein figure. It lands slightly BELOW by
   construction -- peptide bonds shed a water molecule per link, so summed
   free-amino-acid mass runs ~5-15% under, and tryptophan/cysteine are
   partly destroyed by acid hydrolysis. So the expected ratio is ~0.75-1.05,
   not exactly 1.0.

2. FATTY ACIDS vs FAT (Table 7 vs Table 1)
   Total fat is triglycerides; the fatty acid residues are ~95% of that
   mass, the rest being the glycerol backbone. Summed fatty acids should be
   ~0.75-1.00 of total fat.

3. INDIVIDUAL SUGARS vs CARBOHYDRATE (Table 6 vs Table 1)
   Free sugars are a SUBSET of available carbohydrate, so the ratio must be
   <= ~1.05. Exceeding carbohydrate is physically impossible.

A failure here means the extraction misaligned a column -- exactly the
failure mode x-position assignment is meant to prevent, so it is worth
proving rather than assuming.
"""
import json
from pathlib import Path

import numpy as np

PROC = Path(__file__).resolve().parents[2] / "data" / "processed"


def load(name):
    p = PROC / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def by_code(rows):
    return {r["food_code"]: r for r in rows}


def summarise(label, ratios, lo, hi):
    if not ratios:
        print(f"  {label}: no comparable rows")
        return
    a = np.array(ratios)
    inside = ((a >= lo) & (a <= hi)).mean() * 100
    print(f"  {label:34s} n={len(a):4d}  median {np.median(a):5.2f}  "
          f"p10 {np.quantile(a,0.1):5.2f}  p90 {np.quantile(a,0.9):5.2f}  "
          f"within[{lo},{hi}] {inside:5.1f}%")
    return a


def main():
    t1 = by_code(load("ifct2017_table1_proximate.json"))
    t6 = by_code(load("ifct2017_table6_sugars.json"))
    t7 = by_code(load("ifct2017_table7_fatty_acids.json"))
    t8 = by_code(load("ifct2017_table8_amino_acids.json"))

    print("IFCT CROSS-TABLE CONSISTENCY (each check has a physical law behind it)\n")

    # ---- 1) amino acids vs protein ----
    # Table 8 prints TWO column-blocks and only the first (the 9 essential
    # amino acids plus cystine) falls in the extracted page range, so a
    # whole-protein sum is not available and would read falsely low. The
    # meaningful check on this subset is each amino acid's SHARE of protein,
    # which is a stable biological quantity: leucine sits at 7-10% of
    # protein across almost all foods, lysine 5-8%, and a column
    # misalignment would throw those far outside.
    print("  amino acid share of protein (biological ranges, n foods in band):")
    SHARE_BANDS = {
        "aa_leucine": (6.0, 11.0), "aa_lysine": (3.5, 9.0),
        "aa_isoleucine": (3.0, 6.0), "aa_valine": (3.5, 7.5),
        "aa_threonine": (2.5, 5.5), "aa_phenylalanine": (3.0, 7.0),
        "aa_histidine": (1.5, 4.0), "aa_methionine": (0.8, 3.5),
    }
    for base, (lo, hi) in SHARE_BANDS.items():
        vals = [r[base + "_g_per_100g_protein"] for r in t8.values()
                if r.get(base + "_g_per_100g_protein") is not None]
        if not vals:
            continue
        a = np.array(vals)
        inside = ((a >= lo) & (a <= hi)).mean() * 100
        print(f"    {base.replace('aa_',''):14s} n={len(a):4d}  median {np.median(a):5.2f}%  "
              f"within[{lo},{hi}] {inside:5.1f}%")

    # ---- 2) fatty acids vs fat ----
    ratios = []
    for code, r7 in t7.items():
        fat = (t1.get(code) or {}).get("fat_g")
        if not fat or fat < 1:
            continue
        sat, mono, poly = r7.get("fa_saturated_mg"), r7.get("fa_monounsat_mg"), r7.get("fa_polyunsat_mg")
        if None in (sat, mono, poly):
            continue
        fa_g = (sat + mono + poly) / 1000.0
        ratios.append(fa_g / fat)
    summarise("fatty acids / total fat", ratios, 0.70, 1.05)

    # ---- 3) sugars vs carbohydrate ----
    ratios = []
    over = 0
    for code, r6 in t6.items():
        carb = (t1.get(code) or {}).get("carb_by_difference_g")
        if not carb or carb < 1:
            continue
        sugars = [r6.get(f) for f in ("fructose_g", "glucose_g", "sucrose_g", "maltose_g")]
        got = [v for v in sugars if v is not None]
        if not got:
            continue
        s = sum(got)
        ratios.append(s / carb)
        if s / carb > 1.05:
            over += 1
    summarise("free sugars / carbohydrate", ratios, 0.0, 1.05)
    print(f"      of which physically impossible (sugars > carbs): {over}")

    # ---- fitness-relevant spot check: leucine in known-high-protein foods ----
    print("\n  LEUCINE spot-check (drives muscle protein synthesis):")
    for code, name_hint in (("N003", "chicken breast"), ("M001", "whole egg"),
                            ("L003", "paneer"), ("B013", "lentil dal")):
        r8, r1 = t8.get(code), t1.get(code)
        if not r8 or not r1:
            continue
        leu, prot = r8.get("aa_leucine_mg"), r1.get("protein_g")
        if leu and prot:
            print(f"    {name_hint:16s} leucine {leu:7.0f} mg/100g  "
                  f"= {leu/prot/10:5.1f}% of protein  (typical 7-10%)")


if __name__ == "__main__":
    main()
