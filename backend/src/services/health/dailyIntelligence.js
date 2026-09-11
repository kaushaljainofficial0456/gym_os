// ============================================================
// DAILY INTELLIGENCE ENGINE — the DB-touching orchestration layer that
// composes matching.js/reconciliation.js/confidence.js/trainingLoad.js/
// recovery.js (all pure, all independently tested) into one
// SKOSDailyIntelligence object per (user, date), and persists it to
// health_daily_summaries so Home/Nutrition/Progress can read a cheap
// cached row instead of recomputing this on every request (spec §41/
// §61/§95 -- "the Home screen should not wait for thousands of raw
// health events").
//
// PERFORMANCE NOTE (kept in mind on every query in this file): this is
// called on its OWN route (GET /api/health/daily-intelligence), never
// injected into the already-hot /tracking/me/home path. Nothing in this
// file runs on every page load of the existing app.
//
// Reuses the EXISTING skos-cal-v1 pipeline (calorieModel.js) for every
// "SK OS ML" evidence source -- this file never reimplements calorie
// estimation (spec §32).
// ============================================================
import { id, now } from '../../ids.js';
import { dayKey, iso, DEFAULT_TZ } from '../../utils/time.js';
import { mifflinStJeorBmr, composeDailyEnergy, elapsedSecondsOfDay, restingEnergyForSeconds } from '../intelligence/restingEnergy.js';
import { buildWorkoutCalorieInput, estimateWorkoutCalories, resolveBodyWeight } from '../intelligence/calorieModel.js';
import { reconcileWorkout, buildExternalWorkoutCandidate, clusterWearableWorkouts, reconcileDailyEnergy } from './reconciliation.js';
import { computeTrainingLoad } from './trainingLoad.js';
import { computeRecovery, computeReadiness } from './recovery.js';
import { dataQualityState } from './confidence.js';

// Data-quality ceiling (spec §29/§65): no genuine single gym session
// plausibly runs longer than this. Guards against started_at/completed_at
// spanning an abandoned-then-much-later-resumed session (a workout can sit
// "in progress" across days -- Workout.jsx's own ACTIVE_SESSION_KEY
// comment) being fed to the calorie estimator as if it were one
// continuous multi-hour effort.
const MAX_PLAUSIBLE_WORKOUT_SECONDS = 6 * 3600;

async function fetchSkosWorkouts(db, clientId, date) {
  const workouts = await db.q('SELECT * FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status != ?', [clientId, date, 'draft']);
  if (!workouts.length) return [];
  const wIds = workouts.map((w) => w.id);
  const exercises = await db.q(
    `SELECT we.*, el.ex_type AS lib_ex_type, el.movement AS lib_movement,
            el.primary_muscle AS lib_primary_muscle, el.equipment AS lib_equipment
       FROM workout_exercises we LEFT JOIN exercise_library el ON el.id = we.exercise_id
      WHERE we.workout_id IN (${wIds.map(() => '?').join(',')})`, wIds);
  const logs = await db.q(
    `SELECT * FROM workout_logs WHERE workout_id IN (${wIds.map(() => '?').join(',')})`, wIds);
  const logIds = logs.map((l) => l.id);
  const sets = logIds.length
    ? await db.q(`SELECT * FROM exercise_set_logs WHERE workout_log_id IN (${logIds.map(() => '?').join(',')})`, logIds)
    : [];
  const setsByLog = new Map();
  for (const s of sets) { const arr = setsByLog.get(s.workout_log_id) || []; arr.push(s); setsByLog.set(s.workout_log_id, arr); }
  const setsByExerciseByWorkout = new Map();
  for (const l of logs) {
    if (!setsByExerciseByWorkout.has(l.workout_id)) setsByExerciseByWorkout.set(l.workout_id, {});
    // workout_logs keys off exercise_id (the library id); workout_exercises rows for the same
    // workout+exercise_id are matched against this by exercise_id below.
    setsByExerciseByWorkout.get(l.workout_id)[l.exercise_id] = setsByLog.get(l.id) || [];
  }
  return workouts.map((w) => ({
    workout: w,
    exercises: exercises.filter((e) => e.workout_id === w.id).map((e) => ({
      ...e,
      library: { ex_type: e.lib_ex_type, movement: e.lib_movement, primary_muscle: e.lib_primary_muscle, equipment: e.lib_equipment },
    })),
    setsByExercise: setsByExerciseByWorkout.get(w.id) || {},
  }));
}

