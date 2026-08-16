# Design note — post-session rating, tempo, and work density

**Question raised (2026-08-16):** use a post-session easy/moderate/hard rating to pick a MET value, combine with duration + exercises + sets + reps, and add a correction so that a slow-tempo lifter (more time under tension) gets a higher estimate than someone who spent the same 90 minutes resting between sets.

**Verdict: the underlying instinct is correct and worth building. The proposed mechanism won't detect it — and there is a better signal SK OS can capture with zero extra user burden.**

---

## 1. Most of this is already built

| Proposed component | Status in skos-cal-v1 |
|---|---|
| Post-session easy/moderate/hard rating | **Already used** — `session.intensity_rating` selects the MET tier |
| Total workout time | **Already used** — `session.duration_minutes` |
| Which exercises | **Already used** — drives the per-exercise correction |
| Body weight | **Already used** — scales the MET baseline |
| Sets / reps | Logged by the app, **not used by the model** (absent from all training data) |
| Time-under-tension / tempo correction | **Not built** — the genuinely new part of this proposal |

So this is not a rebuild. It is one addition to a model that already does the rest.

---

## 2. The problem with making the rating the primary driver

We have exactly one dataset that reports both a subjective effort rating **and** measured indirect-calorimetry energy cost for the same sessions in the same people: Adeel et al. 2021 (CC BY 4.0). Two groups did the *same three exercises* at the *same relative intensity* (60% of each person's own 1RM).

Reproducible via `scripts/rpe_vs_energy_check.py`:

| Exercise | RPE ratio (trained/untrained) | Actual kcal/min ratio | RPE significant? |
|---|---|---|---|
| Shoulder press | 0.96× | **2.38×** | no (p=0.118) |
| Deadlift | 1.01× | **1.77×** | no (p=0.732) |
| Squat | 1.06× | **1.94×** | barely (p=0.036) |
| **Average** | **1.01×** | **2.03×** | — |

**Trained participants burned roughly twice the calories while reporting essentially identical effort.**

The reason is well-established physiology: perceived effort is relative to a person's *own* capacity. Working at 60% of your max feels about the same regardless of how big that max is — but 60% of a large max costs far more energy in absolute terms. Nakagata et al. 2019 makes the same point from the opposite direction: an older adult with a 5-MET ceiling experiences a 3.8-MET squat as *vigorous*, while a young adult experiences the identical absolute cost as *moderate*.

**Consequence for the proposal:** using the rating as the primary driver would systematically **under**-estimate exactly the stronger/heavier lifter the correction is meant to push upward. It would work backwards.

*Stated honestly:* the trained group in that study was also heavier (81.7kg vs 53.3kg), and body weight explains much of the 2× gap. That doesn't weaken the conclusion — it reinforces it. The **objective** variable carried the signal; the self-report did not.

---

## 3. The scenario as described is currently undetectable — this is the real blocker

Take the two people literally as described: same exercises, same sets, same reps, same 90 minutes.

Every input SK OS currently records is **identical** between them:

| Field | Casual gym-goer | Slow-tempo lifter |
|---|---|---|
| `duration_minutes` | 90 | 90 |
| `exercises[]` | same | same |
| `sets`, `reps` | same | same |
| `total_volume_kg` | same | same |
| `body_weight_kg` | (whatever each weighs) | — |

Identical inputs must produce identical outputs. **No correction factor can distinguish them, because nothing in the logged data differs.** The only thing that actually differs — how much of those 90 minutes was spent under load — is not recorded.

This is why the proposal reaches for the self-report: it is currently the *only* field that varies. But §2 shows that field is the wrong instrument.

---

## 4. The fix: set-level timestamps

**If the app records a timestamp when each set is completed, the work/rest structure comes out for free.** No extra taps, no user judgement, fully objective.

From set timestamps alone:

```
rest_duration     = start of set N+1  −  completion of set N
total_rest_time   = Σ rest_duration
total_work_time   = duration_minutes − total_rest_time
work_ratio        = total_work_time / duration_minutes     ← the key density signal
```

Now the two people separate cleanly:

| | Casual gym-goer | Slow-tempo lifter |
|---|---|---|
| Sets completed | 20 | 20 |
| Typical gap between sets | ~3.5 min | ~1.5 min |
| Implied work time in 90 min | ~20 min | ~60 min |
| `work_ratio` | **0.22** | **0.67** |

That is a large, objective, unambiguous difference — derived from data the app can capture automatically.

**Even partial capture works.** If only set-*completion* times are available (not start times), inter-set intervals are still recoverable, which carries most of the signal. Full set start+end timestamps would additionally give true time-under-tension, which is strictly better if it's cheap to log.

Physiological support for tempo mattering at all: Nakagata's body of work measured slow-tempo (3s up / 3s down) bodyweight exercise at 3.1–3.8 METs — materially above what the same movements cost at normal cadence.

---

## 4b. REVISION — per-set tapping rejected on UX grounds; here's what's free

Per-set timers were correctly rejected: making users tap a timer for every set of every exercise would damage the product more than a calorie estimate is worth. **It also turns out to be unnecessary — the schema already carries most of this signal.**

### Already in the database, currently unused by the model, zero UX change

Confirmed by direct inspection of `database/schema.sql` and `backend/src/routes/workouts.js`:

| Field | Table | Status |
|---|---|---|
| `rest_sec` | `workout_exercises` | **`NOT NULL DEFAULT 90`** — always populated for prescribed workouts |
| `rest_seconds` | `exercise_set_logs` | copied from the prescription at log time |
| `actual_reps`, `actual_weight` | `exercise_set_logs` | real per-set values |
| `rir` | `exercise_set_logs` | real per-set reps-in-reserve |
| `set_number` | `exercise_set_logs` | set counts |
| `completed_at` | `workouts` | session end |

From those alone, all of the following are computable **today, with no app change and no extra user interaction**:

```
total_sets           = count of set rows
total_volume_kg      = Σ (actual_reps × actual_weight)
prescribed_rest_sec  = Σ rest_seconds
sets_per_minute      = total_sets / duration_minutes
volume_per_minute    = total_volume_kg / duration_minutes
implied_work_ratio   = (duration_minutes × 60 − prescribed_rest_sec) / (duration_minutes × 60)
```

`implied_work_ratio` is the density signal §4 was reaching for, derived from the plan rather than measured from the clock. A programme prescribing 90 s × 20 sets = 30 min of rest inside a 90-minute session implies a very different structure from the same rest inside a 45-minute session.

**Two honest caveats:**
- **Prescribed ≠ actual.** Someone told to rest 90 s may rest three minutes. This is directional, not measured.
- **`DEFAULT 90` may make it constant.** If trainers never customise `rest_sec`, every row reads 90 and the field carries no information at all. **Check this before relying on it:** `SELECT COUNT(DISTINCT rest_sec) FROM workout_exercises;` — if the answer is 1, this signal doesn't exist yet in practice, and the fix is programme-authoring (let trainers set real rest targets), not app UX.

### One tap per session — same cost as the rating already planned

Instead of a per-set timer, ask **one** question at session end, alongside the easy/moderate/hard rating:

> **Pace:** Rushed · Steady · Took my time

This captures the tempo/rest dimension directly, at exactly the interaction cost already budgeted for the intensity rating. Unlike the effort rating (§2), pace is a *descriptive* question rather than a *relative-to-my-capacity* one — a beginner and a lifter both know whether they lingered between sets, whereas "was that hard?" means different things to each of them.

### One tap ever — profile setting

At onboarding: **Training style — Powerlifting · Bodybuilding · Circuit/Conditioning · General fitness.** Carries strong prior information about tempo and rest habits, costs one tap in a user's entire lifetime, and is useful for programme recommendations anyway.

### Opt-in, and users actually want it

A **rest timer** is a feature serious lifters seek out — it tells them when to start the next set. If SK OS offers one and a user chooses to use it, real inter-set timing arrives as a by-product of a feature they wanted. Never forced, no UX cost to anyone who ignores it, genuinely accurate for those who opt in.

### What none of these solve

The literal twins in §3 — identical exercises, sets, reps, duration, and programme, differing *only* in tempo — remain inseparable without either real timing or a self-report. That is a genuine limit, worth stating plainly. What the options above do capture is the far more common real-world variation: different programmes, different rest prescriptions, different volumes, different paces.

---

## 5. Recommended design

```
baseline    = MET[tier] × 3.5 × body_weight_kg ÷ 200        (unchanged)
correction  = per-exercise × tier                            (unchanged, V1's trained 8)
density_adj = f(work_ratio)                                  (NEW — needs calibration data)
rate        = baseline + correction + density_adj
estimate    = rate × duration_minutes, capped at 20 kcal/min (unchanged guardrail)
```

**Keep the post-session rating.** It is already wired in, it costs the user one tap, and it is genuinely useful — as a *secondary* signal and for engagement. Just don't let it be the thing that decides the number.

**Do not hand-pick `f(work_ratio)`.** Inventing a multiplier would be exactly the kind of guessed correction this project has refused to make everywhere else. `density` is already listed in `src/v2/residual_model.py`'s `FEATURES_INTENDED_ONCE_NEW_DATA_ARRIVES` — it gets *fitted* when calibration data exists, not assumed.

---

## 5b. DECISION (2026-08-16): single session timer only

**Product decision taken:** one timer running from workout start to workout end. No per-set, per-rep, per-exercise or rest timers. Recorded here as settled, not re-argued.

**This satisfies every input the deployed model requires.** `mlEstimate` needs exactly four things, and a single session timer supplies or preserves all of them:

| Model input | Source under the single-timer design |
|---|---|
| `body_weight_kg` | client profile — unaffected |
| `duration_minutes` | **the session timer** — start to end |
| `intensity_rating` | post-session easy/moderate/hard rating |
| `exercises[]` (id, sets, volume, completed) | per-set logging, unaffected |

**Two of the three density signals survive**, because they need only totals and duration — no rest timing at all:

```
sets_per_minute   = total_sets / duration_minutes
volume_per_minute = total_volume_kg / duration_minutes
```

Both are computable from data the app already collects. They capture the common real-world case (30 sets in 60 min is genuinely denser than 10 sets in 90 min).

**What is given up, stated plainly:**
- `implied_work_ratio` and any actual-rest measurement are gone.
- The identical-twins case in §3 (same everything, differing only in tempo) becomes permanently unresolvable from logged data.
- If a tempo/time-under-tension correction is ever wanted, it would require reintroducing timing — a future decision, not a present cost.

**This is a reasonable trade.** The density/tempo feature was never validated and could not have been fitted without calibration data that does not exist. Trading an unvalidated future feature for a materially simpler workout flow is a sound call, and the model works fully without it.

**The one thing that must not be lost: `duration_minutes` has to be persisted.** It currently is not (see §6.1) — and without it `mlEstimate` throws and every session silently falls back to the old MET baseline. The single timer is now the *only* source of that value, which makes persisting it strictly more important than before, not less.

---

## 6. What to do now, in order

### 6.1 BLOCKING — persist the session duration

`frontend/src/pages/client/Workout.jsx` already tracks the session timer: `setStartedAt(Date.now())` when execution begins, and in `finishWorkout()`:

```js
const durationMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
setResult({ prs, volume, durationMin, exercises: state.length });   // shown in the summary UI
```

…but the POST body is only `{ logs }`. **The value is displayed and then discarded.** There is no `started_at` on `workouts` and no duration column anywhere in `schema.sql`.

Consequence: `mlEstimate` throws without `duration_minutes` and falls back to the baseline provider. **As currently wired, the ML model would never run in production** — every session would silently use the old MET formula, and the fallback is quiet by design so nobody would notice.

Required changes (all small):
1. Include `duration_minutes` (and ideally `started_at`) in the `/workouts/:id/complete` request body.
2. Add a duration column to `workouts` (or persist `started_at` alongside the existing `completed_at`).
3. Pass it into `buildWorkoutCalorieInput`.

**The single-timer decision (§5b) makes this the sole source of duration, so it is now a hard dependency rather than one input among several.**

### 6.2 Then, in order

1. **Store `sets_per_minute` and `volume_per_minute`** per session. Both computable from data already collected, no app change. Storing them from day one means there is history to fit against when calibration data arrives, rather than a standing start.
2. **Keep the intensity rating.** No change — just don't let it be the sole driver of the number (§2).
3. **Optional:** the one-tap pace question, if the tempo dimension is wanted later without reintroducing timers.
4. **Do not add a tempo/density correction to the deployed model.** Nothing in the training data has per-set timing, so its coefficient cannot be fitted or validated. `density` stays listed in `src/v2/residual_model.py`'s intended feature set — fitted when real measured data exists, never guessed.

**Honest bottom line:** the proposal correctly identified a real gap in V1. It cannot be closed with a self-reported effort rating (§2). Under the single-timer decision the tempo dimension is set aside deliberately — a sound trade for a simpler flow, since that feature was never validated anyway. The one thing that genuinely must be fixed is §6.1: the duration the app already computes has to reach the database, or the model never runs at all.
