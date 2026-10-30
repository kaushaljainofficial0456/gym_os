# Wearable calorie reconciliation: device-aware validation and calibration

Status: **design only**. Nothing here changes production behaviour. Companion to
`docs/CALORIE_OVERHAUL_REPORT.md`.

## 1. What the code does today

`backend/src/services/health/reconciliation.js` `reconcileWorkout`:

| Situation | Number stored | `primarySource` | Confidence base (`confidence.js`) |
|---|---|---|---|
| A wearable workout record matches the session | median of matched wearables' `active_kcal` (+ BARBELL estimate for any uncovered minutes) | the wearable provider | **0.95** (`wearable_direct`) |
| No workout record, but HR/energy samples overlap | **BARBELL's own estimate** | **the wearable provider** | 0.70 (`wearable_physiological`) |
| No wearable evidence | BARBELL's estimate | `skos_ml` / provider | 0.50 |

Findings:
- **F1. Wearables always win when matched.** A wearable vs. BARBELL disagreement above 40%
  only sets `dataQualityFlag` and lowers confidence. The wearable number is still stored.
  Nothing anywhere shows wearable energy to be accurate for resistance training (§2), yet
  it gets the highest confidence in the system.
- **F2. Mislabelled provenance.** In the HR-only branch, the stored kcal is BARBELL's
  estimate, but `primarySource` names the wearable and confidence is raised from 0.50 to
  0.70. The HR samples are never used in the number. This is a labelling bug, separate
  from accuracy, and should be fixed in its own change.
- **F3. No device identity.** `health_records.provider` is the aggregator (`apple_health`,
  Health Connect, …), not the device or app that measured. An Apple Watch, a chest strap
  and a phone-only estimate all arrive as the same provider, so no per-device policy is
  possible from today's data.
- **F4. Gross vs net is trusted, not checked.** The schema separates `active_kcal` from
  `total_kcal`, which is correct. But reconciliation trusts each integration to fill
  `active_kcal` with net-of-resting energy, and vendors define "active" differently. No
  test checks this per provider.

## 2. What the evidence says (and how strong it is)

- Accelerometer and optical-HR energy models are built and validated mainly on
  ambulatory and steady-state cardio. Resistance training has low wrist acceleration
  during heavy sets and a heart rate that rises from pressor and recovery effects, not
  only from oxygen uptake. Both break the assumptions behind those models.
- One controlled study (PMC13120158/PMC13701894, transcribed earlier, **not re-verified**:
  full text unreachable from this environment) reported 141 kcal by calorimetry over a
  34 min 2×10RM session, against Apple 299, Garmin 305, Galaxy 258 and Fitbit 146.
  It is **unverified, n unknown, one protocol**. It does not show watches are always
  high, but nothing in our sources shows them accurate for lifting either.
- A 2020 circuit study (SenseWear/ActiTrainer, n = 6, per a search summary) found the
  opposite direction: under-estimation. **Device error for lifting is device- and
  protocol-specific in both sign and size.** A fixed correction factor would be wrong.

## 3. Proposed policy (to implement only after §4 data exists)

1. **Record device identity.** Add `source_device` / `source_app` (e.g. HealthKit
   `sourceRevision`, Health Connect `dataOrigin`) to `health_records`. This needs a
   schema migration, so it is out of scope here and needs owner sign-off.
2. **Default trust for resistance-training energy from any wearable: "corroborating",
   not "primary".** Store BARBELL's estimate as the primary figure and keep the wearable
   figure beside it (the columns already exist: `wearable_kcal`,
   `secondary_estimate_kcal`). The exceptions are devices that pass §4 for strength
   training.
3. **Disagreement is information, not an error flag.** Log the wearable/BARBELL ratio per
   device × activity type. Those logs feed §4.
4. **HR evidence is used or not claimed.** Until an HR-based model passes §4, the HR-only
   branch keeps BARBELL's estimate *and its own label and confidence* (fixes F2).
5. **Never sum** two wearables or a wearable and BARBELL for the same minutes (already
   true: median fusion and uncovered-minutes top-up).

## 4. Device-aware validation and calibration plan

**Ground truth:** portable indirect calorimetry (e.g. COSMED K5 / Cortex / Oxycon) over the
whole session, rests included. The gym's own wearable is not ground truth.

**Design.**
- **Unit of analysis:** device model × firmware family × activity mode (straight-set
  strength, circuit, machine-only).
- **Who:** participants wear their own device(s) plus the metabolic cart in a real
  BARBELL session logged in the app. Each session therefore yields calorimetry, device
  kcal, BARBELL's estimate and the full set log.
- **Size:** at least 20 participants per device model, both sexes, a spread of body mass
  and training age, two sessions each (one heavy straight-set, one dense). Fold this into
  the Phase 9 cohort (`ml/docs/PHASE9_STUDY_PROTOCOL.md`).
- **Metrics,** reported per device, with **participant-grouped** CIs (bootstrap over
  people, never over sessions):
  - Bland-Altman mean bias and 95% limits of agreement (net kcal)
  - MAPE
  - Lin's concordance correlation
  - The same metrics for BARBELL's estimate on the same sessions, so the comparison is
    paired.

**Gate for a device to become primary for strength sessions:**
- its MAPE is lower than BARBELL's on the same sessions, with the paired bootstrap CI of
  the difference excluding 0;
- its |bias| is ≤ 10%;
- the result holds in both straight-set and dense sessions.

**Calibration** is allowed only for a device that clears agreement in shape but not in
level (a stable proportional bias):
- a per-device linear recalibration, fitted with leave-one-participant-out validation;
- re-validated on every new device generation, because firmware changes the energy model;
- never extrapolated to device models without their own data.

**Monitoring after rollout:** the wearable/BARBELL ratio distribution per device, with an
alert if the median shifts by more than 15% between firmware versions.

## 5. What not to do

- Do not fit a correction from production wearable vs. BARBELL disagreements. Neither
  number is ground truth, so the fit would make one estimate copy the other.
- Do not raise confidence because a wearable agrees with BARBELL. Agreement between two
  estimates that share biases (e.g. both scale with body mass) is not validation.