/** Seconds of `date` that have actually elapsed in the user's own
 *  timezone: the full day for any past date, zero for a future one, and
 *  only the elapsed part for today -- so today's resting-energy line
 *  reads a real "so far" figure instead of a full 24h of BMR at 9am. */
function elapsedSecondsForDate(date, tz) {
  const today = dayKey(new Date(), tz);
  if (date < today) return 86400;
  if (date > today) return 0;
  const localTime = iso(new Date(), tz).split('T')[1] || '00:00:00';
  const [h, m, sec] = localTime.split(':').map(Number);
  return (h * 3600) + (m * 60) + (sec || 0);
}

async function fetchHealthRecords(db, userId, date, tz) {
  // Local calendar day -> UTC bounds: query a generous ±24h UTC window
  // (correct regardless of the user's actual timezone offset) and filter
  // precisely by the user's own local day via dayKey() in JS -- simpler
  // and more robust than a timezone-aware SQL computation, and this
  // returns a small, per-user, per-day row count either way.
  const wideStart = new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 3600 * 1000).toISOString();
  const wideEnd = new Date(Date.parse(`${date}T00:00:00Z`) + 48 * 3600 * 1000).toISOString();
  const wide = await db.q(
    `SELECT * FROM health_records WHERE user_id = ? AND deleted_at IS NULL AND start_time >= ? AND start_time <= ? ORDER BY start_time`,
    [userId, wideStart, wideEnd]
  );
  return wide.filter((r) => dayKey(new Date(r.start_time), tz) === date);
}

/** Builds the estimateMl(durationSeconds) closure `reconciliation.js`
 *  expects, bound to ONE specific SK OS workout's real exercises/sets. */
function makeEstimateMl(db, client, workoutBundle) {
  return async (durationSeconds) => {
    const input = buildWorkoutCalorieInput({
      client, workout: workoutBundle.workout, exercises: workoutBundle.exercises,
      setsByExercise: workoutBundle.setsByExercise, durationSeconds, bodyWeightKg: client?.current_weight,
    });
    const result = await estimateWorkoutCalories(input, { db, stage: 'health_intelligence' });
    return { kcal: result.estimated_active_kcal, modelName: 'skos-cal', modelVersion: result.model_version, provider: result.provider || 'skos_ml' };
  };
}

function generateInsights({ activeEnergy, workoutCount, trainingLoad, recoveryScore, dataQuality }) {
  const insights = [];
  if (dataQuality === 'unknown') return insights; // never fabricate an insight from no evidence (spec §42)
  if (workoutCount > 0 && activeEnergy != null) {
    insights.push(`${workoutCount} workout${workoutCount > 1 ? 's' : ''} logged today, contributing to ${Math.round(activeEnergy)} kcal of active energy.`);
  }
  if (recoveryScore != null && recoveryScore < 40) {
    insights.push('Your recovery indicators are lower than usual today.');
  }
  return insights;
}

/**
 * Reconciles and persists ONE user's daily intelligence for `date`
 * (YYYY-MM-DD, in `tz`). Idempotent -- safe to call repeatedly (e.g. a
 * manual "Sync now", or new wearable data arriving late, spec §22) and
 * always UPSERTs rather than duplicating.
 */
