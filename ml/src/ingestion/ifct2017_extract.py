"""
Extract Table 1 (PROXIMATE PRINCIPLES AND DIETARY FIBRE) from the
PRIMARY NIN/ICMR IFCT 2017 PDF (nin.res.in/ebooks/IFCT2017.pdf) --
deliberately NOT the AGPL-3.0 github.com/ifct2017/compositions repo
(see ml/docs/ for the licensing decision).

Deterministic extraction only -- no LLM summarization of numeric
values, since a transcription error here would silently corrupt
calorie/macro numbers shipped to real users. Every row is validated
structurally (food code pattern) and a sample is spot-checked by hand
against the source PDF before this data is trusted anywhere downstream.

IFCT 2017 book preface (p.4, extracted below in main()):
"Except for eggs, all other food component data are for foods in the
RAW form." -- this table is RAW-basis. Cooked conversion is a separate
step using USDA SR Legacy retention_factor.csv (already downloaded),
NOT invented here.

Table 1 spans PDF pages 40-67 (0-indexed), per the book's own table of
contents (p.6) cross-checked directly against page content.
"""
import re
import json
from pathlib import Path

import pdfplumber

PDF_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "food_v1" / "ifct" / "IFCT2017_NIN.pdf"
OUT_PATH = Path(__file__).resolve().parents[2] / "data" / "processed" / "ifct2017_table1_proximate.json"

TABLE1_PAGES = range(40, 68)  # 0-indexed, inclusive-exclusive -> pages 40..67

# Known nutrient column codes for Table 1 (varies by food group -- fish
# pages omit fibre columns entirely). Order is read per-page from the
# header row actually printed on that page, not assumed fixed.
KNOWN_NUTRIENT_CODES = {
    "WATER": "moisture_g",
    "PROTCNT": "protein_g",
    "ASH": "ash_g",
    "FATCE": "fat_g",
    "FIBTG": "fiber_total_g",
    "FIBINS": "fiber_insoluble_g",
    "FIBSOL": "fiber_soluble_g",
    "CHOAVLDF": "carb_by_difference_g",
    "ENERC": "energy_kj",
}

# ------------------------------------------------------------------
# Manually verified corrections / flags, found by cross-checking every
# extracted ENERC value against its Atwater-estimated energy (protein_g*17
# + fat_g*37 + carb_g*17 kJ) and hand-inspecting outliers via pdfplumber
# extract_words() x/y positions (bypasses extract_table()'s heuristic
# column-splitting, which is what actually caused the L003 bug below).
# Never apply a blanket "fix" without this kind of row-level verification.
# ------------------------------------------------------------------
MANUAL_CORRECTIONS = {
    # L003 Paneer: extract_table() split the printed token "1278\xb161" into
    # "1" (stranded onto the previous CHOAVLDF cell as "2.41\xb10.12 1") and
    # "278\xb161". Verified via extract_words() on page 56: the true
    # single token at x0=767.0 is "1278\xb161". Atwater estimate from this
    # row's own protein/fat (18.86g/24.78g) is ~1238 kJ -- 1278 fits;
    # 278 (~66 kcal/100g for a 25g-fat cheese) does not.
    "L003": {"energy_kj": 1278.0, "energy_kj_sd": 61.0},
}

# Rows where the extracted number IS what the source PDF prints (verified
# via extract_words(), not an extraction bug) but it fails an internal
# consistency check against neighboring rows / Atwater estimate. Flagged
# as a suspected error in the PRIMARY SOURCE itself -- not corrected,
# since correcting would mean guessing a replacement value with no basis.
SUSPECTED_SOURCE_ANOMALIES = {
    # N001 Chicken leg, skinless: ENERC=1605kJ (~384kcal/100g) vs this row's
    # own Atwater estimate of ~798kJ (~191kcal/100g), and vs neighboring
    # rows N002 thigh (836kJ, fits its own Atwater estimate) and N003
    # breast (704kJ, fits) which both check out cleanly. N001 has LESS fat
    # than N002 thigh (12.64g vs 14.23g) yet reports ~2x the energy --
    # physically inconsistent. Verified "1605" is genuinely what's printed
    # (extract_words() on page 57, x0=698.4) so this isn't an extraction
    # bug; most likely a typesetting error in the original NIN publication.
    "N001": "energy_kj value (1605 kJ) is physically inconsistent with this row's own protein/fat "
            "(Atwater estimate ~798kJ) and with neighboring cuts N002/N003 which both check out -- "
            "flagged as a likely error in the source PDF itself, not used as-is.",
}

FOOD_CODE_RE = re.compile(r"^[A-Z]\d{3}$")
VALUE_RE = re.compile(r"^-?\d+(?:\.\d+)?(?:\xb1\d+(?:\.\d+)?)?$")  # "22.49\xb10.58" or bare number


