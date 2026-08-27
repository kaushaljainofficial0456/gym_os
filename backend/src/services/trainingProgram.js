// ============================================================
// TRAINING PROGRAM — program → training day → template → workout
// A client's active program maps days of the week to workout
// templates. `ensureTodayWorkout` materializes the day's template
// into a `workouts` row (with copied exercises) the first time it
// is viewed, so completion/history/progressive-overload flows work
// exactly as they do for trainer-assigned workouts.
// ============================================================
import { id, now } from '../ids.js';
import { dayKey, weekDay, getOrgTz } from '../utils/time.js';
import { suggestNextTarget } from './progressiveOverload.js';
import { requiredItems, parseAvailable, suggestAlternatives } from './equipment.js';
import { estimateWorkoutCalories, buildWorkoutCalorieInput, resolveBodyWeight, completedSetCount, mlCanonicalExerciseId } from './intelligence/calorieModel.js';

export async function getActiveProgram(db, clientId) {
  return db.q1(
    `SELECT * FROM training_programs WHERE client_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1`,
    [clientId]);
}

export async function getProgramDays(db, programId) {
  return db.q('SELECT * FROM training_days WHERE program_id = ? ORDER BY day_of_week, position', [programId]);
}

// Materialize a template (or inline day) into a real scheduled workout.
export async function materializeWorkout(db, { orgId, clientId, trainerId, templateId, name, dayLabel, scheduledDate }) {
  const wId = id('wko');
  await db.run(
    `INSERT INTO workouts (id, org_id, template_id, client_id, trainer_id, name, day_label, scheduled_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?)`,
    [wId, orgId, templateId || null, clientId, trainerId || null, name, dayLabel, scheduledDate, now()]);
  const tmplExs = templateId
    ? await db.q('SELECT * FROM workout_exercises WHERE template_id = ? ORDER BY position', [templateId])
    : [];
  for (const ex of tmplExs) {
    await db.run(
      `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('wxe'), wId, ex.exercise_id, ex.position, ex.name, ex.sets, ex.reps, ex.weight,
       ex.rest_sec, ex.tempo || null, ex.notes || null]);
  }
  return db.q1('SELECT * FROM workouts WHERE id = ?', [wId]);
}

// Resolve "today's session" for a client:
//   1. an existing assigned workout scheduled for today
//   2. the active program's template for today's day-of-week (materialized)
//   3. the most recent assigned workout (fallback)
export async function ensureTodayWorkout(db, clientId, tz) {
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', [clientId]);
  const orgTz = tz || await getOrgTz(db, client?.org_id);
  const d = dayKey(new Date(), orgTz);
  let w = await db.q1(
    `SELECT * FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned' ORDER BY created_at DESC LIMIT 1`,
    [clientId, d]);
  if (w) return w;

  const prog = await getActiveProgram(db, clientId);
  if (prog) {
    const dow = weekDay(d, orgTz);
    const day = await db.q1('SELECT * FROM training_days WHERE program_id = ? AND day_of_week = ?', [prog.id, dow]);
    if (day && day.template_id) {
      w = await materializeWorkout(db, {
        orgId: client.org_id, clientId: client.id, trainerId: prog.trainer_id || null,
        templateId: day.template_id, name: day.name, dayLabel: day.name, scheduledDate: d
      });
      // dedupe racing materializations (two tabs / parallel /me calls):
      // remove other un-logged 'assigned' rows for the same client + day
      await db.run(
        `DELETE FROM workouts WHERE client_id = ? AND scheduled_date = ? AND status = 'assigned' AND id != ?
           AND NOT EXISTS (SELECT 1 FROM workout_logs wl WHERE wl.workout_id = workouts.id)`,
        [clientId, d, w.id]);
      return w;
    }
  }

  w = await db.q1(
    `SELECT * FROM workouts WHERE client_id = ? AND status = 'assigned' ORDER BY scheduled_date DESC LIMIT 1`,
    [clientId]);
  return w || null;
}

// Full "today's session" bundle used by the client portal:
// workout + exercises + muscle distribution + session meta + per-exercise next targets.
export async function todaySession(db, clientId, tz) {
  const w = await ensureTodayWorkout(db, clientId, tz);
  if (!w) return null;
  const exercises = await db.q(
    `SELECT we.*, el.primary_muscle, el.secondary_muscles, el.equipment, el.ex_type, el.movement, el.difficulty, el.cues, el.animation_key, el.is_global
       FROM workout_exercises we
       LEFT JOIN exercise_library el ON el.id = we.exercise_id
      WHERE we.workout_id = ? ORDER BY we.position`, [w.id]);

  // muscle distribution across today's exercises
  const dist = new Map();
  for (const ex of exercises) {
    if (!ex.primary_muscle) continue;
    dist.set(ex.primary_muscle, (dist.get(ex.primary_muscle) || 0) + 1);
  }
  const focus = [...dist.entries()]
    .map(([muscle, count]) => ({ muscle, count }))
    .sort((a, b) => b.count - a.count);

  // session meta
  const totalSets = exercises.reduce((s, e) => s + (e.sets || 0), 0);
  const estMinutes = Math.max(15, Math.round(totalSets * (1.6 + (exercises[0]?.rest_sec || 90) / 60)));

  // Calorie estimate — single choke point: the calorieModel service.
  //   completed -> PERSISTED estimate computed from ACTUAL set logs at
  //                completion time (authoritative, never recomputed here)
  //   pending   -> clearly-labelled PREVIEW from planned exercises; it is
  //                never persisted and never treated as actual workload
  let calorie = null;
  if (w.status === 'completed' && w.estimated_active_kcal != null) {
    calorie = {
      schema_version: w.schema_version,
      estimated_active_kcal: w.estimated_active_kcal,
      lower_kcal: w.lower_kcal,
      upper_kcal: w.upper_kcal,
      model_version: w.model_version,
      provider: w.calorie_provider,
      source: 'persisted',
      estimated_at: w.calorie_estimated_at
    };
  } else {
    const client = await db.q1('SELECT age, sex, height_cm FROM clients WHERE id = ?', [clientId]);
    const bodyWeightKg = await resolveBodyWeight(db, clientId, w.scheduled_date || undefined);
    const previewInput = buildWorkoutCalorieInput({
      client,
      workout: w,
      exercises: exercises.map((e) => ({
        id: e.id, exercise_id: e.exercise_id, name: e.name, ex_type: e.ex_type, movement: e.movement,
        equipment: e.equipment, primary_muscle: e.primary_muscle,
        library: { ex_type: e.ex_type, movement: e.movement, equipment: e.equipment, primary_muscle: e.primary_muscle }
      })),
      setsByExercise: Object.fromEntries(exercises.map((e) => [e.id,
        Array.from({ length: e.sets || 0 }, (_, i) => ({
          set_number: i + 1, actual_reps: parseFloat(e.reps) || 0, actual_weight: parseFloat(e.weight) || 0, completed: 1
        }))])),
      durationSeconds: estMinutes * 60,
      bodyWeightKg
    });
    // Exercise-ID canonicalization for the ml provider only (Phase 3B
    // Step 3) — built from the SAME already-fetched rows; never trusts a
    // custom (non-global) exercise's animation_key.
    const mlExerciseCanonical = {};
    for (const e of exercises) {
      if (!e.exercise_id) continue;
      const token = mlCanonicalExerciseId({ animationKey: e.animation_key, isGlobal: e.is_global });
      if (token) mlExerciseCanonical[e.exercise_id] = token;
    }
    const previewCalorie = await estimateWorkoutCalories(previewInput, { mlExerciseCanonical, db, stage: 'preview' });
    calorie = {
      ...previewCalorie,
      source: 'preview',
      completedSets: completedSetCount(previewInput)
    };
  }
  const estKcal = calorie?.estimated_active_kcal ?? null;

  // progressive-overload next targets for exercises with history
  const suggestions = [];
  for (const ex of exercises) {
    if (!ex.exercise_id) continue;
    const s = await suggestNextTarget(db, clientId, ex.exercise_id, { prescribedReps: parseInt(ex.reps) || null });
    if (s) suggestions.push({ exercise_id: ex.id, library_id: ex.exercise_id, current: s.current, suggested: s.suggested, rationale: s.rationale, increment: s.increment });
  }

  // equipment availability + alternatives (client profile aware)
  const profile = await db.q1('SELECT equipment FROM client_profiles WHERE client_id = ?', [clientId]);
  const available = parseAvailable(profile?.equipment);
  const equipment = [];
  for (const ex of exercises) {
    const need = requiredItems(ex.equipment);
    const missing = need.filter(i => !available.has(i));
    const alternatives = missing.length && ex.exercise_id
      ? await suggestAlternatives(db, { id: ex.exercise_id, primary_muscle: ex.primary_muscle, equipment: ex.equipment, difficulty: ex.difficulty, movement: ex.movement }, profile?.equipment)
      : [];
    equipment.push({ exercise_id: ex.id, name: ex.name, required: need, missing, ok: missing.length === 0, alternatives });
  }

  return {
    workout: { ...w, exercises },
    focus,
    meta: { totalSets, estMinutes, estKcal, calorie, exerciseCount: exercises.length, doneCount: exercises.filter(e => e.done).length },
    suggestions,
    equipment
  };
}
