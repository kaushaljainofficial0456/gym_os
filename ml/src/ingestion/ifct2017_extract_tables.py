"""
Generalised IFCT 2017 table extractor -- Tables 3, 4, 6, 7, 8.

WHY ONE EXTRACTOR INSTEAD OF FIVE SCRIPTS:
Tables 1, 2 and 5 were each written separately and each rediscovered the
same two lessons the hard way:
  * sequential token-zipping breaks, because below-detection blanks land in
    DIFFERENT columns per food and silently shift every later value (the
    first minerals attempt lost 80% of rows this way);
  * values are printed as "mean +- sd" in a single token.
X-POSITION assignment solves both: each header code's column centre is read
off the page, and every numeric token is assigned to the nearest column, so
a missing value simply leaves its column empty instead of corrupting its
neighbours.

WHAT THESE TABLES ADD, and why these five:
  Table 8  amino acids   -- protein QUALITY. Leucine drives muscle protein
                            synthesis, so for a training app this is the
                            most useful of the set.
  Table 7  fatty acids   -- SFA/MUFA/PUFA and omega-3/6 split.
  Table 6  sugars/starch -- free-sugar tracking, which macros alone hide.
  Table 3  fat-soluble vitamins (E, K, D)
  Table 4  carotenoids

Page ranges were discovered by scanning for the printed "Table N." heading,
not assumed from the book's table of contents -- the PDF and the book use
different page numbering.
"""
import json
import re
from collections import Counter
from pathlib import Path

import pdfplumber

PDF_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "ifct" / "IFCT2017_NIN.pdf"
PROC = Path(__file__).resolve().parents[2] / "data" / "processed"

FOOD_CODE_RE = re.compile(r"^[A-Z]\d{3}$")
NUMERIC_RE = re.compile(r"^\d+(?:\.\d+)?(?:\xb1\d+(?:\.\d+)?)?$")
Y_TOL = 3.0
MAX_COL_DIST = 25.0

