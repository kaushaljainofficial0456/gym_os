"""
Extract Table 5 (TRACE ELEMENTS AND MINERALS) from the primary NIN/ICMR
IFCT 2017 PDF. Same source/licensing basis as ifct2017_extract.py (Table 1)
-- see that file's docstring.

Table 5 prints 20 minerals as TWO separate column-blocks, each spanning
the full ~528-food list on its own page range (confirmed by inspection:
food A001 appears on both page 150 with Al..Li and page 151 with Mg..Zn),
not one wide table.

Sequential token-zip (the Table 1 approach) fails badly here: minerals
have many below-detection-limit blanks scattered across DIFFERENT columns
per food (not one consistent group like Table 1's fibre columns), so a
"count mismatch -> skip" rule loses most rows. Instead this extracts by
X-POSITION: each header code's column center-x is read directly off the
page, and each numeric token in a data row is assigned to whichever
header column its x-position is closest to. A missing (below-detection)
cell just leaves that column empty for that row -- it doesn't shift
everything after it, so it doesn't corrupt neighboring columns the way
sequential zipping would.

Validation is lighter than Table 1 (no Atwater-equivalent formula for
minerals) -- structural checks plus plausibility spot-checks against
independently known values, not a full per-row cross-check. Micronutrients
are the "if possible" tier of this project, not the core calorie/macro
deliverable Table 1 already covers.
"""
import re
import json
from pathlib import Path

import pdfplumber

PDF_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "ifct" / "IFCT2017_NIN.pdf"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "ifct2017_table5_minerals.json"

TABLE5_PAGES = range(150, 208)  # 0-indexed; Table 6 confirmed starting at page 208

BLOCK_A_CODES = {
    "AL": "aluminium_mg", "AS": "arsenic_ug", "CD": "cadmium_mg", "CA": "calcium_mg",
    "CR": "chromium_mg", "CO": "cobalt_mg", "CU": "copper_mg", "FE": "iron_mg",
    "PB": "lead_mg", "LI": "lithium_mg",
}
BLOCK_B_CODES = {
    "MG": "magnesium_mg", "MN": "manganese_mg", "HG": "mercury_ug", "MO": "molybdenum_mg",
    "NI": "nickel_mg", "P": "phosphorus_mg", "K": "potassium_mg", "SE": "selenium_ug",
    "NA": "sodium_mg", "ZN": "zinc_mg",
}
ALL_CODES = {**BLOCK_A_CODES, **BLOCK_B_CODES}

FOOD_CODE_RE = re.compile(r"^[A-Z]\d{3}$")
# pdfplumber keeps "118\xb12.9" (mean\xb1sd) as ONE word token, same as Table 1 --
# must accept that shape too, not just a bare number, or every multi-region
# sampled row (the overwhelming majority) silently drops all its values.
NUMERIC_RE = re.compile(r"^\d+(?:\.\d+)?(?:\xb1\d+(?:\.\d+)?)?$")
Y_TOL = 3.0


def parse_mean(token):
    if "\xb1" in token:
        return float(token.split("\xb1", 1)[0])
    return float(token)


def find_header_columns(words):
    """Return {code: x_center} for whichever header set appears on this page,
    read from the row of short bold-ish code tokens like 'AL' 'CA' 'FE' that
    sits directly above the 'mg'/'µg' unit row."""
    code_words = [w for w in words if w["text"] in ALL_CODES]
    if len(code_words) < 3:
        return None
    # they should all share (roughly) one y -- take the most common y cluster
    from collections import Counter
    y_round = Counter(round(w["top"]) for w in code_words)
    header_y = y_round.most_common(1)[0][0]
    cols = {}
    for w in code_words:
        if abs(w["top"] - header_y) <= Y_TOL:
            cols[w["text"]] = (w["x0"] + w["x1"]) / 2
    return cols if len(cols) >= 3 else None


def nearest_code(x, columns):
    best_code, best_dist = None, None
    for code, cx in columns.items():
        d = abs(x - cx)
        if best_dist is None or d < best_dist:
            best_code, best_dist = code, d
    return best_code, best_dist


def run():
    records_by_code = {}
    warnings = []
    current_columns = None

    with pdfplumber.open(PDF_PATH) as pdf:
        for page_idx in TABLE5_PAGES:
            page = pdf.pages[page_idx]
            words = page.extract_words()
            cols = find_header_columns(words)
            if cols:
                current_columns = cols
            if not current_columns:
                continue

            # group words by row using the food-code tokens as row anchors
            code_tokens = [w for w in words if FOOD_CODE_RE.match(w["text"])]
            for ct in code_tokens:
                row_y = ct["top"]
                row_words = [w for w in words if abs(w["top"] - row_y) <= Y_TOL]
                food_code = ct["text"]

                rec = records_by_code.setdefault(food_code, {
                    "food_code": food_code, "source": "IFCT2017_NIN_PDF", "basis": "raw",
                })
                if "food_name" not in rec:
                    # name = non-numeric words between the code and the first
                    # small region-count integer (1-6), same convention as Table 1
                    after = [w for w in row_words if w["x0"] > ct["x1"]]
                    after.sort(key=lambda w: w["x0"])
                    name_parts, region_found = [], False
                    for w in after:
                        t = w["text"]
                        if not region_found and t.isdigit() and 1 <= int(t) <= 6:
                            region_found = True
                            continue
                        if not region_found:
                            name_parts.append(t)
                    if name_parts:
                        rec["food_name"] = " ".join(name_parts)

                for w in row_words:
                    t = w["text"]
                    if not NUMERIC_RE.match(t):
                        continue
                    cx = (w["x0"] + w["x1"]) / 2
                    code, dist = nearest_code(cx, current_columns)
                    if code is None or dist > 25:  # too far from any known column center
                        continue
                    field = ALL_CODES[code]
                    if field in rec:
                        warnings.append(f"page {page_idx}: {food_code} duplicate value for {field}, keeping first")
                        continue
                    rec[field] = parse_mean(t)

    return list(records_by_code.values()), warnings


def main():
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    records, warnings = run()
    OUT_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(f"Extracted {len(records)} rows -> {OUT_PATH}")
    print(f"{len(warnings)} warnings (showing up to 15)")
    for w in warnings[:15]:
        print(" ", w)


if __name__ == "__main__":
    main()