export async function reconcileUserDay(db, { userId, orgId, clientId, date, tz = DEFAULT_TZ }) {
  const [client, skosBundles, healthRecords] = await Promise.all([
    db.q1('SELECT * FROM clients WHERE id = ?', [clientId]),
    fetchSkosWorkouts(db, clientId, date),
    fetchHealthRecords(db, userId, date, tz),
  ]);

  const workoutRecords = healthRecords.filter((r) => r.data_type === 'workout');
  const consumedRecordIds = new Set();
  const reconciledWorkouts = [];

  for (const bundle of skosBundles) {
    const w = bundle.workout;
    const skosWorkout = { start_time: w.started_at || `${date}T00:00:00Z`, end_time: w.completed_at || w.started_at || `${date}T00:00:00Z`, activity_type: 'strength_training' };
    if (!w.started_at) continue; // never scored/timed session -- nothing to reconcile against yet

    // Data-quality guard (spec §29: "impossible duration... flag bad
    // data, do not silently convert to zero"). Found live: a workout can
    // be started, left in-progress across days (localStorage's own
    // active-session marker survives that -- see Workout.jsx's own
    // comment on ACTIVE_SESSION_KEY), then completed much later --
    // started_at - completed_at genuinely spans many hours, which is
    // NOT a real single gym session and must never be fed to the
    // calorie estimator as one (it produced a five-figure kcal estimate
    // the first time this was tested live). Flagged, never fabricated
    // into either a huge number OR a silent zero.
    const rawDurationSeconds = (Date.parse(skosWorkout.end_time) - Date.parse(skosWorkout.start_time)) / 1000;
    if (rawDurationSeconds > MAX_PLAUSIBLE_WORKOUT_SECONDS) {
      const canonicalId = await upsertCanonicalWorkout(db, {
        userId, orgId, skosWorkoutId: w.id, skosWorkout,
        decision: { activeKcal: null, primarySource: null, coverageRatio: null, confidence: null, matchScore: null, matchReason: null, matchedRecordIds: [], autoDetected: false, dataQualityFlag: true },
        date,
      });
      await db.run('UPDATE health_canonical_workouts SET data_quality = ? WHERE id = ?', ['suspicious', canonicalId]);
      continue; // no energy interval written -- genuinely no trustworthy duration to estimate from
    }

    const candidates = healthRecords.filter((r) => r.data_type === 'workout' || r.data_type === 'energy_sample' || r.data_type === 'heart_rate');
    const decision = await reconcileWorkout(skosWorkout, candidates, { estimateMl: makeEstimateMl(db, client, bundle) });
    decision.matchedRecordIds.forEach((rid) => consumedRecordIds.add(rid));

    const canonicalId = await upsertCanonicalWorkout(db, { userId, orgId, skosWorkoutId: w.id, skosWorkout, decision, date });
    await writeEnergyInterval(db, { userId, orgId, date, interval: skosWorkout, decision, canonicalId });
    reconciledWorkouts.push({ durationSeconds: rawDurationSeconds, activeKcal: decision.activeKcal, heartRateAvg: candidates.find((c) => c.id === decision.matchedRecordIds?.[0])?.heart_rate_avg });
  }

  // External workouts: wearable-detected sessions with no matching SK OS
  // log (spec TEST 6/9/20) -- cluster first so WHOOP+Apple Health
  // reporting the SAME event collapse into one canonical workout.
  const unmatchedWorkoutRecords = workoutRecords.filter((r) => !consumedRecordIds.has(r.id));
  for (const cluster of clusterWearableWorkouts(unmatchedWorkoutRecords)) {
    const primary = cluster.reduce((best, r) => (r.active_kcal != null && (best == null || r.source_confidence > (best.source_confidence ?? 0)) ? r : best), null) || cluster[0];
    const candidate = buildExternalWorkoutCandidate(primary);
    const canonicalId = await upsertCanonicalWorkout(db, {
      userId, orgId, skosWorkoutId: null,
      skosWorkout: { start_time: candidate.startTime, end_time: candidate.endTime, activity_type: candidate.activityType },
      decision: { ...candidate, matchedRecordIds: cluster.map((r) => r.id) }, date,
    });
    await writeEnergyInterval(db, { userId, orgId, date, interval: { start_time: candidate.startTime, end_time: candidate.endTime }, decision: candidate, canonicalId });
    reconciledWorkouts.push({ durationSeconds: (Date.parse(candidate.endTime) - Date.parse(candidate.startTime)) / 1000, activeKcal: candidate.activeKcal, heartRateAvg: primary.heart_rate_avg });
  }

  // Daily aggregate containment (spec §25/§26/TEST 10/11): a
  // provider-reported whole-day active-energy figure (energy_sample
  // records spanning ~the whole day) is authoritative when present.
  const intervalActiveKcalSum = reconciledWorkouts.reduce((s, w) => s + (Number(w.activeKcal) || 0), 0);
  const dailyAggregateRecords = healthRecords.filter((r) => r.data_type === 'energy_sample' && r.active_kcal != null &&
    (Date.parse(r.end_time || r.start_time) - Date.parse(r.start_time)) > 20 * 3600 * 1000); // ~day-spanning samples only
  const dailyEnergy = reconcileDailyEnergy({
    intervalActiveKcalSum,
    dailyAggregates: dailyAggregateRecords.map((r) => ({ provider: r.provider, active_kcal: r.active_kcal })),
  });

  const steps = healthRecords.filter((r) => r.data_type === 'steps').reduce((s, r) => s + (r.steps || 0), 0) || null;

  // ---- The whole-day energy picture (resting + active), spec §24/§26 ----
  // health_daily_summaries has carried resting_energy/total_energy columns
  // since the schema was written, but nothing ever populated them: the
  // engine only ever produced ACTIVE energy, so the app could show "1,077
  // kcal active" and never "what did I actually burn today". The
  // composition rules (never add a wearable's whole-day figure to our own
  // workout sum, never add step energy on top of a figure that already
  // contains it, never use TDEE as the resting base) all live in
  // restingEnergy.js's composeDailyEnergy.
  const bmrPerDay = mifflinStJeorBmr({
    weightKg: client?.current_weight, heightCm: client?.height_cm, age: client?.age, sex: client?.sex,
  });
  // reconcileDailyEnergy reports source as 'interval_sum' when it simply
  // added up our own reconciled workout intervals, or as a provider name
  // ('whoop') / 'consensus' when a wearable's OWN whole-day active-energy
  // figure won. Only the latter is authoritative for the whole day -- and
  // only then must step energy NOT be added on top, since a whole-day
  // wearable figure already contains everyday movement.
  const wearableDailyActive = dailyEnergy.source !== 'interval_sum' ? dailyEnergy.activeEnergy : null;
  const energy = composeDailyEnergy({
    bmrPerDay,
    elapsedSeconds: elapsedSecondsForDate(date, tz),
    workoutKcal: intervalActiveKcalSum,
    steps,
    weightKg: client?.current_weight,
    workouts: reconciledWorkouts,
    wearableDailyActive,
  });
  const sleepRecord = healthRecords.find((r) => r.data_type === 'sleep');
  const recoveryRecord = healthRecords.find((r) => r.data_type === 'recovery');

  const { load: trainingLoad } = computeTrainingLoad(reconciledWorkouts);
  const { recoveryScore, reasons: recoveryReasons } = computeRecovery({
    restingHr: recoveryRecord?.resting_hr ?? null, sleepDurationSeconds: sleepRecord?.sleep_duration_seconds ?? null,
    hrv: recoveryRecord?.hrv_ms ?? null, baselineRestingHr: null, baselineSleepSeconds: null, trainingLoadYesterday: null,
  });
  const { readinessLabel } = computeReadiness({ recoveryScore, sleepDebtHours: 0 });

  const overallCoverage = reconciledWorkouts.length
    ? reconciledWorkouts.filter((w) => w.activeKcal != null).length / reconciledWorkouts.length
    : (healthRecords.length > 0 ? 0.5 : 0);
  const quality = dataQualityState(overallCoverage);

  const insightsList = generateInsights({
    activeEnergy: dailyEnergy.activeEnergy, workoutCount: reconciledWorkouts.length, trainingLoad, recoveryScore, dataQuality: quality,
  });

  const summary = {
    date, active_energy: energy.activeKcal, workout_minutes: reconciledWorkouts.reduce((s, w) => s + w.durationSeconds / 60, 0),
    resting_energy: energy.restingKcal, total_energy: energy.totalKcal,
    training_load: trainingLoad, sleep_duration_seconds: sleepRecord?.sleep_duration_seconds ?? null,
    recovery_score: recoveryScore, readiness_label: readinessLabel, steps,
    data_quality: quality, reconciliation_status: dailyEnergy.reconciliationStatus,
    source_summary: {
      workouts: reconciledWorkouts.length, providers: [...new Set(healthRecords.map((r) => r.provider))],
      dailyEnergySource: dailyEnergy.source, activeSource: energy.activeSource,
      workoutKcal: energy.workoutKcal, movementKcal: energy.movementKcal, bmrPerDay,
    },
    insights: insightsList, recoveryReasons,
  };

  await upsertDailySummary(db, { userId, orgId, summary });
  return summary;
}