# table number -> (page range, {printed code: output field}, output filename)
TABLES = {
    3: (range(100, 130), {
        "ERGCAL": "vitamin_d2_ug", "TOCPHA": "tocopherol_alpha_mg",
        "TOCPHB": "tocopherol_beta_mg", "TOCPHG": "tocopherol_gamma_mg",
        "TOCPHD": "tocopherol_delta_mg", "TOCTRA": "tocotrienol_alpha_mg",
        "TOCTRB": "tocotrienol_beta_mg", "TOCTRG": "tocotrienol_gamma_mg",
        "TOCTRD": "tocotrienol_delta_mg", "VITE": "vitamin_e_mg",
        "VITK1": "vitamin_k1_ug",
    }, "ifct2017_table3_fat_soluble_vitamins.json"),

    4: (range(130, 150), {
        "LUTN": "lutein_ug", "ZEA": "zeaxanthin_ug", "LYCPN": "lycopene_ug",
        "CRYPXB": "beta_cryptoxanthin_ug", "CARTG": "gamma_carotene_ug",
        "CARTA": "alpha_carotene_ug", "CARTB": "beta_carotene_ug",
        "CARTOID": "total_carotenoids_ug",
    }, "ifct2017_table4_carotenoids.json"),

    6: (range(208, 226), {
        "STARCH": "starch_g", "FRUS": "fructose_g", "GLUS": "glucose_g",
        "SUCS": "sucrose_g", "MALS": "maltose_g",
    }, "ifct2017_table6_sugars.json"),

    7: (range(226, 296), {
        "F10D0": "fa_c10_0_mg", "F12D0": "fa_c12_0_mg", "F14D0": "fa_c14_0_mg",
        "F16D0": "fa_c16_0_mg", "F18D0": "fa_c18_0_mg", "F20D0": "fa_c20_0_mg",
        "F22D0": "fa_c22_0_mg", "F24D0": "fa_c24_0_mg",
        "F14D1": "fa_c14_1_mg", "F16D1": "fa_c16_1_mg", "F18D1N9": "fa_c18_1n9_mg",
        "F18D2N6": "fa_c18_2n6_mg", "F18D3N3": "fa_c18_3n3_mg",
        "F20D4N6": "fa_c20_4n6_mg", "F20D5N3": "fa_epa_mg", "F22D6N3": "fa_dha_mg",
        "FASAT": "fa_saturated_mg", "FAMS": "fa_monounsat_mg", "FAPU": "fa_polyunsat_mg",
    }, "ifct2017_table7_fatty_acids.json"),

    # UNITS DIFFER FROM EVERY OTHER TABLE. Table 8's own header reads
    # "(All values are expressed in g per 100g protein)" -- amino acids are
    # relative to the food's PROTEIN, not per 100 g of food. Naming them
    # *_mg (as an earlier version did) implied per-100g-food and produced an
    # amino-acids/protein ratio of 0.01 instead of ~0.85. The extraction was
    # right; the unit assumption was not. Field names now state the basis,
    # and absolute per-100g-food values are DERIVED in main() using Table 1
    # protein rather than being silently conflated.
    8: (range(296, 363), {
        "HIS": "aa_histidine_g_per_100g_protein", "ILE": "aa_isoleucine_g_per_100g_protein",
        "LEU": "aa_leucine_g_per_100g_protein", "LYS": "aa_lysine_g_per_100g_protein",
        "MET": "aa_methionine_g_per_100g_protein", "CYS": "aa_cysteine_g_per_100g_protein",
        "PHE": "aa_phenylalanine_g_per_100g_protein", "THR": "aa_threonine_g_per_100g_protein",
        "TRP": "aa_tryptophan_g_per_100g_protein", "VAL": "aa_valine_g_per_100g_protein",
        "ARG": "aa_arginine_g_per_100g_protein", "ALA": "aa_alanine_g_per_100g_protein",
        "ASP": "aa_aspartic_g_per_100g_protein", "GLU": "aa_glutamic_g_per_100g_protein",
        "GLY": "aa_glycine_g_per_100g_protein", "PRO": "aa_proline_g_per_100g_protein",
        "SER": "aa_serine_g_per_100g_protein", "TYR": "aa_tyrosine_g_per_100g_protein",
    }, "ifct2017_table8_amino_acids.json"),

    # Table 12 -- fatty acid profile of the 14 edible oils and fats Indian
    # cooking actually uses (coconut, mustard, gingelly, rice bran, ghee,
    # vanaspati...). Units are "% of total fatty acid methyl ester", i.e.
    # composition SHARES, not per-100g mass -- every cooking fat is ~900
    # kcal/100 g regardless, so this adds fat QUALITY, not calories.
    # It matters because the oil feature lets a user pick their oil, and
    # ghee vs sunflower is a real difference in saturated fat even at
    # identical energy.
    12: (range(473, 475), {
        "F4D0": "fa_pct_c4_0", "F6D0": "fa_pct_c6_0", "F8D0": "fa_pct_c8_0",
        "F10D0": "fa_pct_c10_0", "F12D0": "fa_pct_c12_0", "F14D0": "fa_pct_c14_0",
        "F16D0": "fa_pct_c16_0", "F18D0": "fa_pct_c18_0", "F20D0": "fa_pct_c20_0",
        "F22D0": "fa_pct_c22_0", "F24D0": "fa_pct_c24_0",
        "F14D1": "fa_pct_c14_1", "F16D1": "fa_pct_c16_1",
        "F18D1TN9": "fa_pct_c18_1_trans_n9", "F18D1N9": "fa_pct_c18_1n9",
        "F20D1N9": "fa_pct_c20_1n9", "F22D1N9": "fa_pct_c22_1n9",
        "F18D2N6": "fa_pct_c18_2n6", "F18D3N3": "fa_pct_c18_3n3",
        "FASAT": "fa_pct_saturated", "FAMS": "fa_pct_monounsat",
        "FAPU": "fa_pct_polyunsat",
    }, "ifct2017_table12_edible_oils.json"),
}


