import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope, resolveClient } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { dayKey } from '../utils/time.js';
import { suggestNextTarget } from '../services/progressiveOverload.js';
import { evaluatePRs } from '../services/personalRecords.js';
import { track } from '../services/events.js';
import { estimateWorkoutCalories, buildWorkoutCalorieInput, resolveBodyWeight, persistCalorieResult, mlCanonicalExerciseId } from '../services/intelligence/calorieModel.js';

export default function workoutRoutes(db) {
  const r = Router();
  // Router-level: any authenticated user (clients need to complete their own
  // workouts and toggle exercises). Trainer-only actions are guarded per-route.
  r.use(requireAuth, orgScope);
  // Baseline rate limit for the whole router -- generous enough for a
  // genuinely active session (the /progress autosave is debounced to one
  // call per 800ms client-side, so even a user tapping continuously for a
  // full minute stays well under this) while still capping runaway/
  // scripted abuse. Nothing in this router had any rate limit before this.
  r.use(rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => req.user?.sub || 'anon' }));

  // ---- exercise library ----
  r.get('/exercises', requireRole('GYM_OWNER', 'TRAINER', 'CLIENT', 'SUPER_ADMIN'), async (req, res) => {
    const rows = await db.q(
      `SELECT * FROM exercise_library WHERE is_global = 1 OR org_id = ?
       ORDER BY primary_muscle, name`, [req.orgId]);
    res.json({ exercises: rows });
  });

  r.post('/exercises', requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), validate(z.object({
    name: z.string().min(1).max(100),
    primary_muscle: z.string().min(1).max(50),
    secondary_muscles: z.string().max(200).optional(),
    equipment: z.string().max(50).default('BW'),
    difficulty: z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).default('BEGINNER'),
    instructions: z.string().max(2000).optional(),
    cues: z.string().max(500).optional(),
    mistakes: z.string().max(500).optional(),
    alternatives: z.string().max(500).optional(),
    animation_key: z.string().max(50).optional()
  })), async (req, res) => {
    const eId = 'ex_' + Math.random().toString(36).slice(2, 12);
    const b = req.body;
    await db.run(
      `INSERT INTO exercise_library (id, org_id, name, primary_muscle, secondary_muscles, equipment, difficulty, instructions, cues, mistakes, alternatives, animation_key, is_global)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [eId, req.orgId, b.name, b.primary_muscle, b.secondary_muscles || null, b.equipment,
       b.difficulty, b.instructions || null, b.cues || null, b.mistakes || null, b.alternatives || null,
       b.animation_key || null]);
    res.status(201).json({ id: eId });
  });

  // ---- workout templates (trainer/owner only) ----
  const trainerOnly = requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN');
  r.get('/templates', trainerOnly, async (req, res) => {
    const rows = await db.q(
      `SELECT wt.*, (SELECT COUNT(*) FROM workout_exercises we WHERE we.template_id = wt.id) AS exercise_count
         FROM workout_templates wt
        WHERE wt.org_id = ?
        ORDER BY wt.created_at DESC`, [req.orgId]);
    const withExercises = [];
    for (const t of rows) {
      const ex = await db.q(
        `SELECT we.*, el.animation_key, el.primary_muscle
           FROM workout_exercises we
           LEFT JOIN exercise_library el ON el.id = we.exercise_id
          WHERE we.template_id = ? ORDER BY we.position`, [t.id]);
      withExercises.push({ ...t, exercises: ex });
    }
    res.json({ templates: withExercises });
  });

  r.post('/templates', trainerOnly, validate(schemas.workoutTemplate), async (req, res) => {
    const tId = id('wkt');
    await db.run(
      `INSERT INTO workout_templates (id, org_id, trainer_id, name, type, notes, is_global, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [tId, req.orgId, req.user.sub, req.body.name, req.body.type || 'custom', req.body.notes || null, now()]);
    for (let i = 0; i < req.body.exercises.length; i++) {
      const ex = req.body.exercises[i];
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('wxe'), tId, ex.exercise_id || null, i, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo || null, ex.notes || null]);
    }
    await track(db, { orgId: req.orgId, userId: req.user.sub, type: 'workout_template_created', data: { templateId: tId } });
    res.status(201).json({ id: tId });
  });

  r.post('/templates/:id/duplicate', trainerOnly, async (req, res) => {
    const t = await db.q1('SELECT * FROM workout_templates WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const tId = id('wkt');
    await db.run(
      `INSERT INTO workout_templates (id, org_id, trainer_id, name, type, notes, is_global, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [tId, req.orgId, req.user.sub, t.name + ' (copy)', t.type, t.notes, now()]);
    const exs = await db.q('SELECT * FROM workout_exercises WHERE template_id = ? ORDER BY position', [t.id]);
    for (const ex of exs) {
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('wxe'), tId, ex.exercise_id, ex.position, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo, ex.notes]);
    }
    res.status(201).json({ id: tId });
  });

  // ---- client workouts ----
  r.get('/clients/:id/workouts', trainerOnly, async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const workouts = await db.q(
      'SELECT * FROM workouts WHERE client_id = ? ORDER BY scheduled_date DESC LIMIT ? OFFSET ?', [client.id, limit, offset]);
    // bulk exercise fetch — one query for all workouts, grouped in memory (kills the per-workout N+1)
    const exs = workouts.length
      ? await db.q(
          `SELECT we.*, el.animation_key, el.primary_muscle
             FROM workout_exercises we
             LEFT JOIN exercise_library el ON el.id = we.exercise_id
            WHERE we.workout_id IN (${workouts.map(() => '?').join(',')})
            ORDER BY we.position`, workouts.map((w) => w.id))
      : [];
    const byWorkout = new Map();
    for (const e of exs) {
      if (!byWorkout.has(e.workout_id)) byWorkout.set(e.workout_id, []);
      byWorkout.get(e.workout_id).push(e);
    }
    res.json({ workouts: workouts.map((w) => ({ ...w, exercises: byWorkout.get(w.id) || [] })) });
  });

  // ---- assign a workout (from template or inline) ----
  r.post('/clients/:id/assign', trainerOnly, validate(schemas.workoutTemplate), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const wId = id('wko');
    const scheduled = req.body.scheduled_date || dayKey();
    await db.run(
      `INSERT INTO workouts (id, org_id, client_id, trainer_id, name, day_label, scheduled_date, status, created_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
      [wId, client.org_id, client.id, req.user.sub, req.body.name, req.body.day_label || null,
       scheduled, now(), req.body.notes || null]);
    for (let i = 0; i < req.body.exercises.length; i++) {
      const ex = req.body.exercises[i];
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('wxe'), wId, ex.exercise_id || null, i, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo || null, ex.notes || null]);
    }
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'workout_assigned', data: { clientId: client.id, workoutId: wId } });
    res.status(201).json({ id: wId });
  });

  // ---- update an assigned workout (trainer/owner only) ----
  // Only unstarted/assigned workouts can be modified. Completed workouts
  // are immutable — their history is preserved as-is.
  r.put('/clients/:clientId/workouts/:workoutId', trainerOnly, validate(schemas.workoutTemplate), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.clientId);
    if (!client) return;
    const w = await db.q1('SELECT * FROM workouts WHERE id = ? AND client_id = ?', [req.params.workoutId, client.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    if (w.status === 'completed') {
      return res.status(400).json({ error: 'Cannot modify a completed workout' });
    }
    if (w.status === 'missed') {
      return res.status(400).json({ error: 'Cannot modify a missed workout' });
    }
    // Update workout metadata
    const scheduled = req.body.scheduled_date || w.scheduled_date;
    const name = req.body.name || w.name;
    await db.run(
      `UPDATE workouts SET name = ?, day_label = ?, scheduled_date = ?, notes = ? WHERE id = ?`,
      [name, req.body.day_label || w.day_label, scheduled, req.body.notes ?? w.notes, w.id]);
    // Replace exercises: delete existing, insert new
    await db.run('DELETE FROM workout_exercises WHERE workout_id = ?', [w.id]);
    for (let i = 0; i < req.body.exercises.length; i++) {
      const ex = req.body.exercises[i];
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, template_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('wxe'), w.id, ex.exercise_id || null, i, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo || null, ex.notes || null]);
    }
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'workout_updated', data: { clientId: client.id, workoutId: w.id } });
    res.json({ ok: true, id: w.id });
  });

  // ---- delete/cancel an assigned workout (trainer/owner only) ----
  // Only unstarted workouts can be deleted. Completed workouts are never
  // deleted — their history (workout_logs, exercise_set_logs, PRs) must
  // be preserved. Deleting a missed workout is also safe.
  r.delete('/clients/:clientId/workouts/:workoutId', trainerOnly, async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.clientId);
    if (!client) return;
    const w = await db.q1('SELECT * FROM workouts WHERE id = ? AND client_id = ?', [req.params.workoutId, client.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    if (w.status === 'completed') {
      return res.status(400).json({ error: 'Cannot delete a completed workout — history must be preserved' });
    }
    // Delete exercises first (workout_exercises FK references workouts)
    await db.run('DELETE FROM workout_exercises WHERE workout_id = ?', [w.id]);
    await db.run('DELETE FROM workouts WHERE id = ?', [w.id]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'workout_deleted', data: { clientId: client.id, workoutId: w.id } });
    res.json({ ok: true });
  });

  // ---- client toggles an exercise "done" ----
  r.patch('/:wid/exercises/:exid', async (req, res) => {
    const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [req.params.wid]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const client = await resolveClient(db, req, res, w.client_id);
    if (!client) return;
    const cur = await db.q1('SELECT done FROM workout_exercises WHERE id = ? AND workout_id = ?', [req.params.exid, w.id]);
    if (!cur) return res.status(404).json({ error: 'Exercise not found' });
    await db.run('UPDATE workout_exercises SET done = ? WHERE id = ?', [cur.done ? 0 : 1, req.params.exid]);
    res.json({ ok: true, done: !cur.done });
  });

  // ---- start a workout: backend records the session start (source of truth) ----
  // Idempotent — a second call returns the existing started_at.
  r.post('/:id/start', async (req, res) => {
    const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const client = await resolveClient(db, req, res, w.client_id);
    if (!client) return;
    if (w.status === 'completed') {
      return res.json({ ok: true, workout_id: w.id, started_at: w.started_at, duration_min: w.duration_min, already_completed: true });
    }
    const startedAt = w.started_at || now();
    if (!w.started_at) await db.run('UPDATE workouts SET started_at = ? WHERE id = ?', [startedAt, w.id]);
    res.json({ ok: true, workout_id: w.id, started_at: startedAt });
  });

  /**
   * Save in-flight set ticks.
   *
   * WHY THIS EXISTS: ticked sets lived only in React state, so a refresh,
   * a phone lock that killed the tab, or an accidental back-swipe silently
   * discarded the whole session's progress -- while `started_at` survived
   * server-side, so the app cheerfully restored an "in progress" session
   * showing 0 sets done. Losing logged work is worse than not restoring
   * at all.
   *
   * Stored as opaque JSON rather than as exercise_set_logs rows on
   * purpose: these are DRAFT ticks that the user can still untick and
   * edit. Only `/complete` writes real set logs, so PRs, volume history
   * and the burn estimate stay derived exclusively from finished
   * sessions.
   */
  r.put('/:id/progress', validate(z.object({
    // Deliberately loose on the VALUE shape -- these are draft, per-exercise
    // set ticks stored as an opaque blob (see the comment above this route),
    // not a schema-worthy domain object. This only closes the type-confusion
    // gap (progress being a string/array/number instead of an object at
    // all) -- the actual byte-size protection is the manual cap below,
    // which a schema alone can't express as cleanly for a JSON.stringify'd blob.
    progress: z.record(z.string(), z.unknown()).optional()
  })), async (req, res) => {
    const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const client = await resolveClient(db, req, res, w.client_id);
    if (!client) return;
    if (w.completed_at) return res.status(409).json({ error: 'Workout already completed' });

    // Cap the payload: this is a handful of sets per exercise, and an
    // unbounded blob on a per-tick endpoint is an easy way to fill a disk.
    const body = JSON.stringify(req.body?.progress ?? {});
    if (body.length > 20000) return res.status(413).json({ error: 'Progress payload too large' });

    await db.run('UPDATE workouts SET progress_json = ? WHERE id = ?', [body, w.id]);
    res.json({ ok: true });
  });

  // ---- complete a workout with per-exercise, per-set logs ----
  // Atomic: workout_logs + exercise_set_logs + PRs + status + duration + calorie
  // estimate commit together (db.tx). Any failure rolls back EVERYTHING — a
  // workout is never left partially completed. Pattern mirrors /intel/confirm-workout.
  r.post('/:id/complete', validate(z_workoutComplete()), async (req, res) => {
    const w = await db.q1('SELECT * FROM workouts WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const client = await resolveClient(db, req, res, w.client_id);
    if (!client) return;
    if (w.status === 'completed') {
      // Idempotent retry (e.g. network drop after commit) — never double-log.
      return res.json({ ok: true, workoutId: w.id, alreadyCompleted: true, prs: [], duration_min: w.duration_min, calorie: calorieView(w) });
    }
    if (!Array.isArray(req.body.logs) || req.body.logs.length === 0) {
      return res.status(400).json({ error: 'logs required — log at least one set' });
    }
    const d = dayKey();
    const completedAt = now();
    // Server-authoritative timing: duration is measured ONLY from the DB
    // started_at (POST /start). A client-supplied started_at is NEVER accepted
    // — the client cannot influence duration. No /start => no measured duration
    // (duration_min stays null; an estimated duration is never substituted for
    // a measured session).
    const startedAt = w.started_at || null;
    let durationMin = null;
    if (startedAt) {
      const ms = Date.parse(completedAt) - Date.parse(startedAt);
      if (Number.isFinite(ms)) durationMin = ms > 0 ? Math.round((ms / 60000) * 10) / 10 : 0;
    }

    // Pre-fetch the session's exercises + library metadata once (kills the
    // per-log N+1 and feeds the calorie input with actual exercise metadata).
    const sessionExercises = await db.q(
      `SELECT we.*, el.ex_type, el.movement, el.equipment AS lib_equipment, el.primary_muscle AS lib_primary_muscle,
              el.animation_key AS lib_animation_key, el.is_global AS lib_is_global
         FROM workout_exercises we
         LEFT JOIN exercise_library el ON el.id = we.exercise_id
        WHERE we.workout_id = ?`, [w.id]);
    const byId = new Map(sessionExercises.map((e) => [e.id, e]));

    // Reject exercises that do not belong to this workout — never silently
    // ignore them. The response only echoes the client's own input, so no
    // cross-tenant information is leaked.
    const unknown = req.body.logs.find((l) => !byId.has(l.exercise_id));
    if (unknown) return res.status(422).json({ error: 'exercise_id does not belong to this workout', exercise_id: unknown.exercise_id });

    const prs = [];
    const txResult = await db.tx(async (tx) => {
      const allCompletedSets = []; // { exercise, set } — ACTUAL completed sets only
      for (const log of req.body.logs) {
        const ex = byId.get(log.exercise_id);
        if (!ex) continue;
        // normalize per-set rows (new shape) or synthesize from legacy aggregate
        let sets = [];
        let synthesized = 0;
        if (Array.isArray(log.sets) && log.sets.length) {
          sets = log.sets.map((s) => ({
            actual_weight: Number(s.actual_weight ?? parseFloat(ex.weight) ?? 0),
            actual_reps: Number(s.actual_reps ?? parseFloat(ex.reps) ?? 0),
            rir: s.rir ?? null,
            completed: s.completed === false ? 0 : 1
          }));
        } else {
          // legacy aggregate shape → synthesized rows, excluded from ML training
          synthesized = 1;
          const n = Math.max(1, log.sets_done ?? ex.sets ?? 1);
          const wgt = Number(log.weight ?? parseFloat(ex.weight) ?? 0);
          const reps = Number(log.reps ?? parseFloat(ex.reps) ?? 0);
          sets = Array.from({ length: n }, () => ({ actual_weight: wgt, actual_reps: reps, rir: log.rir ?? null, completed: 1 }));
        }
        if (!sets.length) continue;
        const wgtBest = Math.max(...sets.map((s) => Number(s.actual_weight) || 0));
        const repsBest = Math.max(...sets.map((s) => Number(s.actual_reps) || 0));
        const logId = id('wlg');
        const newPrs = ex.exercise_id ? await evaluatePRs(tx, client.id, ex.exercise_id, sets, d) : [];
        if (newPrs.length) prs.push({ name: ex.name, records: newPrs });
        await tx.run(
          `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, rir, notes, is_pr)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [logId, client.id, w.id, ex.exercise_id || null, d, sets.length, repsBest, wgtBest,
           log.rir ?? null, log.notes || null, newPrs.length ? 1 : 0]);
        const prescReps = parseFloat(ex.reps);
        const prescWgt = parseFloat(ex.weight);
        for (let i = 0; i < sets.length; i++) {
          const s = sets[i];
          await tx.run(
            `INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, prescribed_reps, actual_reps, prescribed_weight, actual_weight, rest_seconds, rir, completed, is_synthesized)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id('stl'), logId, client.id, ex.exercise_id || null, i + 1,
             Number.isFinite(prescReps) ? prescReps : null, s.actual_reps,
             Number.isFinite(prescWgt) ? prescWgt : null, s.actual_weight,
             ex.rest_sec || null, s.rir, s.completed, synthesized]);
          if (s.completed !== 0 && s.completed !== false) allCompletedSets.push({ exercise: ex, set: s });
        }
        await tx.run('UPDATE workout_exercises SET done = 1 WHERE id = ?', [ex.id]);
      }

      await tx.run(
        `UPDATE workouts SET status = 'completed', completed_at = ?, duration_min = ? WHERE id = ?`,
        [completedAt, durationMin, w.id]);

      // Calorie estimate from ACTUAL completed sets — never planned workload
      // (skipped exercises contribute 0 sets / 0 reps / 0 workload).
      let calorie = null;
      try {
        const bodyWeightKg = await resolveBodyWeight(tx, client.id, d);
        const setsByExercise = {};
        for (const { exercise, set } of allCompletedSets) {
          (setsByExercise[exercise.id] ||= []).push(set);
        }
        const input = buildWorkoutCalorieInput({
          client,
          workout: w,
          exercises: sessionExercises.map((e) => ({
            id: e.id, exercise_id: e.exercise_id, name: e.name, ex_type: e.ex_type, movement: e.movement,
            equipment: e.lib_equipment, primary_muscle: e.lib_primary_muscle,
            library: { ex_type: e.ex_type, movement: e.movement, equipment: e.lib_equipment, primary_muscle: e.lib_primary_muscle }
          })),
          setsByExercise,
          durationSeconds: durationMin != null ? durationMin * 60 : null,
          bodyWeightKg
        });
        // Exercise-ID canonicalization for the ml provider only (Phase 3B
        // Step 3) — built from the SAME already-fetched, org-scoped rows;
        // never trusts a custom (non-global) exercise's animation_key.
        const mlExerciseCanonical = {};
        for (const e of sessionExercises) {
          if (!e.exercise_id) continue;
          const token = mlCanonicalExerciseId({ animationKey: e.lib_animation_key, isGlobal: e.lib_is_global });
          if (token) mlExerciseCanonical[e.exercise_id] = token;
        }
        calorie = await estimateWorkoutCalories(input, { mlExerciseCanonical, db: tx, stage: 'completion' });
        if (calorie) await persistCalorieResult(tx, w.id, calorie);
      } catch (e) {
        // Calorie estimation/persistence must NEVER fail workout completion.
        // Log server-side only with safe correlation metadata (request id,
        // workout id, error message) — never bodies, user data, or ML output.
        calorie = null;
        console.error('[sk-os] calorie estimate failed', { req: req.id || null, workout: w.id, error: String(e?.message || e).slice(0, 500) });
      }
      return calorie;
    });

    await track(db, { orgId: w.org_id, userId: req.user.sub, type: 'workout_completed', data: { clientId: client.id, workoutId: w.id, prCount: prs.length, durationMin, estimatedKcal: txResult?.estimated_active_kcal ?? null } });
    res.json({ ok: true, prs, workoutId: w.id, duration_min: durationMin, calorie: txResult });
  });

  // ---- progressive overload suggestion ----
  r.get('/clients/:id/overload/:exerciseId', trainerOnly, async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const suggestion = await suggestNextTarget(db, client.id, req.params.exerciseId);
    res.json({ suggestion });
  });

  return r;
}

