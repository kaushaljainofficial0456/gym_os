"""Check that the catalogue covers every approved feature and nothing else.
Approved = ● or ◇ rows in BARBELL_Feature_Audit.md; excluded = ◐ rows.
Usage: python3 docs/sales/catalogue-src/check-coverage.py"""
import re, pathlib, sys
root = pathlib.Path(__file__).resolve().parent.parent
audit = (root / 'BARBELL_Feature_Audit.md').read_text()
html = (root / 'BARBELL_Feature_Catalogue_Source.html').read_text()
approved, partial = set(), set()
for line in audit.splitlines():
    m = re.match(r'\| ([COTS]\d+) \| .*?\| (●|◇|◐)', line)
    if m:
        (partial if m.group(2) == '◐' else approved).add(m.group(1))
covered = set()
for attr in re.findall(r'data-covers="([^"]+)"', html):
    covered.update(attr.split())
missing = sorted(approved - covered, key=lambda x: (x[0], int(x[1:])))
leaked = sorted(partial & covered)
unknown = sorted(covered - approved - partial)
print(f'approved {len(approved)} | partial {len(partial)} | covered {len(covered)}')
print('missing:', missing or 'none'); print('partial leaked:', leaked or 'none'); print('unknown ids:', unknown or 'none')
sys.exit(1 if (missing or leaked or unknown) else 0)
