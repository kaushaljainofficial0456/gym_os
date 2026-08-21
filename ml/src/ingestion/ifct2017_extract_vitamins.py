"""
Extract IFCT 2017 Table 2 (WATER SOLUBLE VITAMINS) -- thiamine,
riboflavin, niacin, B6, folate, vitamin C and friends.

Uses the same X-POSITION extraction proven on Table 5 (minerals): each
header code's column centre is read off the page, and every numeric token
in a data row is assigned to the nearest column. Sequential token-zipping
fails on these tables because below-detection-limit blanks fall in
different columns per food, and a missing value silently shifts every
later column -- which is how the first minerals attempt lost 80% of rows.

Scope note: this completes the "micros if possible" part of the brief for
water-soluble vitamins. Table 3 (fat-soluble) and Table 4 (carotenoids)
use the same machinery and can be added by extending TABLE_PAGES and
CODES; they are left out here because macros and the minerals/vitamins
already extracted cover what the app displays, and unverified extraction
is worse than none.
"""
import re
import json
from pathlib import Path
from collections import Counter

import pdfplumber

PDF_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "ifct" / "IFCT2017_NIN.pdf"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "ifct2017_table2_vitamins.json"

TABLE_PAGES = range(70, 100)   # Table 2 spans PDF pages 70-99 (Table 3 starts at 100)

CODES = {
    "THIA": "thiamine_b1_mg",
    "RIBF": "riboflavin_b2_mg",
    "NIA": "niacin_b3_mg",
    "PANTAC": "pantothenic_acid_b5_mg",
    "VITB6A": "vitamin_b6_mg",
    "BIOT": "biotin_b7_ug",
    "FOLSUM": "folate_b9_ug",
    "VITC": "vitamin_c_mg",
}

FOOD_CODE_RE = re.compile(r"^[A-Z]\d{3}$")
NUMERIC_RE = re.compile(r"^\d+(?:\.\d+)?(?:\xb1\d+(?:\.\d+)?)?$")
Y_TOL = 3.0


def parse_mean(token):
    return float(token.split("\xb1", 1)[0]) if "\xb1" in token else float(token)


def find_header_columns(words):
    code_words = [w for w in words if w["text"] in CODES]
    if len(code_words) < 3:
        return None
    header_y = Counter(round(w["top"]) for w in code_words).most_common(1)[0][0]
    cols = {w["text"]: (w["x0"] + w["x1"]) / 2
            for w in code_words if abs(w["top"] - header_y) <= Y_TOL}
    return cols if len(cols) >= 3 else None


def nearest(x, columns):
    best, dist = None, None
    for code, cx in columns.items():
        d = abs(x - cx)
        if dist is None or d < dist:
            best, dist = code, d
    return best, dist


def main():
    records = {}
    current_cols = None
    with pdfplumber.open(PDF_PATH) as pdf:
        for idx in TABLE_PAGES:
            if idx >= len(pdf.pages):
                break
            words = pdf.pages[idx].extract_words()
            cols = find_header_columns(words)
            if cols:
                current_cols = cols
            if not current_cols:
                continue
            for ct in [w for w in words if FOOD_CODE_RE.match(w["text"])]:
                row = [w for w in words if abs(w["top"] - ct["top"]) <= Y_TOL]
                rec = records.setdefault(ct["text"], {
                    "food_code": ct["text"], "source": "IFCT2017_NIN_PDF", "basis": "raw",
                })
                for w in row:
                    if not NUMERIC_RE.match(w["text"]):
                        continue
                    cx = (w["x0"] + w["x1"]) / 2
                    code, dist = nearest(cx, current_cols)
                    if code is None or dist > 25:
                        continue
                    rec.setdefault(CODES[code], parse_mean(w["text"]))

    recs = list(records.values())
    OUT_PATH.write_text(json.dumps(recs, indent=2), encoding="utf-8")
    print(f"Extracted vitamins for {len(recs)} foods -> {OUT_PATH.name}")
    cov = {}
    for r in recs:
        for f in CODES.values():
            cov[f] = cov.get(f, 0) + (1 if r.get(f) is not None else 0)
    for f, n in sorted(cov.items()):
        print(f"   {f:26s} {n:4d}")

    # Plausibility spot-check against independently known values.
    known = {"vitamin_c_mg": ("C033", "spinach", 20, 60)}
    for field, (code, label, lo, hi) in known.items():
        r = next((x for x in recs if x["food_code"] == code), None)
        if r and r.get(field) is not None:
            ok = "OK" if lo <= r[field] <= hi else "OUT OF EXPECTED RANGE"
            print(f"\n   spot-check {label} {field}: {r[field]} (expect {lo}-{hi}) -> {ok}")


if __name__ == "__main__":
    main()