// Shape a persisted calorie result for API responses (same shape as
// todaySession's meta.calorie so the client contract stays consistent).
function calorieView(w) {
  if (!w || w.estimated_active_kcal == null) return null;
  return {
    schema_version: w.schema_version,
    estimated_active_kcal: w.estimated_active_kcal,
    lower_kcal: w.lower_kcal,
    upper_kcal: w.upper_kcal,
    model_version: w.model_version,
    provider: w.calorie_provider,
    source: 'persisted',
    estimated_at: w.calorie_estimated_at
  };
}

function z_workoutComplete() {
  return z.object({
    logs: z.array(z.object({
      exercise_id: z.string().min(1),
      // per-set shape (preferred)
      sets: z.array(z.object({
        set_number: z.number().int().min(1).optional(),
        actual_reps: z.number().min(0).max(200).optional(),
        actual_weight: z.number().min(0).max(1000).optional(),
        rir: z.number().int().min(0).max(5).optional(),
        completed: z.boolean().optional()
      })).max(20).optional(),
      // legacy aggregate shape (still accepted)
      sets_done: z.number().int().min(0).max(20).optional(),
      reps: z.number().min(0).max(200).optional(),
      weight: z.number().min(0).max(1000).optional(),
      rir: z.number().int().min(0).max(5).optional(),
      notes: z.string().max(200).optional()
    })).default([])
  });
}
