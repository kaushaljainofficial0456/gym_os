# Stage 3 implementation report: calorie evidence infrastructure

Branch `calorie-overhaul`. Not merged, not deployed, no production data touched.

**The production calorie formula is unchanged:** `calorieModel.js` estimates exactly what it did
on `main`. Stage 3 builds the means to get better evidence; it does not ship a new model.

## What was built

### 1. Wearable reconciliation: BARBELL's estimate is primary for strength sessions

Product decision, documented in `docs/WEARABLE_RECONCILIATION_DECISION.md`.

**Behaviour**
- **Wearable figures.** For strength sessions, the wearable figure is kept separately with:
  - provider, device and app;
  - measurement type and coverage;
  - a same-interval disagreement ratio and a flag above 40%.
- **What the wearable never does:** become primary, get summed or averaged, or raise
  confidence.
- **Heart-rate-only samples** are recorded as evidence and never named as the source. This
  fixes the mislabelling (F2) in both the strength and non-strength paths.
- **Non-strength, wearable-only and whole-day reconciliation:** unchanged.

**Data**
- Device and app identity come from HealthKit and Health Connect payloads where the bridge
  sends them; null otherwise, never inferred.
- Additive migration: 2 columns on `health_records`, 10 on `health_canonical_workouts`.
- Existing rows are not rewritten. Past days update when re-reconciled; whether to backfill
  is an owner decision before deploy.

**App:** the post-workout summary and burn detail show BARBELL's figure. The watch's figure
appears beside it as "its own estimate, not counted", and is no longer labelled measured.

### 2. Estimate qualification for the workout page (Objective 6)

**API.** Every calorie object the API returns now carries:
- `basis: 'model_estimate'`;
- `reliability`: `low` for baseline, `very_low` for the ml provider, `demo` for mock;
- `reliability_reasons`.

Reasons cover:
- not validated for full sessions;
- the ±25% band is not calibrated;
- a "hard" session may be over-estimated;
- duration estimated rather than timed;
- planned, not performed.

**Rules**
- These fields are read-only: the numbers are untouched.
- **There is no "high" level.** One has to be earned under `docs/CALORIE_MODEL_RESEARCH_PLAN.md` §6.
- **Where it appears:** the summary labels the figure "rough estimate" and lists the reasons.
  The range is hidden when it doesn't exist, which fixes the old "range –" for wearable rows.

### 3. Research dataset infrastructure (Objectives 1 and 4): `ml/src/research/`

| Module | Does |
|---|---|
| `schema.py` | 7 tables, units, ranges, provenance tiers, consent scopes, forbidden identifier columns |
| `validate.py` | identity, consent, reference, timing and gas-exchange rules (errors exclude rows) |
| `energy.py` | Weir gross; net from **measured** resting, else flagged `predicted` |
| `features.py` | one row per session with work, rest, density, composition and load as separate features; criterion target; wearable / user / model figures as comparison columns only; consent-scope filtering |
| `quality.py` | independent people, studies, sites, sessions, exercise coverage, missingness, QC, tiers, people seen in two studies, PSI distribution shift vs app aggregates |
| `splits.py` | person-grouped folds and leave-one-study-out, with leakage asserted |
| `models.py` | production baseline, calibrated baseline, hierarchical regression, LightGBM, each behind a pre-registered evidence gate; synthetic runs marked `evidence: False` |
| `scripts/research_dataset_report.py` | validate + report a dataset directory; write templates (`ml/data/research_templates/`) |

### 4. Research protocol and model plan (Objectives 2 and 3)

- `docs/CALORIMETRY_RESEARCH_PROTOCOL.md`: criterion definitions, capture list, validation
  rules, inclusion criteria, visit workflow, session templates that vary density within a
  person, partnership routes, a 20-person / 40-session pilot, consent and privacy.
- `docs/CALORIE_MODEL_RESEARCH_PLAN.md`: seven-component architecture, candidates in order,
  gates, metrics, and the fixed decision rule for production.

## Tests

Every new data flow has tests. All synthetic test data is flagged and never counted as
evidence.

| Area | File | Count |
|---|---|---|
| Reconciliation decision | `backend/test/healthReconciliation.test.js` | 23 (10 new strength cases + 5 retained non-strength) |
| Persistence, late data, HR-only | `backend/test/healthIntelligence.test.js` | +2 |
| Burn breakdown | `backend/test/healthBurnBreakdown.test.js` | rewritten case |
| Device identity + migration on an existing DB | `backend/test/healthDeviceProvenance.test.js` | 5 |
| Reliability qualifiers | `backend/test/calorieReliability.test.js` | 6 |
| API shape | `workoutCalorie.test.js`, `mlSkosCalV1.test.js` | extended (exact key set incl. new fields) |
| Research dataset | `ml/tests/test_research_dataset.py` | 22 |
| Frontend | `frontend/test/wearableComparison.test.js`, `frontend/test/calorieReliability.test.js` | 5 |

**Tests changed rather than added**
- **Reconciliation:** four reconciliation tests and two integration tests encoded the
  superseded "wearable wins" rule for strength sessions. They were rewritten to the new
  decision. The same scenarios are kept for non-strength sessions.
- **Fixture bugs:** two research-dataset failures during development were fixture
  pathologies (exactly collinear covariates; zero between-person variance). The harness was
  hardened so the same patterns in real data cannot crash it: rank-based feature dropping,
  and an OLS fallback at the zero-variance boundary.

Results: see the final section.

## Blockers and next steps

1. **Ethics and a partner lab.** No criterion data exists. The protocol is a draft for an
   ethics committee.
2. **Android.** No Android code is in the repo. Its bridge must forward Health Connect
   `metadata.device` / `dataOrigin` for device identity to be stored.
3. **Backfill decision** for canonical rows reconciled under the old rule.
4. **In-app set timestamps.** `exercise_set_logs` stores no set start/end times. The research
   protocol captures them on a tablet form. Capturing them in the app would let every member
   session contribute density and rest features. That needs a schema change and a UI change.
5. **Network.** Literature full texts were unreachable here, so stage-2 provenance remains at
   abstract level.

## Final test run (this branch, this cloud session)

| Suite | Result |
|---|---|
| Backend `node --test` | 1,904 tests: **1,902 pass, 0 fail**, 2 skipped (the PostgreSQL suites, which need `TEST_DATABASE_URL`) |
| Those 2 suites, against a scratch local PostgreSQL 16 | **22/22 pass** (run one at a time); new columns present |
| PostgreSQL migration on an existing database | dropped columns re-added by `init-db.js` |
| Frontend `vitest` | **184/184 pass**; production build succeeds |
| Playwright e2e (desktop) | **125/125 pass** (no spec completes a workout; the calorie path is covered by backend route tests) |
| ML `pytest` | **158 pass** |
