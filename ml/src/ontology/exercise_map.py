"""
Canonical exercise ontology — maps every raw study label to one canonical
exercise_id, matching the naming convention Kaushal's backend contract uses
(UPPER_SNAKE_CASE). Original labels are always preserved alongside the
canonical id in the harmonized dataset — never overwritten.

Some canonical ids here go beyond Kaushal's illustrative example list
(BENCH_PRESS, BARBELL_SQUAT, LAT_PULLDOWN, ...) because the research data
uses machine/isolation exercises his examples didn't cover. These are
proposed additions to the shared ontology, not assumptions about what
already exists in exercise_library — flag for his review before treating
them as final.

CAUTION: "Squat"/"half squat" here is a bench-mounted 45deg or standard
half-squat protocol per Reis et al., NOT necessarily equivalent to a full
barbell back squat as SK OS users perform it. Mapped to BARBELL_SQUAT for
now with variant metadata preserved — this is an approximation, documented
here rather than silently assumed.
"""

EXERCISE_MAP = {
    # raw label (lowercased, whitespace-normalized) -> canonical_id
    "biceps": "BICEP_CURL",
    "triceps": "TRICEPS_EXTENSION",
    "squat": "BARBELL_SQUAT",
    "half squat": "BARBELL_SQUAT",
    "leg press": "LEG_PRESS",
    "bench press": "BENCH_PRESS",
    "inclined bp": "INCLINE_BENCH_PRESS",
    "inclined bench press": "INCLINE_BENCH_PRESS",
    "lat pull down": "LAT_PULLDOWN",
    "leg extension": "LEG_EXTENSION",
}

# Exercises whose canonical_id is a documented approximation, not an exact
# equivalence to the SK OS exercise_library entry of the same name.
EXERCISE_VARIANT_NOTES = {
    "BARBELL_SQUAT": (
        "Source studies used a 'half squat' protocol on a guided/Smith-type "
        "rig, not a free barbell back squat to full depth. Energy-cost "
        "values may not transfer 1:1 to SK OS's BARBELL_SQUAT if that exercise "
        "is logged as a free-weight full-depth squat."
    ),
}

# Attribute lookup mirroring the categories the PRODUCTION calorie contract
# actually sends per exercise (muscle_group ids from backend/src/services/
# muscles.js, compound_or_isolation from calorieModel.js: classifyCompound()).
# Hand-assigned per canonical exercise here — never invented per-row, since
# none of the 3 source studies label muscle_group/compound_or_isolation
# themselves, only the exercise name.
EXERCISE_ATTRIBUTES = {
    "BENCH_PRESS":         {"muscle_group": "chest",       "movement_pattern": "horizontal_push", "compound_or_isolation": "compound"},
    "INCLINE_BENCH_PRESS": {"muscle_group": "upper_chest",  "movement_pattern": "horizontal_push", "compound_or_isolation": "compound"},
    "BARBELL_SQUAT":       {"muscle_group": "quads",        "movement_pattern": "squat",           "compound_or_isolation": "compound"},
    "LEG_PRESS":           {"muscle_group": "quads",        "movement_pattern": "squat",           "compound_or_isolation": "compound"},
    "LEG_EXTENSION":       {"muscle_group": "quads",        "movement_pattern": "isolation",       "compound_or_isolation": "isolation"},
    "LAT_PULLDOWN":        {"muscle_group": "lats",         "movement_pattern": "vertical_pull",   "compound_or_isolation": "compound"},
    "BICEP_CURL":          {"muscle_group": "biceps",       "movement_pattern": "isolation",       "compound_or_isolation": "isolation"},
    "TRICEPS_EXTENSION":   {"muscle_group": "triceps",      "movement_pattern": "isolation",       "compound_or_isolation": "isolation"},
}


def get_attributes(canonical_id: str) -> dict:
    if canonical_id not in EXERCISE_ATTRIBUTES:
        raise KeyError(f"No attribute mapping for canonical exercise {canonical_id!r}")
    return EXERCISE_ATTRIBUTES[canonical_id]


def normalize_exercise_label(raw_label: str) -> str:
    return " ".join(str(raw_label).strip().lower().split())


def to_canonical(raw_label: str) -> str:
    key = normalize_exercise_label(raw_label)
    if key not in EXERCISE_MAP:
        raise KeyError(
            f"No canonical mapping for exercise label {raw_label!r} "
            f"(normalized: {key!r}). Add it to EXERCISE_MAP explicitly — "
            f"never guess a mapping silently."
        )
    return EXERCISE_MAP[key]
