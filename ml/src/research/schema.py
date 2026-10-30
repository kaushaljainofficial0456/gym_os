"""
BARBELL calorimetry research dataset -- table definitions.

This dataset lives OUTSIDE the production database. It holds research
sessions collected under the protocol in docs/CALORIMETRY_RESEARCH_PROTOCOL.md:
pseudonymous participants, consent records, devices, sessions, set-level
logs and energy measurements, each with provenance.

Every energy figure carries a `measurement_tier`. Only the two criterion
tiers are ground truth, and only when their quality checks pass. Wearable
figures, user reports and model outputs are stored for comparison, never as
targets.

Energy definitions (same as the app, docs/calorie-model-contract.md s3):
  gross_kcal  total energy expended over the interval
  resting_kcal  the participant's MEASURED resting rate x interval duration
  net_kcal    gross_kcal - resting_kcal  (= "active" energy in the app)
"""

# ---- measurement tiers ------------------------------------------------
CRITERION_TIERS = ('criterion_lab', 'criterion_portable')
MEASUREMENT_TIERS = CRITERION_TIERS + ('wearable_estimate', 'user_reported', 'model_estimate')
TIER_MEANING = {
    'criterion_lab': 'stationary metabolic cart, breath-by-breath or mixing chamber, calibrated per session',
    'criterion_portable': 'validated portable metabolic analyser (e.g. K5, MetaMax), calibrated per session',
    'wearable_estimate': "a consumer device's own calorie algorithm -- never ground truth",
    'user_reported': 'typed or recalled by the participant',
    'model_estimate': 'output of a BARBELL or third-party model',
}

EXERCISE_CATEGORIES = ('compound_lower', 'compound_upper_push', 'compound_upper_pull', 'isolation_upper',
                       'isolation_lower', 'core', 'olympic', 'carry', 'bodyweight', 'machine_other')
SEXES = ('female', 'male', 'intersex', 'prefer_not_to_say')
TRAINING_STATUS = ('novice', 'intermediate', 'trained', 'highly_trained')
SESSION_KINDS = ('straight_sets', 'supersets', 'circuit', 'mixed')
QC_STATUS = ('pass', 'fail', 'not_checked')
CONSENT_SCOPES = ('collection', 'research_analysis', 'commercial_model_training', 'data_sharing_partner', 'retention_extended')


def col(name, kind, required=False, allowed=None, lo=None, hi=None, unit=None, note=''):
    return dict(name=name, kind=kind, required=required, allowed=allowed, lo=lo, hi=hi, unit=unit, note=note)