def parse_value(cell):
    """'22.49\xb10.58' -> (22.49, 0.58). Bare '48.47' -> (48.47, None). '' -> (None, None)."""
    cell = (cell or "").strip()
    if not cell:
        return None, None
    if "\xb1" in cell:
        mean, sd = cell.split("\xb1", 1)
        try:
            return float(mean), float(sd)
        except ValueError:
            return None, None
    try:
        return float(cell), None
    except ValueError:
        return None, None


def header_order_for_page(rows):
    """Scan a page's extracted rows for the header row and return the
    ordered list of nutrient codes actually present on this page.
    Cells can merge multiple codes with no separating space detected
    by the text-strategy column splitter (e.g. 'FATCE FIBTG FIBINS
    FIBSOL' as one cell) -- tokenize each cell, don't match whole-cell."""
    for row in rows:
        tokens = []
        for c in row:
            if c and c.strip():
                tokens.extend(c.strip().split())
        found = [t for t in tokens if t in KNOWN_NUTRIENT_CODES]
        if len(found) >= 3:  # a real header row, not a stray match
            return found
    return None


def extract_table1():
    records = []
    warnings = []
    current_header = None

    with pdfplumber.open(PDF_PATH) as pdf:
        for page_idx in TABLE1_PAGES:
            page = pdf.pages[page_idx]
            rows = page.extract_table(table_settings={"vertical_strategy": "text", "horizontal_strategy": "text"})
            if not rows:
                warnings.append(f"page {page_idx}: no table extracted")
                continue

            hdr = header_order_for_page(rows)
            if hdr:
                current_header = hdr
            if not current_header:
                warnings.append(f"page {page_idx}: no header found yet, skipping data rows")
                continue

            for row in rows:
                cells = [c.strip() if c else "" for c in row]
                # data rows: find the food-code cell anywhere in the row
                code_idx = None
                for i, c in enumerate(cells):
                    if FOOD_CODE_RE.match(c):
                        code_idx = i
                        break
                if code_idx is None:
                    continue

                food_code = cells[code_idx]
                # name is the next non-empty cell(s) after the code, up to the region-count integer
                rest = cells[code_idx + 1:]
                rest = [c for c in rest if c != ""]
                if not rest:
                    continue
                # region count is a small bare integer (1-6); find it to split name from values
                region_idx = None
                for i, c in enumerate(rest):
                    if c.isdigit() and 1 <= int(c) <= 6 and i > 0:
                        region_idx = i
                        break
                if region_idx is None:
                    warnings.append(f"page {page_idx}: {food_code} - could not find region marker, skipping")
                    continue

                name = " ".join(rest[:region_idx]).strip()
                region_count = int(rest[region_idx])
                values = rest[region_idx + 1:]

                header_for_row = current_header
                if len(values) != len(current_header):
                    # The source PDF leaves a cell blank for "below detectable
                    # limit" (stated explicitly in the table's own caption) and
                    # blank cells produce no token at all in text-strategy
                    # extraction -- so a genuinely-absent nutrient silently
                    # shortens the row instead of leaving an empty slot.
                    # Only recover this when the shortfall exactly matches a
                    # contiguous FIBTG/FIBINS/FIBSOL run (fibre is the nutrient
                    # legitimately absent most often, e.g. milk/eggs/meat) --
                    # never guess which OTHER column went missing.
                    fib_codes = ["FIBTG", "FIBINS", "FIBSOL"]
                    if (
                        len(current_header) - len(values) == len(fib_codes)
                        and all(f in current_header for f in fib_codes)
                    ):
                        header_for_row = [c for c in current_header if c not in fib_codes]
                    else:
                        warnings.append(
                            f"page {page_idx}: {food_code} '{name}' - {len(values)} values but "
                            f"{len(current_header)} header cols ({current_header}); skipping"
                        )
                        continue

                rec = {
                    "food_code": food_code,
                    "food_name": name,
                    "region_count": region_count,
                    "source": "IFCT2017_NIN_PDF",
                    "basis": "raw",
                    "page": page_idx,
                }
                for code in current_header:
                    field = KNOWN_NUTRIENT_CODES[code]
                    rec.setdefault(field, None)
                    rec.setdefault(field + "_sd", None)
                for code, val in zip(header_for_row, values):
                    mean, sd = parse_value(val)
                    field = KNOWN_NUTRIENT_CODES[code]
                    rec[field] = mean
                    rec[field + "_sd"] = sd

                if food_code in MANUAL_CORRECTIONS:
                    rec.update(MANUAL_CORRECTIONS[food_code])
                    rec["manually_corrected"] = True
                if food_code in SUSPECTED_SOURCE_ANOMALIES:
                    rec["suspected_source_anomaly"] = SUSPECTED_SOURCE_ANOMALIES[food_code]

                records.append(rec)

    return records, warnings


def main():
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    records, warnings = extract_table1()
    OUT_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")
    print(f"Extracted {len(records)} rows -> {OUT_PATH}")
    print(f"{len(warnings)} warnings")
    for w in warnings[:30]:
        print(" ", w)
    if len(warnings) > 30:
        print(f"  ... and {len(warnings) - 30} more")


if __name__ == "__main__":
    main()