async function upsertCanonicalWorkout(db, { userId, orgId, skosWorkoutId, skosWorkout, decision, date }) {
  const existing = skosWorkoutId
    ? await db.q1('SELECT id, primary_energy_source, active_kcal FROM health_canonical_workouts WHERE skos_workout_id = ?', [skosWorkoutId])
    : null;
  const nowIso = now();
  const row = {
    activity_type: skosWorkout.activity_type ?? null, start_time: skosWorkout.start_time, end_time: skosWorkout.end_time,
    duration_seconds: (Date.parse(skosWorkout.end_time) - Date.parse(skosWorkout.start_time)) / 1000,
    primary_energy_source: decision.primarySource ?? null, active_kcal: decision.activeKcal ?? null,
    coverage_ratio: decision.coverageRatio ?? null, confidence_score: decision.confidence?.score ?? null,
    confidence_level: decision.confidence?.level ?? null, match_score: decision.matchScore ?? null, match_reason: decision.matchReason ?? null,
    auto_detected: decision.autoDetected ? 1 : 0, data_quality: decision.dataQualityFlag ? 'flagged' : 'good',
  };
  if (existing) {
    // Audit trail (spec §72): only log if the primary source or figure
    // actually changed -- e.g. late-arriving wearable data replacing an
    // earlier SK OS-only estimate (spec §22/TEST 7).
    if (existing.primary_energy_source !== row.primary_energy_source || Math.round(existing.active_kcal || 0) !== Math.round(row.active_kcal || 0)) {
      await db.run(
        `INSERT INTO health_reconciliation_log (id, user_id, canonical_workout_id, date, previous_source, new_source, previous_kcal, new_kcal, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id('hrlog'), userId, existing.id, date, existing.primary_energy_source, row.primary_energy_source, existing.active_kcal, row.active_kcal, 'reconciliation re-run (new or updated evidence)', nowIso]);
    }
    const sets = Object.keys(row).map((k) => `${k} = ?`).join(', ');
    await db.run(`UPDATE health_canonical_workouts SET ${sets}, matched_at = ?, updated_at = ? WHERE id = ?`, [...Object.values(row), nowIso, nowIso, existing.id]);
    if (decision.matchedRecordIds?.length) await db.run(`UPDATE health_records SET canonical_workout_id = ? WHERE id IN (${decision.matchedRecordIds.map(() => '?').join(',')})`, [existing.id, ...decision.matchedRecordIds]);
    return existing.id;
  }
  const canonicalId = id('hcw');
  const fields = ['id', 'user_id', 'org_id', 'skos_workout_id', ...Object.keys(row), 'matched_at', 'created_at', 'updated_at'];
  const values = [canonicalId, userId, orgId, skosWorkoutId, ...Object.values(row), nowIso, nowIso, nowIso];
  await db.run(`INSERT INTO health_canonical_workouts (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  if (decision.matchedRecordIds?.length) await db.run(`UPDATE health_records SET canonical_workout_id = ? WHERE id IN (${decision.matchedRecordIds.map(() => '?').join(',')})`, [canonicalId, ...decision.matchedRecordIds]);
  return canonicalId;
}

async function writeEnergyInterval(db, { userId, orgId, date, interval, decision, canonicalId }) {
  // Idempotent by (canonical_workout_id): delete-then-insert rather than
  // trying to diff a variable number of sub-intervals -- this table is
  // cheap and entirely derived, never a primary record of truth (that's
  // health_records + health_canonical_workouts).
  await db.run('DELETE FROM health_energy_intervals WHERE canonical_workout_id = ?', [canonicalId]);
  if (decision.activeKcal == null) return;
  await db.run(
    `INSERT INTO health_energy_intervals (id, user_id, org_id, date, start_time, end_time, active_kcal, resting_kcal, total_kcal, source, activity_type, confidence_score, confidence_level, coverage, is_primary, is_estimate, canonical_workout_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,1,?,?,?,?)`,
    [id('hei'), userId, orgId, date, interval.start_time, interval.end_time, decision.activeKcal, decision.activeKcal,
     decision.primarySource ?? 'skos_ml', interval.activity_type ?? null, decision.confidence?.score ?? null, decision.confidence?.level ?? null,
     decision.coverageRatio ?? null, decision.sourceType === 'skos_ml' || decision.sourceType === 'met_fallback' ? 1 : 0, canonicalId, now(), now()]);

  // SECONDARY EVIDENCE (spec 14/23, TEST 14): when a wearable measured
  // the session, SK OS's own estimate for it is retained rather than
  // thrown away -- is_primary = 0, so it is never counted toward any
  // total, only shown. This is what lets the burn breakdown say "WHOOP
  // measured 327, SK OS estimated 420" instead of silently replacing one
  // number with the other. The is_primary column existed for exactly
  // this from the start and was always written as 1.
  if (decision.secondaryEstimateKcal != null && decision.sourceType !== 'skos_ml') {
    await db.run(
      `INSERT INTO health_energy_intervals (id, user_id, org_id, date, start_time, end_time, active_kcal, resting_kcal, total_kcal, source, activity_type, confidence_score, confidence_level, coverage, is_primary, is_estimate, model_name, model_version, canonical_workout_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,0,1,?,?,?,?,?)`,
      [id('hei'), userId, orgId, date, interval.start_time, interval.end_time, decision.secondaryEstimateKcal, decision.secondaryEstimateKcal,
       'skos_ml', interval.activity_type ?? null, null, null, null,
       decision.secondaryModel?.name ?? null, decision.secondaryModel?.version ?? null, canonicalId, now(), now()]);
  }
}

async function upsertDailySummary(db, { userId, orgId, summary }) {
  const nowIso = now();
  const existing = await db.q1('SELECT id FROM health_daily_summaries WHERE user_id = ? AND date = ?', [userId, summary.date]);
  const cols = {
    active_energy: summary.active_energy, workout_minutes: summary.workout_minutes, training_load: summary.training_load,
    sleep_duration_seconds: summary.sleep_duration_seconds, recovery_score: summary.recovery_score, readiness_label: summary.readiness_label,
    steps: summary.steps, data_quality: summary.data_quality, reconciliation_status: summary.reconciliation_status,
    resting_energy: summary.resting_energy ?? null, total_energy: summary.total_energy ?? null,
    source_summary_json: JSON.stringify(summary.source_summary), insights_json: JSON.stringify(summary.insights),
  };
  if (existing) {
    const sets = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await db.run(`UPDATE health_daily_summaries SET ${sets}, computed_at = ?, updated_at = ? WHERE id = ?`, [...Object.values(cols), nowIso, nowIso, existing.id]);
    return existing.id;
  }
  const summaryId = id('hds');
  const fields = ['id', 'user_id', 'org_id', 'date', ...Object.keys(cols), 'computed_at', 'created_at', 'updated_at'];
  const values = [summaryId, userId, orgId, summary.date, ...Object.values(cols), nowIso, nowIso, nowIso];
  await db.run(`INSERT INTO health_daily_summaries (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, values);
  return summaryId;
}

export async function getDailyIntelligence(db, { userId, date, tz = DEFAULT_TZ }) {
  const row = await db.q1('SELECT * FROM health_daily_summaries WHERE user_id = ? AND date = ?', [userId, date]);
  if (!row) return null;
  const summary = safeParse(row.source_summary_json);

  // TODAY'S RESTING ENERGY IS TIME-DEPENDENT, SO IT CANNOT BE SERVED FROM
  // CACHE UNCHANGED.
  //
  // Caught live: the burn screen showed a flat 150 kcal at 10:27 in the
  // morning. The figure was right when it was WRITTEN -- reconciliation had
  // run around 2am, when two hours of BMR had genuinely accrued -- and then
  // sat frozen while the day went on, because every later read returned the
  // stored row. Resting energy is the one number on this screen that keeps
  // moving whether or not the user does anything, so it is recomputed from
  // elapsed time on read and the totals are rebuilt around it. Everything
  // else (workouts, steps) genuinely only changes when new data arrives, so
  // it stays cached.
  //
  // Past days are already complete: elapsedSecondsOfDay caps at a full day,
  // so this is a no-op for them rather than a special case.
  const bmrPerDay = summary?.bmrPerDay;
  if (bmrPerDay && date === dayKey(new Date(), tz)) {
    const dayStartMs = Date.parse(`${date}T00:00:00${tzOffsetSuffix(date, tz)}`);
    if (Number.isFinite(dayStartMs)) {
      const elapsedSeconds = elapsedSecondsOfDay({ dayStartMs, nowMs: Date.now() });
      const restingNow = restingEnergyForSeconds(bmrPerDay, elapsedSeconds);
      if (Number.isFinite(restingNow)) {
        const active = Number.isFinite(row.active_energy) ? row.active_energy : 0;
        return {
          ...row,
          resting_energy: restingNow,
          total_energy: restingNow + active,
          source_summary: summary,
          insights: safeParse(row.insights_json) || [],
        };
      }
    }
  }

  return {
    ...row,
    source_summary: summary,
    insights: safeParse(row.insights_json) || [],
  };
}

/** The UTC offset for a date in a zone, as '+05:30'/'Z', so a day boundary
 *  is the user's midnight rather than the server's. */
function tzOffsetSuffix(date, tz) {
  try {
    const d = new Date(`${date}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = parts.match(/GMT([+-]\d{2}:\d{2})/);
    return m ? m[1] : 'Z';
  } catch { return 'Z'; }
}

function safeParse(json) { try { return json ? JSON.parse(json) : null; } catch { return null; } }

/**
 * The itemized "where did today's burn come from" view (the burn-detail
 * screen). Reads only ALREADY-reconciled rows -- it never recomputes
 * anything, so opening the screen is a couple of indexed reads.
 *
 * Returns every component of the day as its own entry, so the total is
 * always explainable line by line rather than being a number the user has
 * to trust:
 *   - resting  : BMR, prorated to the elapsed part of today
 *   - workout  : one per canonical workout, with its real timestamps, the
 *                source that won, and (when a wearable won) SK OS's own
 *                estimate alongside it as a comparison
 *   - movement : everyday steps, net of resting and of steps already
 *                inside a step-driven workout
 *
 * `null` kcal on an entry means "not known", never zero -- an absent
 * profile field or absent step data must not read as "you burned nothing".
 */
export async function getBurnBreakdown(db, { userId, date }) {
  const summary = await getDailyIntelligence(db, { userId, date });
  if (!summary) return null;

  // Workout lines are derived from health_energy_intervals, NOT by
  // re-querying canonical workouts by their own start_time.
  //
  // Caught live: a session that ran 22:58-23:58 local was bucketed into
  // the NEXT day by reconcileUserDay (it keys off the workout's
  // scheduled_date), so its energy was inside that day's total while a
  // start_time-based query for the same day could not find it -- the
  // breakdown showed a total 354 kcal larger than the lines beneath it.
  // health_energy_intervals.date is written by the same pass that built
  // the total, so reading the lines from there makes them sum to the
  // total BY CONSTRUCTION, in every timezone, for every midnight-
  // straddling session. That property matters more here than any
  // individual query being clever.
  const intervals = await db.q(
    'SELECT * FROM health_energy_intervals WHERE user_id = ? AND date = ? ORDER BY start_time',
    [userId, date]);
  const workoutIds = [...new Set(intervals.map((iv) => iv.canonical_workout_id).filter(Boolean))];
  const canonicalRows = workoutIds.length
    ? await db.q(`SELECT * FROM health_canonical_workouts WHERE id IN (${workoutIds.map(() => '?').join(',')})`, workoutIds)
    : [];
  const canonicalById = new Map(canonicalRows.map((w) => [w.id, w]));
  // One entry per PRIMARY interval -- these are the rows that actually
  // contributed to the day's active energy.
  const workouts = intervals
    .filter((iv) => iv.is_primary && iv.canonical_workout_id && canonicalById.has(iv.canonical_workout_id))
    .map((iv) => canonicalById.get(iv.canonical_workout_id));

  // Secondary (is_primary = 0) rows are SK OS's own estimate for a session
  // a wearable measured -- shown as a comparison, never added to a total.
  const secondaryByWorkout = new Map();
  for (const iv of intervals) {
    if (!iv.is_primary && iv.canonical_workout_id) secondaryByWorkout.set(iv.canonical_workout_id, iv);
  }

  const src = summary.source_summary || {};
  const entries = [];

  if (summary.resting_energy != null) {
    entries.push({
      type: 'resting',
      label: 'Resting',
      sublabel: 'Basal metabolism',
      kcal: summary.resting_energy,
      startTime: `${date}T00:00:00`,
      endTime: null,
      source: 'skos_bmr',
      sourceLabel: 'Mifflin-St Jeor',
      isEstimate: true,
      detail: src.bmrPerDay ? `${Math.round(src.bmrPerDay)} kcal/day at rest` : null,
    });
  }

  for (const w of workouts) {
    const secondary = secondaryByWorkout.get(w.id);
    entries.push({
      type: 'workout',
      label: activityLabel(w.activity_type),
      sublabel: w.skos_workout_id ? 'Logged in Barbell' : 'Detected by wearable',
      kcal: w.active_kcal,
      startTime: w.start_time,
      endTime: w.end_time,
      durationSeconds: w.duration_seconds,
      source: w.primary_energy_source,
      isEstimate: !isWearableKey(w.primary_energy_source),
      confidenceLevel: w.confidence_level,
      coverageRatio: w.coverage_ratio,
      dataQuality: w.data_quality,
      // Both numbers, side by side, when they exist -- the wearable's
      // measurement and what SK OS would have estimated on its own.
      comparison: secondary ? {
        skosEstimateKcal: secondary.active_kcal,
        measuredKcal: w.active_kcal,
        model: secondary.model_name || null,
      } : null,
    });
  }

  if (src.movementKcal != null) {
    entries.push({
      type: 'movement',
      label: 'Everyday movement',
      sublabel: summary.steps != null ? `${Number(summary.steps).toLocaleString()} steps` : 'Steps',
      kcal: src.movementKcal,
      startTime: null,
      endTime: null,
      steps: summary.steps ?? null,
      source: 'skos_steps',
      isEstimate: true,
      detail: 'Estimated from step count, above resting',
    });
  }

  return {
    date,
    // When this day was last reconciled. The caller uses it to decide
    // whether wearable data has arrived SINCE, and it is the honest "as
    // of" stamp for figures that were computed rather than measured.
    computed_at: summary.computed_at ?? null,
    totals: {
      total: summary.total_energy ?? null,
      resting: summary.resting_energy ?? null,
      active: summary.active_energy ?? null,
      workouts: src.workoutKcal ?? null,
      movement: src.movementKcal ?? null,
    },
    steps: summary.steps ?? null,
    activeSource: src.activeSource || null,
    providers: src.providers || [],
    dataQuality: summary.data_quality,
    // Sorted newest-first for display; the resting line stays pinned last
    // since it spans the whole day rather than happening at a moment.
    entries: entries.sort((a, b) => {
      if (a.type === 'resting') return 1;
      if (b.type === 'resting') return -1;
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return Date.parse(b.startTime) - Date.parse(a.startTime);
    }),
  };
}

const WEARABLE_KEYS = new Set(['apple_health', 'health_connect', 'samsung_health', 'whoop', 'oura', 'garmin', 'fitbit', 'polar', 'coros', 'ultrahuman']);
function isWearableKey(k) { return !!k && WEARABLE_KEYS.has(k); }

function activityLabel(activityType) {
  if (!activityType) return 'Workout';
  return String(activityType).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
