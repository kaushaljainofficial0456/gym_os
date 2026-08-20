import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, orgScope, resolveClient, hashPassword } from '../auth.js';
import { validate, schemas } from '../validate.js';
import { id, now } from '../ids.js';
import { dayKey, daysAgoIso, round1 } from '../utils/time.js';
import { computeAdherence } from '../services/adherence.js';
import { evaluateClient } from '../services/atRisk.js';
import { validateProgram } from '../services/programValidation.js';
import { track } from '../services/events.js';
import { rateLimit } from '../rateLimit.js';

export default function clientRoutes(db) {
  const r = Router();
  r.use(requireAuth, requireRole('GYM_OWNER', 'TRAINER', 'SUPER_ADMIN'), orgScope);
  const clientCreateLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => req.user?.sub || 'anon' });

  async function withEvaluation(c) {
    const ev = await evaluateClient(db, c);
    const user = await db.q1('SELECT name, email, avatar, phone FROM users WHERE id = ?', [c.user_id]);
    const lastWo = await db.q1(
      `SELECT scheduled_date FROM workouts WHERE client_id = ? AND status = 'completed' ORDER BY scheduled_date DESC LIMIT 1`, [c.id]);
    const w7 = await db.q(
      'SELECT date, weight FROM weight_logs WHERE client_id = ? AND date >= ? ORDER BY date', [c.id, daysAgoIso(7)]);
    const change7 = w7.length >= 2 ? round1(w7[w7.length - 1].weight - w7[0].weight) : null;
    return {
      id: c.id, name: user?.name || 'Client', email: user?.email, avatar: user?.avatar,
      age: c.age, sex: c.sex, goal: c.goal, trainerId: c.trainer_id,
      startWeight: c.start_weight, currentWeight: c.current_weight, targetWeight: c.target_weight,
      goalDate: c.goal_date, heightCm: c.height_cm,
      change7,
      adherence: ev.adherence.score,
      status: ev.status,
      lastWorkout: lastWo?.scheduled_date || null,
      lastCheckin: c.last_checkin_at,
      rules: ev.rules.slice(0, 3)
    };
  }

  // Bulk list builder: loads evaluations + user meta + last workout + 7-day
  // weight change for ALL rows in ~12 queries total (vs ~13 per client).
  async function withEvaluationBulk(rows) {
    if (!rows.length) return [];
    const { evaluateClients } = await import('../services/atRisk.js');
    const ids = rows.map((c) => c.id);
    const inClause = ids.map(() => '?').join(',');
    const evs = await evaluateClients(db, rows);
    const [users, lastWos, w7s] = await Promise.all([
      db.q(`SELECT id, name, email, avatar, phone FROM users WHERE id IN (${inClause})`, rows.map((c) => c.user_id)),
      db.q(`SELECT client_id, MAX(scheduled_date) AS d FROM workouts WHERE client_id IN (${inClause}) AND status = 'completed' GROUP BY client_id`, ids),
      db.q(`SELECT client_id, date, weight FROM weight_logs WHERE client_id IN (${inClause}) AND date >= ? ORDER BY client_id, date`, [...ids, daysAgoIso(7)])
    ]);
    const userBy = new Map(users.map((u) => [u.id, u]));
    const lastBy = new Map(lastWos.map((w) => [w.client_id, w.d]));
    const w7By = new Map();
    for (const w of w7s) { (w7By.get(w.client_id) || w7By.set(w.client_id, []).get(w.client_id)).push(w); }
    return rows.map((c) => {
      const ev = evs.get(c.id);
      const user = userBy.get(c.user_id);
      const w7 = w7By.get(c.id) || [];
      const change7 = w7.length >= 2 ? round1(w7[w7.length - 1].weight - w7[0].weight) : null;
      return {
        id: c.id, name: user?.name || 'Client', email: user?.email, avatar: user?.avatar,
        age: c.age, sex: c.sex, goal: c.goal, trainerId: c.trainer_id,
        startWeight: c.start_weight, currentWeight: c.current_weight, targetWeight: c.target_weight,
        goalDate: c.goal_date, heightCm: c.height_cm,
        change7,
        adherence: ev.adherence.score,
        status: ev.status,
        lastWorkout: lastBy.get(c.id) || null,
        lastCheckin: c.last_checkin_at,
        rules: (ev.rules || []).slice(0, 3)
      };
    });
  }

  // ---- list with search / filter / sort ----
  // TRAINER scoped: trainers only see clients assigned to them.
  // OWNER/ADMIN see all org clients (unchanged behavior).
  r.get('/', async (req, res) => {
    const { q = '', status = '', goal = '', trainer_id = '', sort = 'status' } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    let rows;
    if (req.user.role === 'TRAINER') {
      // Trainers only see clients assigned to them — no cross-trainer access
      rows = await db.q('SELECT * FROM clients WHERE org_id = ? AND trainer_id = ? ORDER BY created_at DESC LIMIT ?',
        [req.orgId, req.user.sub, limit]);
    } else {
      rows = await db.q('SELECT * FROM clients WHERE org_id = ? ORDER BY created_at DESC LIMIT ?', [req.orgId, limit]);
    }
    let out = await withEvaluationBulk(rows);
    if (q) out = out.filter(x => (x.name || '').toLowerCase().includes(String(q).toLowerCase()));
    if (status) out = out.filter(x => x.status === status);
    if (goal) out = out.filter(x => x.goal === goal);
    if (trainer_id) out = out.filter(x => x.trainerId === trainer_id);
    const sev = { ON_TRACK: 0, NEEDS_ATTENTION: 1, AT_RISK: 2, INACTIVE: 3 };
    if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'adherence') out.sort((a, b) => b.adherence - a.adherence);
    else if (sort === 'status') out.sort((a, b) => sev[b.status] - sev[a.status] || b.adherence - a.adherence);
    else if (sort === 'change') out.sort((a, b) => (b.change7 ?? 0) - (a.change7 ?? 0));
    res.json({ clients: out });
  });

  // ---- create ----
  r.post('/', clientCreateLimit, validate(schemas.clientCreate), async (req, res) => {
    const body = req.body;
    const userId = id('usr');
    const clientId = id('cli');
    const email = body.email.toLowerCase().trim();
    if (!body.password) return res.status(422).json({ error: 'Password is required for new client accounts' });
    const trainerId = body.trainer_id || (req.user.role === 'TRAINER' ? req.user.sub : null);
    try {
      await db.run(
        `INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
         VALUES (?, ?, ?, ?, 'CLIENT', ?, 1, ?)`,
        [userId, req.orgId, email, await hashPassword(body.password), body.name, now()]);
      await db.run(
        `INSERT INTO clients (id, user_id, org_id, trainer_id, status, goal, start_weight,
                              current_weight, target_weight, goal_date, height_cm, age, sex, created_at)
         VALUES (?, ?, ?, ?, 'ON_TRACK', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, userId, req.orgId, trainerId, body.goal, body.start_weight ?? null,
         body.start_weight ?? null, body.target_weight ?? null, body.goal_date ?? null, body.height_cm ?? null, body.age ?? null, body.sex ?? null, now()]);
      await db.run(
        `INSERT INTO client_profiles (client_id, meals_per_day, sleep_target_h, water_target_l) VALUES (?, 5, 8, 3)`,
        [clientId]);
      await track(db, { orgId: req.orgId, userId: req.user.sub, type: 'client_created', data: { clientId } });
      res.status(201).json({ client: await withEvaluation((await db.q1('SELECT * FROM clients WHERE id = ?', [clientId]))) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
      throw e;
    }
  });

  // ---- full profile bundle ----
  r.get('/:id/overview', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [client.id]);
    const ev = await evaluateClient(db, client);
    const [weights, measurements, photos, workoutHistory, insights] = await Promise.all([
      db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date', [client.id]),
      db.q('SELECT * FROM measurements WHERE client_id = ? ORDER BY taken_at DESC LIMIT 12', [client.id]),
      db.q('SELECT * FROM progress_photos WHERE client_id = ? ORDER BY taken_at', [client.id]),
      db.q('SELECT * FROM workouts WHERE client_id = ? ORDER BY scheduled_date DESC LIMIT 20', [client.id]),
      db.q('SELECT * FROM coach_insights WHERE client_id = ? ORDER BY created_at DESC LIMIT 10', [client.id])
    ]);
    res.json({
      client: {
        id: client.id, name: client.name, email: client.email, avatar: client.avatar, phone: client.phone,
        age: client.age, sex: client.sex, goal: client.goal,
        startWeight: client.start_weight, currentWeight: client.current_weight,
        targetWeight: client.target_weight, goalDate: client.goal_date, heightCm: client.height_cm,
        bmi: client.height_cm ? round1(client.current_weight / ((client.height_cm / 100) ** 2)) : null,
        lastCheckin: client.last_checkin_at, trainerId: client.trainer_id, status: ev.status
      },
      profile,
      adherence: ev.adherence,
      rules: ev.rules,
      weights,
      measurements,
      photos,
      workoutHistory
    });
  });

  // ---- update client (trainer_id, targets, status, name) ----
  r.patch('/:id/equipment', validate(z.object({
    equipment: z.array(z.string().max(40)).max(12)
  })), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    await db.run(
      `INSERT INTO client_profiles (client_id, equipment) VALUES (?, ?)
       ON CONFLICT (client_id) DO UPDATE SET equipment = excluded.equipment`,
      [client.id, JSON.stringify(req.body.equipment)]);
    res.json({ ok: true, equipment: req.body.equipment });
  });

  r.patch('/:id', validate(schemas.measurementUpdate), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const b = req.body;
    const sets = [];
    const vals = [];
    if (b.name !== undefined) { sets.push('name = ?'); vals.push(b.name); }
    if (b.weight !== undefined) { sets.push('current_weight = ?'); vals.push(b.weight); }
    if (b.target_weight !== undefined) { sets.push('target_weight = ?'); vals.push(b.target_weight); }
    if (b.goal_date !== undefined) { sets.push('goal_date = ?'); vals.push(b.goal_date); }
    if (b.status !== undefined) { sets.push('status = ?'); vals.push(b.status); }
    if (b.trainer_id !== undefined) { sets.push('trainer_id = ?'); vals.push(b.trainer_id); }
    if (sets.length) {
      vals.push(client.id);
      await db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
    if (b.weight !== undefined) {
      const d = dayKey();
      await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id('wlg'), client.id, d, b.weight, 'manual', now()]);
      await db.run('UPDATE clients SET last_checkin_at = ? WHERE id = ?', [now(), client.id]);
    }
    res.json({ ok: true });
  });

  // ---- weight logs ----
  r.get('/:id/weights', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const rows = await db.q('SELECT date, weight, source FROM weight_logs WHERE client_id = ? ORDER BY date', [client.id]);
    res.json({ weights: rows });
  });

  r.post('/:id/weights', validate(schemas.weightLog), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const d = req.body.date || dayKey();
    await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id('wlg'), client.id, d, req.body.weight, req.body.source, now()]);
    await db.run('UPDATE clients SET current_weight = ?, last_checkin_at = ? WHERE id = ?',
      [req.body.weight, now(), client.id]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'checkin_completed', data: { clientId: client.id } });
    res.status(201).json({ ok: true });
  });

  // ---- measurements ----
  r.get('/:id/measurements', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    res.json({ measurements: await db.q('SELECT * FROM measurements WHERE client_id = ? ORDER BY taken_at', [client.id]) });
  });

  r.post('/:id/measurements', validate(schemas.measurement), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const b = req.body;
    await db.run(
      `INSERT INTO measurements (id, client_id, taken_at, weight, waist, chest, arms, thighs, hips, neck)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('mea'), client.id, b.taken_at || now(), b.weight ?? null, b.waist ?? null, b.chest ?? null,
       b.arms ?? null, b.thighs ?? null, b.hips ?? null, b.neck ?? null]);
    if (b.weight) {
      await db.run('UPDATE clients SET current_weight = ?, last_checkin_at = ? WHERE id = ?', [b.weight, now(), client.id]);
      await db.run('INSERT INTO weight_logs (id, client_id, date, weight, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id('wlg'), client.id, dayKey(), b.weight, 'manual', now()]);
    }
    res.status(201).json({ ok: true });
  });

  // ---- progress photos ----
  r.get('/:id/photos', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const { objectUrl } = await import('../storage.js');
    const rows = await db.q('SELECT id, view, taken_at, storage_key, data_url, is_before FROM progress_photos WHERE client_id = ? ORDER BY taken_at', [client.id]);
    res.json({ photos: rows.map((p) => ({
      id: p.id, view: p.view, taken_at: p.taken_at, is_before: p.is_before,
      imageUrl: objectUrl(p.storage_key) || p.data_url || null
    })) });
  });

  r.post('/:id/photos', validate(schemas.photo), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const photoId = id('pho');
    // Images are stored as private files (storage_key), never as base64 in the
    // DB. The client still sends a data URL; the server converts + validates it.
    const { saveImage } = await import('../storage.js');
    let storageKey = null;
    let storage = 'data_url';
    try {
      const saved = await saveImage({ dataUrl: req.body.data_url, clientId: client.id, scope: 'photos', fileId: photoId });
      storageKey = saved.storageKey;
      storage = saved.storage;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await db.run(
      `INSERT INTO progress_photos (id, client_id, view, taken_at, storage_key, storage, is_before)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [photoId, client.id, req.body.view, req.body.taken_at || now(), storageKey, storage, req.body.is_before ? 1 : 0]);
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'photo_uploaded', data: { clientId: client.id, storage } });
    res.status(201).json({ ok: true, imageUrl: `/uploads/${storageKey}` });
  });

  r.delete('/:id/photos/:photoId', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const row = await db.q1('SELECT storage_key FROM progress_photos WHERE id = ? AND client_id = ?', [req.params.photoId, client.id]);
    await db.run('DELETE FROM progress_photos WHERE id = ? AND client_id = ?', [req.params.photoId, client.id]);
    const { deleteObject } = await import('../storage.js');
    if (row?.storage_key) await deleteObject(row.storage_key);
    res.json({ ok: true });
  });

  // ---- weekly muscle volume analysis (trainer guidance) ----
  r.get('/:id/volume', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const days = Math.min(14, Math.max(1, parseInt(req.query.days) || 7));
    const { weeklyVolume } = await import('../services/volumeAnalysis.js');
    res.json({ volume: await weeklyVolume(db, client.id, { days }) });
  });

  // ---- client equipment profile ----
  r.get('/:id/equipment', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const { parseAvailable, checkExercises, EQUIPMENT_ITEMS } = await import('../services/equipment.js');
    const profile = await db.q1('SELECT equipment FROM client_profiles WHERE client_id = ?', [client.id]);
    const available = parseAvailable(profile?.equipment);
    // exercises in the client's active program (for this week's schedule)
    const prog = await db.q1('SELECT * FROM training_programs WHERE client_id = ? AND active = 1 LIMIT 1', [client.id]);
    let programExercises = [];
    if (prog) {
      const days = await db.q('SELECT template_id FROM training_days WHERE program_id = ? AND template_id IS NOT NULL', [prog.id]);
      const tplIds = days.map(d => d.template_id);
      if (tplIds.length) {
        programExercises = await db.q(
          `SELECT el.id, we.name, el.equipment FROM workout_exercises we
            LEFT JOIN exercise_library el ON el.id = we.exercise_id
            WHERE we.template_id IN (${tplIds.map(() => '?').join(',')})
            GROUP BY el.id, we.name, el.equipment`, tplIds);
      }
    }
    const issues = checkExercises(programExercises, profile?.equipment);
    res.json({
      items: EQUIPMENT_ITEMS,
      available: [...available],
      full_gym: available.has('full_gym'),
      issues
    });
  });

  // ---- training program ----
  r.get('/:id/program', async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    const prog = await db.q1(
      'SELECT * FROM training_programs WHERE client_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', [client.id]);
    const days = prog ? await db.q('SELECT * FROM training_days WHERE program_id = ? ORDER BY day_of_week', [prog.id]) : [];
    res.json({ program: prog ? { ...prog, days } : null });
  });

  r.put('/:id/program', validate(z.object({
    name: z.string().min(1).max(100),
    split: z.string().max(50).default('CUSTOM'),
    goal: z.string().max(50).optional(),
    experience: z.string().max(50).optional(),
    equipment: z.string().max(200).optional(),
    days_per_week: z.number().int().min(1).max(7).optional(),
    days: z.array(z.object({
      day_of_week: z.number().int().min(0).max(6),
      name: z.string().min(1).max(60),
      focus_muscles: z.string().max(200).optional(),
      template_id: z.string().nullable().optional()
    })).max(7).default([])
  })), async (req, res) => {
    const client = await resolveClient(db, req, res, req.params.id);
    if (!client) return;
    // ---- program integrity validation (backend, not just UI) ----
    const b = req.body;
    const v = validateProgram(b);
    if (!v.ok) {
      return res.status(422).json({ error: 'Invalid training program', issues: v.errors });
    }
    const trainingDays = b.days.filter(d => d.template_id);
    // template_ids must exist in this org (tenant-safe)
    const tplIds = [...new Set(trainingDays.map(d => d.template_id))];
    const placeholders = tplIds.map(() => '?').join(',');
    const found = await db.q(
      `SELECT id FROM workout_templates WHERE id IN (${placeholders}) AND org_id = ?`, [...tplIds, client.org_id]);
    if (found.length !== tplIds.length) {
      return res.status(422).json({ error: 'One or more template_ids do not exist in this organization' });
    }

    const old = await db.q1('SELECT * FROM training_programs WHERE client_id = ? AND active = 1 LIMIT 1', [client.id]);
    if (old) {
      await db.run('UPDATE training_programs SET active = 0 WHERE id = ?', [old.id]);
    }
    const pId = id('tpr');
    await db.run(
      `INSERT INTO training_programs (id, org_id, client_id, trainer_id, name, split, goal, experience, equipment, days_per_week, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [pId, client.org_id, client.id, req.user.sub, b.name, b.split,
       b.goal || null, b.experience || null, b.equipment || null,
       b.days_per_week || trainingDays.length, now()]);
    for (let i = 0; i < b.days.length; i++) {
      const d = b.days[i];
      await db.run(
        `INSERT INTO training_days (id, program_id, day_of_week, name, focus_muscles, template_id, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id('tdy'), pId, d.day_of_week, d.name, d.focus_muscles || null, d.template_id || null, i]);
    }
    await track(db, { orgId: client.org_id, userId: req.user.sub, type: 'program_assigned', data: { clientId: client.id, programId: pId, split: b.split } });
    res.status(201).json({ id: pId });
  });

  return r;
}