TABLES = {
    'studies': [
        col('study_id', 'id', True),
        col('site', 'text', True, note='lab / institution running the session'),
        col('protocol_version', 'text', True),
        col('ethics_reference', 'text', True, note='approval number from the ethics committee; no data without one'),
        col('licence', 'text', True, note='terms under which BARBELL may use the data'),
        col('is_synthetic', 'bool', True, note='1 only for test fixtures; never counted as evidence'),
        # Lactate -> energy conversion, fixed per study BEFORE analysis and
        # reported with results (energy.anaerobic_kcal has no default).
        col('lactate_o2_equiv_ml_per_kg_per_mmol', 'float', lo=0.5, hi=10, note='O2-equivalent of a 1 mmol/L blood-lactate rise, per kg'),
        col('lactate_kcal_per_l_o2', 'float', lo=4.0, hi=5.5),
        col('lactate_conversion_source', 'text', note='citation for both values above'),
    ],
    'participants': [
        col('participant_id', 'pseudonym', True, note='random code; the key linking it to a person stays with the site'),
        col('study_id', 'id', True),
        col('cross_study_key', 'text', note='salted hash supplied by the site so one person in two studies is detectable; never a name'),
        col('age_years', 'int', True, lo=16, hi=90),
        col('sex', 'enum', True, allowed=SEXES),
        col('height_cm', 'float', True, lo=120, hi=230, unit='cm'),
        col('training_status', 'enum', allowed=TRAINING_STATUS),
        col('training_years', 'float', lo=0, hi=60),
        col('fat_mass_kg', 'float', lo=1, hi=150, unit='kg', note='DXA/BIA; method in body_comp_method'),
        col('body_comp_method', 'text'),
    ],
    'consents': [
        col('participant_id', 'pseudonym', True),
        col('study_id', 'id', True),
        col('consent_version', 'text', True),
        col('consented_at', 'date', True),
        col('scopes', 'list', True, allowed=CONSENT_SCOPES),
        col('withdrawn_at', 'date', note='set => all of this participant\'s data is excluded and scheduled for deletion'),
    ],
    'devices': [
        col('device_id', 'id', True),
        col('tier', 'enum', True, allowed=MEASUREMENT_TIERS),
        col('make_model', 'text', True),
        col('firmware', 'text'),
        col('validation_reference', 'text', note='published validation of this analyser, for criterion tiers'),
    ],
    'sessions': [
        col('session_id', 'id', True),
        col('study_id', 'id', True),
        col('participant_id', 'pseudonym', True),
        col('session_date', 'date', True),
        col('body_mass_kg', 'float', True, lo=35, hi=250, unit='kg', note='measured on the day, not self-reported'),
        col('session_kind', 'enum', True, allowed=SESSION_KINDS),
        col('started_at', 'datetime', True, note='first working set start; warm-up excluded'),
        col('ended_at', 'datetime', True, note='last working set end'),
        col('session_rpe', 'float', lo=0, hi=10, note='CR-10 session RPE, asked 30 min after the session'),
        col('fasted_hours', 'float', lo=0, hi=48),
        col('caffeine_last_6h', 'bool'),
        col('notes', 'text'),
    ],
    'sets': [
        col('session_id', 'id', True),
        col('set_index', 'int', True, lo=1, hi=200),
        col('exercise_name', 'text', True),
        col('exercise_category', 'enum', True, allowed=EXERCISE_CATEGORIES),
        col('is_warmup', 'bool', True),
        col('reps', 'int', True, lo=0, hi=200),
        col('load_kg', 'float', True, lo=0, hi=600, unit='kg', note='external load; 0 for bodyweight'),
        col('set_started_at', 'datetime', True),
        col('set_ended_at', 'datetime', True),
        col('rir', 'float', lo=0, hi=10),
        col('set_rpe', 'float', lo=0, hi=10),
    ],
    'measurements': [
        col('measurement_id', 'id', True),
        col('session_id', 'id', True),
        col('device_id', 'id', True),
        col('tier', 'enum', True, allowed=MEASUREMENT_TIERS),
        col('interval', 'enum', True, allowed=('resting_baseline', 'session', 'recovery_epoc')),
        col('interval_start', 'datetime', True),
        col('interval_end', 'datetime', True),
        col('vo2_l', 'float', lo=0, hi=500, unit='L', note='total O2 over the interval (criterion tiers)'),
        col('vco2_l', 'float', lo=0, hi=500, unit='L'),
        col('gross_kcal', 'float', lo=0, hi=5000, unit='kcal', note='criterion: computed by energy.py from VO2/VCO2; others: as reported'),
        col('reported_kcal_kind', 'enum', allowed=('gross', 'net_active', 'unknown'), note='what a device/user figure claims to be'),
        col('mean_hr_bpm', 'float', lo=30, hi=230),
        col('lactate_pre_mmol', 'float', lo=0.3, hi=30, unit='mmol/L', note='capillary blood, immediately before the first working set'),
        col('lactate_post_mmol', 'float', lo=0.3, hi=30, unit='mmol/L', note='peak of the post-session samples'),
        col('lactate_post_delay_min', 'float', lo=0, hi=15, note='minutes after the last set at which the peak was taken'),
        col('lactate_method', 'text', note='analyser make/model'),
        col('calibrated_at', 'datetime', note='gas and flow calibration before this session (criterion tiers)'),
        col('qc_status', 'enum', True, allowed=QC_STATUS),
        col('qc_notes', 'text'),
    ],
}

# Columns that must never appear in this dataset (direct identifiers).
FORBIDDEN_COLUMNS = ('name', 'first_name', 'last_name', 'full_name', 'email', 'phone', 'address',
                     'date_of_birth', 'dob', 'national_id', 'ip_address', 'user_id', 'client_id')

TABLE_KEYS = {
    'studies': ('study_id',), 'participants': ('participant_id',), 'consents': ('participant_id', 'consent_version'),
    'devices': ('device_id',), 'sessions': ('session_id',), 'sets': ('session_id', 'set_index'),
    'measurements': ('measurement_id',),
}


def template_header(table):
    return [c['name'] for c in TABLES[table]]