def parse_mean(token):
    return float(token.split("\xb1", 1)[0]) if "\xb1" in token else float(token)


def find_header_columns(words, codes):
    """{code: x_center} for the header row on this page, if present."""
    hits = [w for w in words if w["text"] in codes]
    if len(hits) < 3:
        return None
    header_y = Counter(round(w["top"]) for w in hits).most_common(1)[0][0]
    cols = {w["text"]: (w["x0"] + w["x1"]) / 2
            for w in hits if abs(w["top"] - header_y) <= Y_TOL}
    return cols if len(cols) >= 3 else None


def nearest(x, columns):
    best, dist = None, None
    for code, cx in columns.items():
        d = abs(x - cx)
        if dist is None or d < dist:
            best, dist = code, d
    return best, dist


def extract_table(pdf, pages, code_map):
    records, current_cols = {}, None
    for idx in pages:
        if idx >= len(pdf.pages):
            break
        words = pdf.pages[idx].extract_words()
        cols = find_header_columns(words, code_map)
        if cols:
            current_cols = cols
        if not current_cols:
            continue
        for ct in [w for w in words if FOOD_CODE_RE.match(w["text"])]:
            row_words = [w for w in words if abs(w["top"] - ct["top"]) <= Y_TOL]
            rec = records.setdefault(ct["text"], {
                "food_code": ct["text"], "source": "IFCT2017_NIN_PDF", "basis": "raw",
            })
            for w in row_words:
                if not NUMERIC_RE.match(w["text"]):
                    continue
                cx = (w["x0"] + w["x1"]) / 2
                code, dist = nearest(cx, current_cols)
                if code is None or dist > MAX_COL_DIST:
                    continue
                rec.setdefault(code_map[code], parse_mean(w["text"]))
    return list(records.values())


def derive_absolute_amino_acids(recs):
    """Table 8 is g per 100 g PROTEIN. Convert to mg per 100 g FOOD using
    each food's own measured protein from Table 1:

        mg/100g food = (g/100g protein) / 100 * protein_g * 1000

    Both bases are kept: the relative figure is what IFCT measured and is
    the right basis for protein QUALITY (e.g. leucine as a share of
    protein), while the absolute figure is what a user actually eats."""
    t1_path = PROC / "ifct2017_table1_proximate.json"
    if not t1_path.exists():
        return recs
    protein = {r["food_code"]: r.get("protein_g")
               for r in json.loads(t1_path.read_text(encoding="utf-8"))}
    derived = 0
    for r in recs:
        p = protein.get(r["food_code"])
        if not p:
            continue
        for k in list(r):
            if k.endswith("_g_per_100g_protein") and r[k] is not None:
                base = k[: -len("_g_per_100g_protein")]
                r[base + "_mg"] = round(r[k] / 100.0 * p * 1000.0, 1)
                derived += 1
    return recs


def main():
    with pdfplumber.open(PDF_PATH) as pdf:
        for tno, (pages, code_map, fname) in TABLES.items():
            recs = extract_table(pdf, pages, code_map)
            if tno == 8:
                recs = derive_absolute_amino_acids(recs)
            (PROC / fname).write_text(json.dumps(recs, indent=2), encoding="utf-8")
            cov = {f: sum(1 for r in recs if r.get(f) is not None) for f in code_map.values()}
            filled = sum(cov.values())
            print(f"Table {tno}: {len(recs):3d} foods, {len(code_map):2d} nutrients, "
                  f"{filled:5d} values -> {fname}")
            thin = [f for f, n in cov.items() if n < len(recs) * 0.05]
            if thin:
                print(f"   sparse columns (<5% coverage, usually genuinely "
                      f"below detection limit): {thin[:6]}")


if __name__ == "__main__":
    main()
