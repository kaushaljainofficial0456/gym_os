"""
Energy from gas exchange, with the app's gross/net definitions.

  gross kcal = 3.941 * VO2 (L) + 1.106 * VCO2 (L)          abbreviated Weir (1949)
  net kcal   = gross kcal - measured resting kcal/min * session minutes

Resting must be MEASURED (a seated baseline before the session) for a
criterion net figure. A predicted resting rate is allowed only as a flagged
fallback, so a net value is never presented as fully measured when it is not.

Indirect calorimetry misses part of the anaerobic cost of lifting; that is a
known limitation of the criterion and is recorded, not corrected, here.
"""

WEIR_O2 = 3.941
WEIR_CO2 = 1.106
RER_PLAUSIBLE = (0.67, 1.30)  # outside => gas-analysis or steady-state problem


def gross_kcal_from_gas(vo2_l, vco2_l):
    if vo2_l is None or vco2_l is None:
        raise ValueError('gross energy needs both VO2 and VCO2; a VO2-only figure would assume an RER')
    if vo2_l <= 0 or vco2_l <= 0:
        raise ValueError('gas volumes must be positive')
    return WEIR_O2 * vo2_l + WEIR_CO2 * vco2_l


def rer(vo2_l, vco2_l):
    return vco2_l / vo2_l if vo2_l else None


def net_kcal(gross_kcal, session_minutes, resting_kcal_per_min=None, predicted_resting_kcal_per_min=None):
    """Returns (net_kcal, resting_source). resting_source is 'measured',
    'predicted' (flag it) or None when neither is available."""
    if resting_kcal_per_min is not None:
        return gross_kcal - resting_kcal_per_min * session_minutes, 'measured'
    if predicted_resting_kcal_per_min is not None:
        return gross_kcal - predicted_resting_kcal_per_min * session_minutes, 'predicted'
    return None, None


def mifflin_st_jeor_kcal_per_min(weight_kg, height_cm, age_years, sex):
    """Same formula the app uses (backend restingEnergy.js) -- the flagged fallback only."""
    if sex not in ('male', 'female'):
        return None
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age_years + (5 if sex == 'male' else -161)
    return bmr / 1440
