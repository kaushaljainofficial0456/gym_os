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
import { foodSearch } from '../services/skos-food/index.js';
import {
  searchFoods as searchFoodModel,
  modelAvailable as foodModelAvailable,
  resolveFoodQuantity,
} from '../services/foodEstimator.js';
import { validateFoodRecord } from '../services/foodValidation.js';
import { validate, schemas } from '../validate.js';
import { rateLimit } from '../rateLimit.js';
import { estimateFoodAI, isFoodAIAvailable } from '../services/intelligence/foodAI.js';

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

  // ---------------- avatar (profile photo) ----------------
  // The frontend (Profile.jsx) has called POST/DELETE /me/avatar since it
  // was built, but no matching route ever existed here -- every upload or
  // removal 404'd. Scoped to req.user.sub directly (not getClient): this
  // updates `users.avatar`, which every role has, not a client-only field.
  //
  // Stored as a data URL in the column itself rather than through
  // storage.js's file-based driver: avatars need to be visible to OTHER
  // users too (a trainer's client list shows each client's avatar), and
  // storage.js's /uploads serving route only authorizes by client
  // ownership -- extending that for a second, differently-shaped viewer
  // rule is a bigger change than this fix calls for. A data URL keeps
  // this self-contained. The cap here (1 MB raw) is intentionally
  // tighter than progress photos' 5 MB: this value round-trips through
  // GET /auth/me on every page load, so keeping it small matters more
  // here than it does for a photo fetched on demand.
  const AVATAR_MIME = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };
  const AVATAR_MAX_BYTES = 1 * 1024 * 1024;
  r.post('/avatar', async (req, res) => {
    const { image } = req.body || {};
    const m = typeof image === 'string' && image.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) return res.status(400).json({ error: 'image must be a PNG, JPEG, or WebP data URL' });
    if (!AVATAR_MIME[m[1].toLowerCase()]) return res.status(400).json({ error: 'Only PNG, JPEG, or WebP images are supported' });
    const bytes = Buffer.byteLength(m[2], 'base64');
    if (bytes > AVATAR_MAX_BYTES) return res.status(413).json({ error: 'Image too large (max 1 MB)' });
    await db.run('UPDATE users SET avatar = ? WHERE id = ?', [image, req.user.sub]);
    res.json({ avatar: image });
  });

  r.delete('/avatar', async (req, res) => {
    await db.run('UPDATE users SET avatar = NULL WHERE id = ?', [req.user.sub]);
    res.json({ ok: true });
  });

  // ---------------- personal profile / goal --------------
  r.get('/profile', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const p = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [c.id]);
    res.json({ client: c, profile: p || {} });
  });

  r.put('/profile', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { goal, target_weight, goal_date, experience, equipment, water_target_l, sleep_target_h, height_cm, sex, age, current_weight, name, onboarding_completed } = req.body || {};
    const GOALS = ['FAT_LOSS', 'MUSCLE_GAIN', 'RECOMP', 'STRENGTH', 'GENERAL'];
    const EXP = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
    const SEX = ['MALE', 'FEMALE', 'OTHER'];
    if (goal !== undefined && !GOALS.includes(goal)) return res.status(400).json({ error: 'Invalid goal' });
    if (experience !== undefined && !EXP.includes(experience)) return res.status(400).json({ error: 'Invalid experience level' });
    if (sex !== undefined && sex !== null && !SEX.includes(sex)) return res.status(400).json({ error: 'Invalid sex' });
    if (age !== undefined && age !== null && (Number(age) < 10 || Number(age) > 120)) return res.status(400).json({ error: 'Invalid age' });
    if (current_weight !== undefined && current_weight !== null && (Number(current_weight) < 20 || Number(current_weight) > 400)) return res.status(400).json({ error: 'Invalid weight' });
    if (height_cm !== undefined && height_cm !== null && (Number(height_cm) < 100 || Number(height_cm) > 250)) return res.status(400).json({ error: 'Invalid height' });
    // Update user name if provided
    if (name !== undefined && name !== null && String(name).trim().length >= 2) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [String(name).trim().slice(0, 100), req.user.sub]);
    }
    const sets = [];
    const params = [];
    if (goal !== undefined) { sets.push('goal = ?'); params.push(goal); }
    if (target_weight !== undefined) { sets.push('target_weight = ?'); params.push(num(target_weight)); }
    if (goal_date !== undefined) { sets.push('goal_date = ?'); params.push(goal_date ? String(goal_date).slice(0, 10) : null); }
    if (height_cm !== undefined) { sets.push('height_cm = ?'); params.push(num(height_cm)); }
    if (sex !== undefined) { sets.push('sex = ?'); params.push(sex || null); }
    if (age !== undefined) { sets.push('age = ?'); params.push(num(age)); }
    if (current_weight !== undefined) { sets.push('current_weight = ?'); params.push(num(current_weight)); }
    if (onboarding_completed !== undefined) { sets.push('onboarding_completed = ?'); params.push(onboarding_completed ? 1 : 0); }
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

  // ---------------- nutrition target generation ----------------
  // Calculates daily calorie/macro targets from the client's profile.
  // Uses Mifflin-St Jeor BMR + activity multiplier based on experience.
  r.get('/nutrition/targets', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [c.id]);
    const user = await db.q1('SELECT name FROM users WHERE id = ?', [req.user.sub]);

    const weight = Number(c.current_weight) || 0;
    const height = Number(c.height_cm) || 0;
    const age = Number(c.age) || 0;
    const sex = (c.sex || '').toUpperCase();
    const goal = c.goal || 'GENERAL';

    // If profile is incomplete, return what we can
    if (!weight || !height || !age || !sex) {
      return res.json({
        targets: null,
        incomplete: true,
        missing: [
          !weight ? 'current_weight' : null,
          !height ? 'height_cm' : null,
          !age ? 'age' : null,
          !sex ? 'sex' : null,
        ].filter(Boolean),
        client: { name: user?.name || '', sex, height_cm: height, current_weight: weight, age, goal }
      });
    }

    // Mifflin-St Jeor BMR
    let bmr;
    if (sex === 'MALE') {
      bmr = 10 * weight + 6.25 * height - 5 * age + 5;
    } else {
      bmr = 10 * weight + 6.25 * height - 5 * age - 161;
    }

    // Activity multiplier from experience
    const activityMap = { BEGINNER: 1.375, INTERMEDIATE: 1.55, ADVANCED: 1.725 };
    const experience = (profile?.experience || 'INTERMEDIATE').toUpperCase();
    const activityMultiplier = activityMap[experience] || 1.55;

    let tdee = Math.round(bmr * activityMultiplier);

    // Goal adjustment
    const goalAdjust = {
      FAT_LOSS: -350,
      MUSCLE_GAIN: 300,
      RECOMP: 0,
      STRENGTH: 200,
      GENERAL: 0,
    };
    tdee += goalAdjust[goal] || 0;
    tdee = Math.max(1200, Math.min(tdee, 6000));

    // Macro split based on goal
    let proteinG, carbG, fatG;
    const leanMass = weight * 0.82; // rough lean mass estimate
    if (goal === 'MUSCLE_GAIN' || goal === 'STRENGTH') {
      proteinG = Math.round(leanMass * 2.0);      // 2g/kg lean mass
      fatG = Math.round(tdee * 0.25 / 9);          // 25% from fat
      carbG = Math.round((tdee - proteinG * 4 - fatG * 9) / 4);
    } else if (goal === 'FAT_LOSS') {
      proteinG = Math.round(leanMass * 2.2);        // higher protein for cut
      fatG = Math.round(tdee * 0.25 / 9);
      carbG = Math.round((tdee - proteinG * 4 - fatG * 9) / 4);
    } else {
      proteinG = Math.round(leanMass * 1.8);
      fatG = Math.round(tdee * 0.28 / 9);
      carbG = Math.round((tdee - proteinG * 4 - fatG * 9) / 4);
    }

    // Floor macros
    proteinG = Math.max(proteinG, 50);
    carbG = Math.max(carbG, 50);
    fatG = Math.max(fatG, 30);

    res.json({
      targets: { calories: tdee, protein: proteinG, carbs: carbG, fat: fatG },
      incomplete: false,
      meta: { bmr: Math.round(bmr), activityMultiplier, experience, goal },
      client: { name: user?.name || '', sex, height_cm: height, current_weight: weight, age, goal }
    });
  });

  // Confirm and save nutrition targets as a plan
  r.post('/nutrition/targets/confirm', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { calories, protein, carbs, fat } = req.body || {};
    if (!calories || !protein || !carbs || !fat) {
      return res.status(400).json({ error: 'All macro fields are required' });
    }
    const cal = Math.max(500, Math.min(Number(calories), 10000));
    const pro = Math.max(20, Math.min(Number(protein), 500));
    const carb = Math.max(20, Math.min(Number(carbs), 800));
    const fatV = Math.max(15, Math.min(Number(fat), 300));

    const id = 'np_' + Math.random().toString(36).slice(2, 10);
    await db.run(
      `INSERT INTO nutrition_plans (id, org_id, trainer_id, client_id, name, calories, protein, carbs, fat, is_template, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, c.org_id, req.user.sub, c.id, 'My Nutrition Plan', cal, pro, carb, fatV, now()]
    );
    track(db, 'nutrition_plan_created', req.user.org, req.user.sub, { client_id: c.id, source: 'client_self' });
    res.json({ ok: true, plan: { calories: cal, protein: pro, carbs: carb, fat: fatV } });
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

    /* Table rows (the client's own foods and the gym/global library) carry
       no portion list of their own -- portions come from the model's
       food-specific catalogue. Without this, any food the user had already
       logged once (and which was therefore materialised into `foods`)
       shadowed its catalogue twin and arrived with NO portion chips and no
       oil control, which is exactly what made the picker look like the
       feature had not shipped. Enrich them by name so a stored row behaves
       identically to a fresh catalogue hit. */
    const enrich = (row) => {
      const twin = foodModelAvailable() ? searchFoodModel(row.name, { limit: 1 })[0] : null;
      return {
        ...row,
        portions: twin?.portions || [],
        oil_applicable: !!twin && (twin.cooking_state === 'cooked' || twin.cuisine === 'INDIAN'),
        source_id: row.source_id || twin?.source_id || null,
        confidence: row.confidence || (twin ? twin.confidence : null),
      };
    };

    // Order: the client's own foods, then the measured catalogue, then any
    // library row the catalogue did not already cover by name.
    const norm = (n) => String(n).toLowerCase().trim();
    const claimed = new Set([...mine, ...model].map((f) => norm(f.name)));
    res.json({
      foods: [
        ...mine.map(enrich),
        ...model.filter((f) => !new Set(mine.map((m) => norm(m.name))).has(norm(f.name))),
        ...library.filter((f) => !claimed.has(norm(f.name))).map(enrich),
      ],
      model_available: foodModelAvailable(),
    });
  });

  /**
   * Tier 4 — AI food estimate. Reached ONLY when a user has already tried
   * /foods/search above and it came back with nothing usable ("Nothing
   * matched ..." in FoodLogSheet) -- this is explicitly NOT called
   * automatically on every search miss (spec: "Do NOT call AI for every
   * food query" -- cost, latency, rate limits, trust). The frontend gates
   * this behind an explicit "Estimate with AI" tap.
   *
   * Rate-limited tighter than ordinary search/log routes: this is the one
   * endpoint on the client surface that can call an external AI vendor
   * and cost real money/latency, not a local DB read.
   *
   * Returns the AI's estimate for review -- it does NOT log anything.
   * Logging (with the user's possibly-adjusted quantities) goes through
   * the EXISTING POST /nutrition/clients/:id/meals/log with
   * source: 'ai_estimated' (or 'ai_estimated_user_adjusted'), reusing
   * that endpoint rather than duplicating a second logging path.
   */
  const foodAILimit = rateLimit({ windowMs: 60_000, max: 12, keyFn: (req) => req.user?.sub || 'anon' });
  r.post('/foods/ai-estimate', foodAILimit, validate(schemas.foodAIEstimate), async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    if (!isFoodAIAvailable()) {
      return res.status(503).json({
        ok: false, tier: 4, estimate_status: 'unresolved',
        reason: 'AI food estimation is not configured on this server.',
        error: 'AI food estimation is not configured on this server.',
      });
    }
    const b = req.body;
    const result = await estimateFoodAI(db, {
      query: b.query, brand: b.brand, restaurant: b.restaurant, cuisine: b.cuisine,
      portion: b.portion, cookingMethod: b.cooking_method, ingredients: b.ingredients,
      orgId: c.org_id, userId: req.user.sub,
    });
    res.status(result.ok ? 200 : 502).json(result);
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
    // Reject invalid macro values outright (negative, impossible combos) --
    // never silently clamp or drop them, since the client would see a
    // "saved" food that quietly logs the wrong number every time it's used.
    const check = validateFoodRecord({ name, energy_kcal: calories, protein_g: protein, carb_g: carbs, fat_g: fat });
    if (!check.valid) return res.status(400).json({ error: 'Invalid food data', details: check.errors });
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

  // NOTE: a second, simpler `GET /foods/search` used to be registered here,
  // backed by skos-food/index.js's `foodSearch`. Express only ever dispatches
  // to the FIRST matching route (see /foods/search above, ~line 342), so this
  // one was dead code from the day both were merged in — never reachable.
  // Removed rather than left as a trap for the next person who edits it
  // expecting it to run. `foodSearch` is still imported and used below, in
  // POST /meals/:id/items, as a fallback lookup — left as-is.

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
      `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, meal_template_id)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,1,'custom',?)`,
      [lId, c.id, d, m.slot, m.name, m.calories, m.protein, m.carbs, m.fat, m.id]);
    track(db, 'meal_logged', req.user.org, req.user.sub, { client_id: c.id, source: 'client_custom' });
    res.json({ id: lId });
  });

  // Update a meal template (name, nutrition, foods)
  r.put('/meals/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const { name, slot, calories, protein, carbs, fat, foods } = req.body || {};
    const sets = [], params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(String(name).trim().slice(0, 80)); }
    if (slot !== undefined) { sets.push('slot = ?'); params.push(String(slot).slice(0, 30)); }
    if (calories !== undefined) { sets.push('calories = ?'); params.push(num(calories) || 0); }
    if (protein !== undefined) { sets.push('protein = ?'); params.push(num(protein) || 0); }
    if (carbs !== undefined) { sets.push('carbs = ?'); params.push(num(carbs) || 0); }
    if (fat !== undefined) { sets.push('fat = ?'); params.push(num(fat) || 0); }
    if (foods !== undefined) { sets.push('foods = ?'); params.push(String(foods).slice(0, 300)); }
    if (sets.length) { params.push(m.id); await db.run(`UPDATE client_meal_templates SET ${sets.join(', ')} WHERE id = ?`, params); }
    res.json({ ok: true });
  });

  // Delete a meal template and its items.
  // Also remove any meal_logs from TODAY that were logged from this template.
  // Historical logs from previous dates are preserved.
  r.delete('/meals/:id', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const m = await db.q1('SELECT * FROM client_meal_templates WHERE id = ? AND client_id = ?', [req.params.id, c.id]);
    if (!m) return res.status(404).json({ error: 'Meal not found' });
    const tz = req.tz || 'Asia/Kolkata';
    const today = dayKey(new Date(), tz);
    await db.run('DELETE FROM meal_items WHERE meal_template_id = ?', [m.id]);
    // Remove today's logged meals that came from this template
    await db.run(
      'DELETE FROM meal_logs WHERE client_id = ? AND meal_template_id = ? AND date = ?',
      [c.id, m.id, today]);
    await db.run('DELETE FROM client_meal_templates WHERE id = ?', [m.id]);
    res.json({ ok: true });
  });

  // ---------------- today's logged food entries ----------------
  // Delete a single logged entry (does NOT delete saved meal template or food)
  r.delete('/meal-logs/:logId', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { logId } = req.params;
    const log = await db.q1('SELECT * FROM meal_logs WHERE id = ? AND client_id = ?', [logId, c.id]);
    if (!log) return res.status(404).json({ error: 'Log entry not found' });
    await db.run('DELETE FROM meal_logs WHERE id = ? AND client_id = ?', [logId, c.id]);
    track(db, 'meal_log_deleted', req.user.org, req.user.sub, { clientId: c.id, logId });
    res.json({ ok: true });
  });

  // Edit a logged entry's quantity (recalculates nutrition from food data)
  r.put('/meal-logs/:logId', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { logId } = req.params;
    const { quantity, unit } = req.body || {};
    const log = await db.q1('SELECT * FROM meal_logs WHERE id = ? AND client_id = ?', [logId, c.id]);
    if (!log) return res.status(404).json({ error: 'Log entry not found' });
    if (quantity === undefined || quantity === null) return res.status(400).json({ error: 'quantity is required' });
    const newQty = Math.max(0.1, Number(quantity));
    const newUnit = unit !== undefined ? String(unit) : log.unit;

    // Try to recalculate from food database if the log has a reference food
    let newCalories = log.calories;
    let newProtein = log.protein;
    let newCarbs = log.carbs;
    let newFat = log.fat;

    // If the original quantity is known, scale proportionally
    const origQty = Number(log.quantity) || 100;
    const scale = newQty / origQty;
    newCalories = Math.round(log.calories * scale * 10) / 10;
    newProtein = Math.round(log.protein * scale * 10) / 10;
    newCarbs = Math.round(log.carbs * scale * 10) / 10;
    newFat = Math.round(log.fat * scale * 10) / 10;

    await db.run(
      'UPDATE meal_logs SET quantity = ?, unit = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE id = ? AND client_id = ?',
      [newQty, newUnit, newCalories, newProtein, newCarbs, newFat, logId, c.id]
    );
    track(db, 'meal_log_updated', req.user.org, req.user.sub, { clientId: c.id, logId });
    res.json({ ok: true, log: { id: logId, quantity: newQty, unit: newUnit, calories: newCalories, protein: newProtein, carbs: newCarbs, fat: newFat } });
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
  // If food_id doesn't exist in the foods table (e.g. a SKOS food), auto-create it.
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
    }
    // If not found in foods table, try SKOS food search (for custom meal builder)
    if (!food && (food_id || name)) {
      try {
        const searchResults = foodSearch.search(String(name || food_id), { limit: 1, allowBackoff: true });
        const skos = searchResults[0];
        if (skos) {
          const newId = id('food');
          await db.run(
            `INSERT INTO foods (id, org_id, client_id, name, serving, calories, protein, carbs, fat, is_global)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
            [newId, c.org_id, skos.food_name, (skos.serving_grams || 100) + ' g',
             skos.energy_kcal || 0, skos.protein_g || 0, skos.carb_g || 0, skos.fat_g || 0]);
          food = await db.q1('SELECT * FROM foods WHERE id = ?', [newId]);
        }
      } catch { /* SKOS lookup failed — fall through */ }
    }
    if (!food) return res.status(404).json({ error: 'Food not found or not available to you' });
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
