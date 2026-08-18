// ============================================================
// CLIENT PERSONALIZATION — "MY FITNESS OS"
//   * custom dashboard preferences (show/hide/reorder cards)
//   * personal metrics (waist, steps, bench press, ...) + entries
//   * my foods (client-owned additions to the food library)
//   * my meals (client-owned meal templates — any slots/times)
//   * my workouts (client-built sessions, source = client_custom)
//   * live gym crowd (attendance events → current occupancy)
// Every entity is scoped to org_id + client_id (tenant + owner safe).
// ============================================================
import { Router } from 'express';
import { requireAuth, orgScope } from '../auth.js';
import { id, now } from '../ids.js';
import { dayKey, getOrgTz } from '../utils/time.js';
import { track } from '../services/events.js';
import { computeOccupancy } from '../services/occupancy.js';
import {
  searchFoods as searchFoodModel,
  modelAvailable as foodModelAvailable,
  resolveFoodQuantity,
} from '../services/foodEstimator.js';

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default function meRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);

  const getClient = async (req, res) => {
    const c = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!c) { res.status(404).json({ error: 'No client profile linked to this account' }); return null; }
    return c;
  };

  // ---------------- personal profile / goal --------------
  r.get('/profile', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const p = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [c.id]);
    res.json({ client: c, profile: p || {} });
  });

  r.put('/profile', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { goal, target_weight, goal_date, experience, equipment, water_target_l, sleep_target_h, height_cm } = req.body || {};
    const GOALS = ['FAT_LOSS', 'MUSCLE_GAIN', 'RECOMP', 'STRENGTH', 'GENERAL'];
    const EXP = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
    if (goal !== undefined && !GOALS.includes(goal)) return res.status(400).json({ error: 'Invalid goal' });
    if (experience !== undefined && !EXP.includes(experience)) return res.status(400).json({ error: 'Invalid experience level' });
    const sets = [];
    const params = [];
    if (goal !== undefined) { sets.push('goal = ?'); params.push(goal); }
    if (target_weight !== undefined) { sets.push('target_weight = ?'); params.push(num(target_weight)); }
    if (goal_date !== undefined) { sets.push('goal_date = ?'); params.push(goal_date ? String(goal_date).slice(0, 10) : null); }
    if (height_cm !== undefined) { sets.push('height_cm = ?'); params.push(num(height_cm)); }
    if (sets.length) {
      params.push(c.id);
      await db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    const psets = [];
    const pparams = [];
    if (experience !== undefined) { psets.push('experience = ?'); pparams.push(experience); }
    if (equipment !== undefined) { psets.push('equipment = ?'); pparams.push(JSON.stringify(equipment)); }
    if (water_target_l !== undefined) { psets.push('water_target_l = ?'); pparams.push(num(water_target_l)); }
    if (sleep_target_h !== undefined) { psets.push('sleep_target_h = ?'); pparams.push(num(sleep_target_h)); }
    if (psets.length) {
      const cols = psets.map(s => s.split(' = ')[0]);
      await db.run(
        `INSERT INTO client_profiles (client_id, ${cols.join(', ')})
         VALUES (?, ${cols.map(() => '?').join(', ')})
         ON CONFLICT(client_id) DO UPDATE SET ${psets.join(', ')}`,
        [c.id, ...pparams, ...pparams]);
    }
    track(db, 'client_profile_updated', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ ok: true });
  });

  // ---------------- dashboard preferences ----------------
  r.get('/dashboard', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const prefs = await db.q1('SELECT * FROM dashboard_preferences WHERE client_id = ?', [c.id]);
    res.json({ prefs: prefs || { client_id: c.id, order_list: '[]', hidden: '[]' } });
  });

  r.put('/dashboard', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { order = [], hidden = [] } = req.body || {};
    if (!Array.isArray(order) || !Array.isArray(hidden)) {
      return res.status(400).json({ error: 'order and hidden must be arrays' });
    }
    await db.run(
      `INSERT INTO dashboard_preferences (client_id, order_list, hidden, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET order_list=excluded.order_list, hidden=excluded.hidden, updated_at=excluded.updated_at`,
      [c.id, JSON.stringify(order), JSON.stringify(hidden), now()]);
    track(db, 'dashboard_customized', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ ok: true });
  });

  // ---------------- personal metrics ----------------
  r.get('/metrics', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const metrics = await db.q('SELECT * FROM custom_metrics WHERE client_id = ? ORDER BY created_at', [c.id]);
    // bulk entries fetch — one query for all metrics, then group in memory (kills the per-metric N+1)
    let entries = [];
    if (metrics.length) {
      entries = await db.q(
        `SELECT * FROM metric_entries WHERE metric_id IN (${metrics.map(() => '?').join(',')}) ORDER BY date DESC, created_at DESC LIMIT 200`,
        metrics.map((m) => m.id));
    }
    const byMetric = new Map();
    for (const e of entries) {
      if (!byMetric.has(e.metric_id)) byMetric.set(e.metric_id, []);
      byMetric.get(e.metric_id).push(e);
    }
    res.json({
      metrics: metrics.map((m) => {
        const es = byMetric.get(m.id) || [];
        return { ...m, entries: es.slice(0, 14), latest: es[0] || null, entriesCount: es.length };
      })
    });
  });

  r.post('/metrics', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { name, unit, frequency = 'weekly', target, type = 'number' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Metric name is required' });
    const TYPES = ['number', 'count', 'duration', 'boolean'];
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Invalid metric type' });
    const mId = id('mtr');
    await db.run(
      'INSERT INTO custom_metrics (id, org_id, client_id, name, unit, frequency, target, type, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [mId, c.org_id, c.id, String(name).trim().slice(0, 60), unit ? String(unit).slice(0, 20) : null,
       String(frequency).slice(0, 20), num(target), type, now()]);
    track(db, 'custom_metric_created', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ id: mId });
  });

  r.post('/metrics/:id/entries', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM custom_metrics WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    const { value, date, notes } = req.body || {};
    const v = num(value);
    if (v === null) return res.status(400).json({ error: 'value is required' });
    const tz = req.tz || 'Asia/Kolkata';
    const entryId = id('men');
    await db.run(
      'INSERT INTO metric_entries (id, org_id, client_id, metric_id, value, date, notes, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [entryId, c.org_id, c.id, m.id, v, date ? String(date).slice(0, 10) : dayKey(new Date(), tz), notes ? String(notes).slice(0, 200) : null, now()]);
    track(db, 'metric_entry_logged', req.user.org, req.user.sub, { client_id: c.id, metric_id: m.id });
    res.json({ id: entryId });
  });

  r.put('/metrics/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM custom_metrics WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    const { name, unit, frequency, target, type, color } = req.body || {};
    const TYPES = ['number', 'count', 'duration', 'boolean'];
    if (type !== undefined && !TYPES.includes(type)) return res.status(400).json({ error: 'Invalid metric type' });
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(String(name).trim().slice(0, 60)); }
    if (unit !== undefined) { sets.push('unit = ?'); params.push(unit ? String(unit).slice(0, 20) : null); }
    if (frequency !== undefined) { sets.push('frequency = ?'); params.push(String(frequency).slice(0, 20)); }
    if (target !== undefined) { sets.push('target = ?'); params.push(num(target)); }
    if (type !== undefined) { sets.push('type = ?'); params.push(type); }
    if (color !== undefined) { sets.push('color = ?'); params.push(String(color).slice(0, 20)); }
    if (sets.length) {
      params.push(m.id);
      await db.run(`UPDATE custom_metrics SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    res.json({ ok: true });
  });

  r.delete('/metrics/:id/entries/:entryId', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM custom_metrics WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    await db.run('DELETE FROM metric_entries WHERE id = ? AND metric_id = ? AND client_id = ?', [req.params.entryId, m.id, c.id]);
    res.json({ ok: true });
  });

  r.delete('/metrics/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM custom_metrics WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Metric not found' });
    await db.run('DELETE FROM metric_entries WHERE metric_id = ?', [m.id]);
    await db.run('DELETE FROM custom_metrics WHERE id = ?', [m.id]);
    res.json({ ok: true });
  });

  // ---------------- my foods ----------------
  r.get('/foods', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const mine = await db.q('SELECT * FROM foods WHERE client_id = ? ORDER BY name', [c.id]);
    const gym = await db.q(
      'SELECT * FROM foods WHERE client_id IS NULL AND org_id = ? AND is_global = 0 ORDER BY name LIMIT 100', [c.org_id]);
    const global = await db.q('SELECT * FROM foods WHERE is_global = 1 ORDER BY name LIMIT 200', []);
    res.json({ mine, gym, global });
  });

  /**
   * Model-backed food search.
   *
   * WHY THIS EXISTS: `GET /foods` above returns rows from the `foods`
   * TABLE, capped at 100 gym + 200 global. That is the entire library the
   * picker could see, so ordinary foods -- maggi, avocado, oreo -- were
   * simply absent, and the UI rendered the miss as 0 kcal. Meanwhile
   * skos-food-v1 has all three with lab/label values. The picker was
   * searching the wrong corpus.
   *
   * Results are shaped like `foods` rows so the existing picker can render
   * them unchanged, and each carries `source_id` so it can be materialised
   * on add (see POST /foods/from-model).
   */
  r.get('/foods/search', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ foods: [] });

    /* PRECEDENCE, and this distinction matters a lot:
       Only the client's OWN foods outrank the catalogue. A client who
       entered "my protein shake" means THAT, not a lookalike.
       Gym/global rows do NOT outrank it. Those are the hand-typed seed
       library the model exists to supersede, and letting them win
       reintroduces exactly the errors this work removed -- the seeded
       "Paneer" row says 265 kcal against a lab-measured 305.4, and
       "Avocado" says 240 against 160. Ranking them first would have shown
       the wrong number while appearing to work. */
    const mine = await db.q(
      `SELECT * FROM foods
        WHERE client_id = ? AND lower(name) LIKE ?
        ORDER BY name LIMIT 5`,
      [c.id, `%${q.toLowerCase()}%`]);

    // Gym/global rows are a FALLBACK, used only for names the catalogue
    // does not cover at all (a gym's own supplement, say).
    const library = await db.q(
      `SELECT * FROM foods
        WHERE client_id IS NULL AND (org_id = ? OR is_global = 1)
          AND lower(name) LIKE ?
        ORDER BY name LIMIT 8`,
      [c.org_id, `%${q.toLowerCase()}%`]);

    let model = [];
    if (foodModelAvailable()) {
      model = searchFoodModel(q, { limit: 10 }).map((f) => ({
        // No `id` on purpose -- these are not yet rows. The picker must
        // call /foods/from-model to obtain one, which is what keeps
        // meal_items.food_id referentially honest.
        source_id: f.source_id,
        name: f.food_name,
        serving: '100 g',
        unit: 'g',
        piece_g: f.serving_grams || null,
        calories: f.energy_kcal,
        protein: f.protein_g,
        carbs: f.carb_g,
        fat: f.fat_g,
        fiber: f.fiber_g,
        sugar: f.sugar_g,
        sodium: f.sodium_mg,
        brand: f.brand || null,
        source: 'VERIFIED_DATABASE',
        category: f.category || null,
        cuisine: f.cuisine || null,
        // Passed through so the UI can honour CONTRACT §3.2 rather than
        // presenting a weak match as a firm number.
        confidence: f.confidence,
        trustworthy: f.trustworthy !== false,
        cooking_state: f.cooking_state || null,
        data_quality_flag: f.data_quality_flag || null,
        match_kind: f.match_kind || null,
        // Food-specific portion sizes (CONTRACT §3.4b). A bowl of dal is
        // 250 g and a bowl of spinach 62 g, so this cannot be a global
        // table the client caches -- it ships per result.
        portions: f.portions || [],
        // Only cooked dishes can meaningfully take an oil adjustment;
        // telling the user they can add oil to an apple is noise.
        oil_applicable: f.cooking_state === 'cooked' || f.cuisine === 'INDIAN',
      }));
    }

    // Order: the client's own foods, then the measured catalogue, then any
    // library row the catalogue did not already cover by name.
    const norm = (n) => String(n).toLowerCase().trim();
    const claimed = new Set([...mine, ...model].map((f) => norm(f.name)));
    res.json({
      foods: [
        ...mine,
        ...model.filter((f) => !new Set(mine.map((m) => norm(m.name))).has(norm(f.name))),
        ...library.filter((f) => !claimed.has(norm(f.name))),
      ],
      model_available: foodModelAvailable(),
    });
  });

  /**
   * Resolve a chosen portion (and optional oil level) into grams and final
   * macros, WITHOUT logging anything.
   *
   * The client could not do this itself and should not try: portion ->
   * grams depends on the food's own density and measured serving weight,
   * and the oil adjustment is applied as a DELTA from the dish's own
   * recipe oil so selecting "low" on an already-oily dish correctly
   * REDUCES calories rather than adding a second helping. Both live in the
   * calibrated model; re-implementing either in the UI is how the numbers
   * drift apart.
   */
  r.post('/foods/resolve', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    if (!foodModelAvailable()) return res.status(503).json({ error: 'Food model not available' });
    const { source_id, name, portion_key, count = 1, grams, oil_level } = req.body || {};

    const hits = searchFoodModel(name || source_id || '', { limit: 25 });
    const food = (source_id && hits.find((x) => x.source_id === source_id)) || hits[0];
    if (!food) return res.status(404).json({ error: 'No matching food' });

    const resolved = resolveFoodQuantity(food, { portionKey: portion_key, count, grams, oilLevel: oil_level });
    if (!resolved) return res.status(422).json({ error: 'Could not resolve that quantity for this food' });
    res.json(resolved);
  });

  /**
   * Materialise a catalogue food into the `foods` table so it can be
   * logged. Returns an existing row if one already matches, so repeatedly
   * logging maggi does not accumulate duplicates.
   *
   * Written as a client-owned row (not global): the catalogue is the
   * source of truth and re-derivable, so polluting the shared global
   * library from a user action would be the wrong default.
   */
  r.post('/foods/from-model', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    if (!foodModelAvailable()) return res.status(503).json({ error: 'Food model not available' });
    const { source_id, name } = req.body || {};
    if (!source_id && !name) return res.status(400).json({ error: 'source_id or name is required' });

    const hits = searchFoodModel(name || source_id, { limit: 25 });
    const f = (source_id && hits.find((x) => x.source_id === source_id)) || hits[0];
    if (!f) return res.status(404).json({ error: 'No matching food in the catalogue' });

    /* Reuse only the CLIENT'S OWN row, never a global/gym one.
       Matching `is_global = 1` here reintroduced the precedence bug the
       search endpoint just fixed, one layer down and worse: search showed
       the catalogue's lab-measured Paneer at 305 kcal, but adding it
       returned the seeded global row at 265, so the figure the user saw
       and the figure that got logged silently disagreed. */
    const existing = await db.q1(
      `SELECT * FROM foods WHERE lower(name) = ? AND client_id = ? LIMIT 1`,
      [String(f.food_name).toLowerCase(), c.id]);
    if (existing) return res.json({ food: existing, created: false });

    const fId = id('food');
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, piece_g,
                          calories, protein, carbs, fat, fiber, sugar, sodium,
                          brand, source, category, cuisine, is_global)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      /* Every nullable value is coerced with `?? null`. node:sqlite refuses
         to bind `undefined` -- it accepts null but throws "Provided value
         cannot be bound to SQLite parameter N" on undefined -- and a
         catalogue row legitimately omits nutrients nobody measured. The
         first version bound f.sugar_g straight through and 500'd on every
         food without a sugar figure, which is most of them.
         `?? null` (not `|| null`) so a real 0 survives as 0. */
      [fId, c.org_id, c.id, String(f.food_name).slice(0, 80), 'g', '100 g',
       f.serving_grams ?? null, f.energy_kcal ?? null, f.protein_g ?? null,
       f.carb_g ?? null, f.fat_g ?? null, f.fiber_g ?? null, f.sugar_g ?? null,
       f.sodium_mg ?? null, f.brand ?? null,
       'VERIFIED_DATABASE', f.category ?? null, f.cuisine ?? null]);
    const food = await db.q1('SELECT * FROM foods WHERE id = ?', [fId]);
    res.status(201).json({ food, created: true });
  });

  r.post('/foods', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { name, unit, serving, calories, protein, carbs, fat, category } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Food name is required' });
    const fId = id('food');
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, unit, serving, calories, protein, carbs, fat, category, is_global)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
      [fId, c.org_id, c.id, String(name).trim().slice(0, 80), unit ? String(unit).slice(0, 30) : null,
       serving ? String(serving).slice(0, 60) : null, num(calories), num(protein), num(carbs), num(fat),
       category ? String(category).slice(0, 40) : null]);
    track(db, 'custom_food_created', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ id: fId });
  });

  r.delete('/foods/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    await db.run('DELETE FROM foods WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    res.json({ ok: true });
  });

  // ---------------- my meal templates ----------------
  r.get('/meals', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const meals = await db.q(
      `SELECT t.*, (SELECT COUNT(*) FROM meal_items mi WHERE mi.meal_template_id = t.id) item_count
         FROM client_meal_templates t WHERE t.client_id = ? ORDER BY t.position`, [c.id]);
    res.json({ meals });
  });

  r.post('/meals', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { slot, name, time, calories, protein, carbs, fat, foods } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Meal name is required' });
    const mId = id('cmt');
    await db.run(
      `INSERT INTO client_meal_templates (id, org_id, client_id, slot, name, time, calories, protein, carbs, fat, foods, position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, COALESCE((SELECT MAX(position)+1 FROM client_meal_templates WHERE client_id = ?), 0))`,
      [mId, c.org_id, c.id, String(slot || 'Meal').slice(0, 30), String(name).trim().slice(0, 80),
       time ? String(time).slice(0, 10) : null, num(calories) || 0, num(protein) || 0, num(carbs) || 0, num(fat) || 0,
       foods ? String(foods).slice(0, 300) : null, c.id]);
    res.json({ id: mId });
  });

  // Log a client meal template as eaten today (drives the calorie ring + macros).
  r.post('/meals/:id/log', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const tz = req.tz || 'Asia/Kolkata';
    const d = dayKey(new Date(), tz);
    const lId = id('mlg');
    await db.run(
      `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,1,'custom')`,
      [lId, c.id, d, m.slot, m.name, m.calories, m.protein, m.carbs, m.fat]);
    track(db, 'meal_logged', req.user.org, req.user.sub, { client_id: c.id, source: 'client_custom' });
    res.json({ id: lId });
  });

  r.delete('/meals/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    await db.run('DELETE FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    res.json({ ok: true });
  });

  // ---------------- my custom workouts ----------------
  r.get('/workouts', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const ws = await db.q(
      `SELECT w.*, (SELECT COUNT(*) FROM workout_exercises we WHERE we.workout_id = w.id) exercise_count,
              (SELECT COUNT(*) FROM workout_logs wl WHERE wl.workout_id = w.id) log_count
         FROM workouts w WHERE w.client_id = ? AND w.source = 'client_custom' ORDER BY w.scheduled_date DESC`, [c.id]);
    res.json({ workouts: ws });
  });

  // Build a client's own workout for today (becomes "today's session" via /me/today).
  r.post('/workouts', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { name, exercises } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Workout name is required' });
    if (!Array.isArray(exercises) || exercises.length === 0) return res.status(400).json({ error: 'Add at least one exercise' });
    if (exercises.length > 20) return res.status(400).json({ error: 'Too many exercises (max 20)' });
    const tz = req.tz || 'Asia/Kolkata';
    const d = dayKey(new Date(), tz);
    const wId = id('wko');
    await db.run(
      `INSERT INTO workouts (id, org_id, client_id, name, day_label, scheduled_date, status, source, created_at)
       VALUES (?,?,?,?,?,?,'assigned', 'client_custom', ?)`,
      [wId, c.org_id, c.id, String(name).trim().slice(0, 80), String(name).trim().slice(0, 40), d, now()]);
    let added = 0;
    for (const [i, ex] of exercises.entries()) {
      // scoped: only GLOBAL exercises or this gym's own — never another org's
      const lib = await db.q1('SELECT * FROM exercise_library WHERE id = ? AND (is_global = 1 OR org_id = ?)', [ex.exercise_id, c.org_id]);
      if (!lib) continue;
      const sets = Math.max(1, Math.min(12, parseInt(ex.sets, 10) || 3));
      const reps = String(ex.reps ?? lib.default_reps ?? 10).slice(0, 12);
      const weight = String(ex.weight ?? 'BW').slice(0, 12);
      const rest = Math.max(15, Math.min(600, parseInt(ex.rest_sec, 10) || 90));
      await db.run(
        `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id('wxe'), wId, lib.id, i, lib.name, sets, reps, weight, rest]);
      added++;
    }
    if (added === 0) { await db.run('DELETE FROM workouts WHERE id = ?', [wId]); return res.status(400).json({ error: 'No valid exercises found in the library' }); }
    // replace any un-logged custom workout already scheduled for today
    await db.run(
      `DELETE FROM workouts WHERE client_id = ? AND source = 'client_custom' AND status = 'assigned' AND scheduled_date = ? AND id != ?
         AND NOT EXISTS (SELECT 1 FROM workout_logs wl WHERE wl.workout_id = workouts.id)`, [c.id, d, wId]);
    track(db, 'custom_workout_created', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ id: wId, scheduled_date: d });
  });

  r.delete('/workouts/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const w = await db.q1('SELECT * FROM workouts WHERE id = ? AND client_id = ? AND source = ?', [req.params.id, c.id, 'client_custom']);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    if (w.status === 'completed') return res.status(400).json({ error: 'Completed workouts cannot be deleted' });
    await db.run('DELETE FROM workout_exercises WHERE workout_id = ?', [w.id]);
    await db.run('DELETE FROM workouts WHERE id = ?', [w.id]);
    res.json({ ok: true });
  });

  // ---------------- effective permissions (gym defaults → client) ----------------
  r.get('/permissions', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const s = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [c.org_id]);
    const g = s || {};
    const mode = g.workout_mode_default || 'hybrid';
    res.json({
      workout_mode: mode,                       // prescribed | hybrid | custom
      allow_substitute: g.allow_substitute !== 0 && g.allow_substitute !== false,
      allow_add_exercise: g.allow_add_exercise !== 0 && g.allow_add_exercise !== false,
      allow_edit_targets: g.allow_edit_targets !== 0 && g.allow_edit_targets !== false,
      can_create_workout: mode !== 'prescribed' && (g.allow_add_exercise === undefined || g.allow_add_exercise !== 0)
    });
  });

  // ---------------- live gym crowd (occupancy engine) ----------------
  r.get('/crowd', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const settings = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [c.org_id]);
    const snapshot = await computeOccupancy(db, c.org_id, req.tz, settings);
    res.json(snapshot);
  });

  // ---------------- personal workout planner (reusable workouts + weekly schedule) ----------------
  r.get('/planner', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const [workouts, schedule] = await Promise.all([
      db.q('SELECT * FROM client_workouts WHERE client_id = ? ORDER BY created_at', [c.id]),
      db.q('SELECT day_of_week, workout_id FROM client_workout_schedule WHERE client_id = ?', [c.id])
    ]);
    const exIds = workouts.map((w) => w.id);
    const exercises = exIds.length
      ? await db.q(`SELECT * FROM client_workout_exercises WHERE workout_id IN (${exIds.map(() => '?').join(',')}) ORDER BY workout_id, position`, exIds)
      : [];
    const byWorkout = new Map();
    for (const ex of exercises) {
      if (!byWorkout.has(ex.workout_id)) byWorkout.set(ex.workout_id, []);
      byWorkout.get(ex.workout_id).push(ex);
    }
    res.json({
      workouts: workouts.map((w) => ({ ...w, exercises: byWorkout.get(w.id) || [] })),
      schedule: schedule.map((s) => ({ day_of_week: s.day_of_week, workout_id: s.workout_id }))
    });
  });

  const plannerAccess = async (req, res) => {
    const c = await getClient(req, res); if (!c) return null;
    const s = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [c.org_id]);
    const mode = s?.workout_mode_default || 'hybrid';
    if (mode === 'prescribed') {
      res.status(403).json({ error: 'Workout creation is locked by your gym (prescribed mode)' });
      return null;
    }
    return c;
  };

  r.post('/planner/workouts', async (req, res) => {
    const c = await plannerAccess(req, res); if (!c) return;
    const { name, notes, exercises } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Workout name is required' });
    if (!Array.isArray(exercises) || exercises.length === 0) return res.status(400).json({ error: 'Add at least one exercise' });
    if (exercises.length > 20) return res.status(400).json({ error: 'Too many exercises (max 20)' });
    // validate every exercise against the library BEFORE writing anything (global or same-org only)
    const lib = await db.q(
      `SELECT id FROM exercise_library WHERE id IN (${exercises.map(() => '?').join(',')}) AND (is_global = 1 OR org_id = ?)`,
      [...exercises.map((e) => e.exercise_id), c.org_id]);
    const validIds = new Set(lib.map((r) => r.id));
    const valid = exercises.filter((e) => validIds.has(e.exercise_id));
    if (valid.length === 0) return res.status(400).json({ error: 'No valid exercises found in the library' });
    const wId = id('cw');
    await db.tx(async (tx) => {
      await tx.run(
        'INSERT INTO client_workouts (id, org_id, client_id, name, notes, created_at) VALUES (?,?,?,?,?,?)',
        [wId, c.org_id, c.id, String(name).trim().slice(0, 80), notes ? String(notes).slice(0, 300) : null, now()]);
      for (const [i, ex] of valid.entries()) {
        await tx.run(
          `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id('cwe'), wId, ex.exercise_id, i, String(ex.name || '').slice(0, 80),
           Math.max(1, Math.min(12, parseInt(ex.sets, 10) || 3)),
           String(ex.reps ?? 10).slice(0, 12), String(ex.weight ?? 'BW').slice(0, 12),
           Math.max(15, Math.min(600, parseInt(ex.rest_sec, 10) || 90)),
           ex.tempo ? String(ex.tempo).slice(0, 20) : null, ex.notes ? String(ex.notes).slice(0, 200) : null]);
      }
    });
    track(db, 'client_workout_created', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ id: wId });
  });

  r.put('/planner/workouts/:id', async (req, res) => {
    const c = await plannerAccess(req, res); if (!c) return;
    const s = await db.q1('SELECT * FROM gym_settings WHERE org_id = ?', [c.org_id]);
    if (s && (s.allow_edit_targets === 0 || s.allow_edit_targets === false)) {
      return res.status(403).json({ error: 'Editing workout details is locked by your gym' });
    }
    const w = await db.q1('SELECT * FROM client_workouts WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const { name, notes, exercises } = req.body || {};
    await db.tx(async (tx) => {
      if (name !== undefined || notes !== undefined) {
        await tx.run('UPDATE client_workouts SET name = COALESCE(?, name), notes = COALESCE(?, notes) WHERE id = ?',
          [name !== undefined ? String(name).slice(0, 80) : null, notes !== undefined ? String(notes).slice(0, 300) : null, w.id]);
      }
      if (Array.isArray(exercises)) {
        if (exercises.length === 0) throw new Error('A workout needs at least one exercise');
        const validIds = exercises.filter((e) => e.exercise_id).map((e) => e.exercise_id);
        if (validIds.length) {
          const lib = await tx.q(
            `SELECT id FROM exercise_library WHERE id IN (${validIds.map(() => '?').join(',')}) AND (is_global = 1 OR org_id = ?)`,
            [...validIds, c.org_id]);
          const allowed = new Set(lib.map((r) => r.id));
          if (validIds.some((vid) => !allowed.has(vid))) {
            throw new Error('One or more exercises are not available in your gym');
          }
        }
        await tx.run('DELETE FROM client_workout_exercises WHERE workout_id = ?', [w.id]);
        for (const [i, ex] of exercises.entries()) {
          await tx.run(
            `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [id('cwe'), w.id, ex.exercise_id || null, i, String(ex.name || '').slice(0, 80),
             Math.max(1, Math.min(12, parseInt(ex.sets, 10) || 3)),
             String(ex.reps ?? 10).slice(0, 12), String(ex.weight ?? 'BW').slice(0, 12),
             Math.max(15, Math.min(600, parseInt(ex.rest_sec, 10) || 90)),
             ex.tempo ? String(ex.tempo).slice(0, 20) : null, ex.notes ? String(ex.notes).slice(0, 200) : null]);
        }
      }
    });
    res.json({ ok: true });
  });

  r.post('/planner/workouts/:id/duplicate', async (req, res) => {
    const c = await plannerAccess(req, res); if (!c) return;
    const w = await db.q1('SELECT * FROM client_workouts WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!w) return res.status(404).json({ error: 'Workout not found' });
    const exs = await db.q('SELECT * FROM client_workout_exercises WHERE workout_id = ? ORDER BY position', [w.id]);
    const nId = id('cw');
    await db.tx(async (tx) => {
      await tx.run('INSERT INTO client_workouts (id, org_id, client_id, name, notes, created_at) VALUES (?,?,?,?,?,?)',
        [nId, c.org_id, c.id, `${w.name} (copy)`, w.notes, now()]);
      for (const ex of exs) {
        await tx.run(
          `INSERT INTO client_workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, tempo, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [id('cwe'), nId, ex.exercise_id, ex.position, ex.name, ex.sets, ex.reps, ex.weight, ex.rest_sec, ex.tempo, ex.notes]);
      }
    });
    res.json({ id: nId });
  });

  r.delete('/planner/workouts/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM client_workout_schedule WHERE workout_id = ?', [req.params.id]);
      await tx.run('DELETE FROM client_workout_exercises WHERE workout_id = ?', [req.params.id]);
      await tx.run('DELETE FROM client_workouts WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    });
    res.json({ ok: true });
  });

  // client's weekly schedule: { schedule: { 0: workoutId|null, 1: ..., 6: ... } }
  r.put('/planner/schedule', async (req, res) => {
    const c = await plannerAccess(req, res); if (!c) return;
    const { schedule } = req.body || {};
    if (!schedule || typeof schedule !== 'object') return res.status(400).json({ error: 'schedule object required' });
    const owned = new Set((await db.q('SELECT id FROM client_workouts WHERE client_id = ?', [c.id])).map((r) => r.id));
    await db.tx(async (tx) => {
      for (let dow = 0; dow <= 6; dow++) {
        const wid = schedule[dow] ?? null;
        await tx.run('DELETE FROM client_workout_schedule WHERE client_id = ? AND day_of_week = ?', [c.id, dow]);
        if (wid) {
          if (!owned.has(wid)) throw new Error('Invalid workout for this client');
          await tx.run('INSERT INTO client_workout_schedule (client_id, day_of_week, workout_id) VALUES (?,?,?)', [c.id, dow, wid]);
        }
      }
    });
    track(db, 'workout_schedule_saved', req.user.org, req.user.sub, { client_id: c.id });
    res.json({ ok: true });
  });

  // ---------------- meal items (meal → foods with quantities) ----------------
  r.get('/meals/:id/items', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const items = await db.q('SELECT * FROM meal_items WHERE meal_template_id = ? ORDER BY position', [m.id]);
    res.json({ meal: m, items });
  });

  // Add a food to a client meal (scoped: only global, own-gym, or own foods).
  r.post('/meals/:id/items', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const { food_id, name, quantity = 1 } = req.body || {};
    const qty = Math.max(0.01, Number(quantity) || 1);
    let food = null;
    if (food_id) {
      food = await db.q1(
        `SELECT * FROM foods WHERE id = ? AND (is_global = 1 OR org_id = ? OR client_id = ?)`, [food_id, c.org_id, c.id]);
      if (!food) return res.status(404).json({ error: 'Food not found or not available to you' });
    }
    const label = food ? food.name : (name ? String(name).slice(0, 80) : 'Item');
    const itemId = id('mi');
    const pos = (await db.q1('SELECT COALESCE(MAX(position)+1, 0) p FROM meal_items WHERE meal_template_id = ?', [m.id]))?.p || 0;
    await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO meal_items (id, meal_template_id, food_id, name, quantity, unit, calories, protein, carbs, fat, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [itemId, m.id, food?.id || null, label, qty, food?.serving || food?.unit || null,
         (food?.calories || 0) * qty, (food?.protein || 0) * qty, (food?.carbs || 0) * qty, (food?.fat || 0) * qty, pos]);
      // recompute the meal template totals from its items
      const totals = await tx.q1(
        'SELECT SUM(calories) c, SUM(protein) p, SUM(carbs) ca, SUM(fat) f FROM meal_items WHERE meal_template_id = ?', [m.id]);
      await tx.run('UPDATE client_meal_templates SET calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?',
        [totals?.c || 0, totals?.p || 0, totals?.ca || 0, totals?.f || 0, m.id]);
    });
    res.json({ id: itemId });
  });

  // Edit an item's quantity/serving — macros scale and the meal totals recompute.
  r.put('/meals/:id/items/:itemId', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const item = await db.q1('SELECT * FROM meal_items WHERE id = ? AND meal_template_id = ?', [req.params.itemId, m.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { quantity } = req.body || {};
    const qty = Math.max(0.01, Number(quantity) || item.quantity);
    let food = null;
    if (item.food_id) {
      food = await db.q1('SELECT * FROM foods WHERE id = ?', [item.food_id]);
    }
    const perServing = food
      ? { cal: food.calories || 0, pro: food.protein || 0, carb: food.carbs || 0, fat: food.fat || 0 }
      : { cal: item.quantity ? (item.calories / item.quantity) : 0, pro: item.quantity ? (item.protein / item.quantity) : 0,
          carb: item.quantity ? (item.carbs / item.quantity) : 0, fat: item.quantity ? (item.fat / item.quantity) : 0 };
    await db.tx(async (tx) => {
      await tx.run('UPDATE meal_items SET quantity = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?',
        [qty, perServing.cal * qty, perServing.pro * qty, perServing.carb * qty, perServing.fat * qty, item.id]);
      const totals = await tx.q1(
        'SELECT SUM(calories) c, SUM(protein) p, SUM(carbs) ca, SUM(fat) f FROM meal_items WHERE meal_template_id = ?', [m.id]);
      await tx.run('UPDATE client_meal_templates SET calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?',
        [totals?.c || 0, totals?.p || 0, totals?.ca || 0, totals?.f || 0, m.id]);
    });
    res.json({ ok: true });
  });

  r.delete('/meals/:id/items/:itemId', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    await db.tx(async (tx) => {
      await tx.run('DELETE FROM meal_items WHERE id = ? AND meal_template_id = ?', [req.params.itemId, m.id]);
      const totals = await tx.q1(
        'SELECT SUM(calories) c, SUM(protein) p, SUM(carbs) ca, SUM(fat) f FROM meal_items WHERE meal_template_id = ?', [m.id]);
      await tx.run('UPDATE client_meal_templates SET calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ?',
        [totals?.c || 0, totals?.p || 0, totals?.ca || 0, totals?.f || 0, m.id]);
    });
    res.json({ ok: true });
  });

  return r;
}
