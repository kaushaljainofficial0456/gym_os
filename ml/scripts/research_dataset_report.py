"""
Validate a calorimetry research dataset directory and print its quality
report and evidence gates. Optionally write blank CSV templates.

  python -I ml/scripts/research_dataset_report.py <dir>            validate + report
  python -I ml/scripts/research_dataset_report.py --templates <dir> write empty templates

Never reads the production database.
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'src'))

from research import load_dataset  # noqa: E402
from research.features import build_session_table  # noqa: E402
from research.models import GATES, check_gate  # noqa: E402
from research.quality import quality_report  # noqa: E402
from research.schema import TABLES, template_header  # noqa: E402
from research.validate import errors, validate  # noqa: E402


def write_templates(directory):
    os.makedirs(directory, exist_ok=True)
    for table in TABLES:
        with open(os.path.join(directory, f'{table}.csv'), 'w', newline='') as f:
            csv.writer(f).writerow(template_header(table))


def main(argv):
    if len(argv) == 2 and argv[0] == '--templates':
        write_templates(argv[1])
        print(f'templates written to {argv[1]}')
        return 0
    if len(argv) != 1:
        print(__doc__)
        return 2
    ds = load_dataset(argv[0])
    issues = validate(ds)
    sessions = build_session_table(ds, issues, use='research') if len(ds['sessions']) else None
    for i in errors(issues)[:50]:
        print(f'ERROR {i.table}:{i.key} {i.rule} -- {i.message}')
    if sessions is not None and len(sessions):
        rep = quality_report(ds, issues, sessions)
        rep.pop('missingness')
        print(json.dumps(rep, indent=2, default=str))
        for level in GATES:
            g = check_gate(sessions, level)
            print(f'gate {level}: {"PASS" if g.passed else "not met"} {g.counts} {g.shortfalls}')
    else:
        print('no usable sessions')
    return 1 if errors(issues) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
