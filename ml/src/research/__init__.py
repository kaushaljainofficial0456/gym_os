"""BARBELL calorimetry research dataset: schema, validation, provenance,
quality reporting, leakage-safe splits and the evidence-gated model harness.
See docs/CALORIMETRY_RESEARCH_PROTOCOL.md."""
import os

import pandas as pd

from .schema import TABLES, template_header


def load_dataset(directory):
    """Reads <table>.csv for every schema table present in `directory`."""
    ds = {}
    for table in TABLES:
        path = os.path.join(directory, f'{table}.csv')
        ds[table] = pd.read_csv(path) if os.path.exists(path) else pd.DataFrame(columns=template_header(table))
    return ds
