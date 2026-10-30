"""
Energy components of a resistance-training session, and the exact gross /
net definitions BARBELL uses. Definitions: docs/CALORIE_ENERGY_DEFINITIONS.md.

Intervals (all from timestamps, never assumed):
  baseline  the last 10 min of a >= 15 min seated rest before the session
  session   first working-set start -> last working-set end; warm-up excluded,
            rests BETWEEN sets included
  recovery  last working-set end -> end of post-session measurement

Components:
  aerobic_gross   Weir(VO2, VCO2) over the session window  [kcal]
  resting         measured resting rate (kcal/min, Weir over the baseline)
                  x session minutes                        [kcal]
  aerobic_net     aerobic_gross - resting
  anaerobic       glycolytic energy during the session, from the rise in
                  blood lactate (post - pre) -- PART of the workout's cost
  post_exercise   Weir over the recovery window - resting x recovery minutes
                  (EPOC after the last set; recorded, NOT in the displayed figure)

Product figures:
  workout_net   = aerobic_net + anaerobic        <- what the app's estimate targets
  workout_gross = aerobic_gross + anaerobic

The lactate -> energy conversion needs an O2-equivalent per mmol/L of
lactate per kg body mass. Published conventions exist but their value and
validity for resistance exercise are debated, so this module has NO default:
every study must state the value and its source before analysis, and it is
reported with the results. Likewise nothing here applies a fixed anaerobic
percentage: the share differs by protocol (load, sets, rest) and is measured
per session, never assumed.
"""

WEIR_O2 = 3.941          # kcal per L O2   (Weir 1949, abbreviated)
WEIR_CO2 = 1.106         # kcal per L CO2
RER_PLAUSIBLE = (0.67, 1.30)  # outside => gas-analysis or steady-state problem
KCAL_PER_L_O2_FOR_LACTATE = None  # must be supplied with its source; see anaerobic_kcal


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


def anaerobic_kcal(lactate_pre_mmol, lactate_post_mmol, body_mass_kg, o2_equiv_ml_per_kg_per_mmol, kcal_per_l_o2, source):
    """Glycolytic energy from the session's blood-lactate rise.

    energy = max(0, post - pre) [mmol/L] x O2-equivalent [mL O2 / kg / (mmol/L)]
             x body mass [kg] / 1000 x kcal per L O2

    Both conversion factors and their `source` are REQUIRED arguments: no
    default is assumed. A post value below pre gives 0, not a negative.
    Returns (kcal, note)."""
    if None in (lactate_pre_mmol, lactate_post_mmol, body_mass_kg):
        return None, 'missing lactate or body mass'
    if not (o2_equiv_ml_per_kg_per_mmol and kcal_per_l_o2 and source):
        raise ValueError('lactate conversion needs an O2-equivalent, a kcal/L O2 value and their source; none is assumed')
    rise = lactate_post_mmol - lactate_pre_mmol
    note = 'lactate fell over the session' if rise < 0 else None
    return max(0.0, rise) * o2_equiv_ml_per_kg_per_mmol * body_mass_kg / 1000 * kcal_per_l_o2, note


def session_components(*, session_vo2_l, session_vco2_l, session_minutes,
                       resting_kcal_per_min=None, predicted_resting_kcal_per_min=None,
                       anaerobic=None, recovery_vo2_l=None, recovery_vco2_l=None, recovery_minutes=None):
    """All components for one session. `anaerobic` is anaerobic_kcal()'s
    kcal or None. Returns a dict; a component that cannot be computed is
    None, never zero."""
    aerobic_gross = gross_kcal_from_gas(session_vo2_l, session_vco2_l)
    aerobic_net, resting_source = net_kcal(aerobic_gross, session_minutes, resting_kcal_per_min, predicted_resting_kcal_per_min)
    rest_rate = resting_kcal_per_min if resting_kcal_per_min is not None else predicted_resting_kcal_per_min
    post = None
    if recovery_vo2_l and recovery_vco2_l and recovery_minutes and rest_rate is not None:
        post = gross_kcal_from_gas(recovery_vo2_l, recovery_vco2_l) - rest_rate * recovery_minutes
    session_rer = rer(session_vo2_l, session_vco2_l)
    return dict(
        aerobic_gross=aerobic_gross,
        resting=None if rest_rate is None else rest_rate * session_minutes,
        resting_source=resting_source,
        aerobic_net=aerobic_net,
        anaerobic=anaerobic,
        workout_net=None if aerobic_net is None or anaerobic is None else aerobic_net + anaerobic,
        workout_gross=None if anaerobic is None else aerobic_gross + anaerobic,
        post_exercise=post,
        session_rer=session_rer,
        # Above 1.0, part of the CO2 comes from buffering lactate, not from
        # oxidising fuel, and Weir's VCO2 term then over-counts. Flagged for
        # sensitivity analysis (VO2-only alternative), never silently corrected.
        rer_above_1=session_rer is not None and session_rer > 1.0,
    )
