// ============================================================
// SK INTELLIGENCE ENGINE — /api/intel
// Natural-language fitness input → structured, validated data.
//   * deterministic parsing + calculation first (cheap, explainable)
//   * no LLM writes to the DB — every commit goes through this
//     route after confirmation with provenance + confidence
//   * every action is recorded in intelligence_events
// ============================================================
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, orgScope } from '../auth.js';
import { rateLimit } from '../rateLimit.js';
import { id, now } from '../ids.js';
import { dayKey } from '../utils/time.js';
import { track } from '../services/events.js';
import { parseFoodInput } from '../services/intelligence/parseFoods.js';
import { parseWorkoutInput } from '../services/intelligence/parseWorkout.js';
import { parseQuantity, foodBase } from '../services/intelligence/units.js';
import { resolveFood, searchFoods } from '../services/intelligence/foodSearch.js';
import { searchExercises, searchExercisesByName } from '../services/intelligence/exerciseSearch.js';
import { computeNutrition, sumNutrition } from '../services/intelligence/nutrition.js';
import { generateProgram } from '../services/intelligence/generateProgram.js';
import { estimateWorkoutCalories, buildWorkoutCalorieInput, resolveBodyWeight, persistCalorieResult } from '../services/intelligence/calorieModel.js';
import { evaluatePRs } from '../services/personalRecords.js';
import { todayNutrition, lastPerformance, weightTrend, todayTraining, clientProfileContext } from '../services/intelligence/context.js';
import { coach as aiCoach, visionLabel, estimateMeal, providerName, isConfigured, ping as aiPing, configSummary } from '../services/intelligence/aiProvider.js';
import { buildClientAIContext } from '../services/intelligence/aiContext.js';
import { buildBrief, buildWeekly, pickPriority, computeInsights, suggestFoods } from '../services/intelligence/coachEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'data', 'uploads');

function logEvent(db, orgId, clientId, domain, input, resolution, result, source) {
  return db.run(
    `INSERT INTO intelligence_events (id, org_id, client_id, domain, input, resolution, result, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('int'), orgId, clientId, domain,
     String(input || '').slice(0, 300), JSON.stringify(resolution || {}), JSON.stringify(result || {}),
     source || 'parser', now()]).catch(() => { /* logging never breaks the request */ });
}

export default function intelligenceRoutes(db) {
  const r = Router();
  r.use(requireAuth, orgScope);
  // Rate limiting (per authenticated client). Generous ceiling for the whole
  // engine; stricter for expensive/AI/vision routes so one client can't
  // saturate the AI service or disk with uploads.
  r.use(rateLimit({ windowMs: 60_000, max: 240, keyFn: (req) => req.user?.sub || 'anon' }));
  const aiLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user?.sub || 'anon' });
  const uploadLimit = rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user?.sub || 'anon' });
  r.use(['/ask', '/coach', '/generate-workout', '/parse-food', '/parse-workout', '/confirm-food', '/confirm-workout'], aiLimit);
  r.use(['/label-scan', '/meal-photo', '/foods/label'], uploadLimit);

  const getClient = async (req, res) => {
    const c = await db.q1('SELECT * FROM clients WHERE user_id = ?', [req.user.sub]);
    if (!c) { res.status(404).json({ error: 'No client profile linked to this account' }); return null; }
    return c;
  };

  // ---------------- parse food input ----------------
  r.post('/parse-food', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

    const parsed = parseFoodInput(text);
    if (parsed.unparseable || !parsed.items.length) {
      await logEvent(db, c.org_id, c.id, 'nutrition', text, { ok: false }, { error: 'Could not parse food input' }, 'parser');
      return res.status(422).json({ error: 'Could not understand that. Try "220g paneer" or "2 rotis + 150g rice".' });
    }

    const out = [];
    const unresolved = [];
    for (const item of parsed.items) {
      if (!item.name) { unresolved.push({ raw: item.raw, reason: 'no food name found' }); continue; }
      const { match, candidates, ambiguous } = await resolveFood(db, c.org_id, c.id, item.name);
      if (match) {
        const nutrition = computeNutrition(match, item);
        if (nutrition) {
          out.push({ ...nutrition, raw: item.raw });
          continue;
        }
      }
      unresolved.push({ raw: item.raw, name: item.name, candidates: candidates.map((f) => f.name), ambiguous });
    }

    const totals = sumNutrition(out.map((o) => ({ macros: o.macros })));
    const needsConfirmation = unresolved.length > 0 || out.some((o) => o.confidence === 'MEDIUM' || o.provenance === 'ESTIMATED');
    await logEvent(db, c.org_id, c.id, 'nutrition', text,
      { items: out.map((o) => ({ food: o.name, qty: o.quantity, unit: o.unit, confidence: o.confidence })), unresolved },
      { totals, count: out.length }, 'parser');
    res.json({ ok: true, items: out, totals, unresolved, needsConfirmation });
  });

  // ---------------- confirm & commit food to today's log ----------------
  r.post('/confirm-food', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { entries } = req.body || {};   // [{food_id, quantity, unit}]
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries required' });
    const tz = req.tz || 'Asia/Kolkata';
    const d = dayKey(new Date(), tz);
    const committed = [];
    for (const e of entries) {
      const food = await db.q1(
        'SELECT * FROM foods WHERE id = ? AND (is_global = 1 OR org_id = ? OR client_id = ?)',
        [e.food_id, c.org_id, c.id]);
      if (!food) { continue; }  // never commit a food the client can't see
      // Server-side unit re-parse: the client sends { food_id, quantity, unit }
      // (e.g. { qty: 2, unit: 'roti' } or { qty: 250, unit: 'ml' }) and the
      // server derives the unitType from the unit engine. Totals from the
      // browser are NEVER trusted — nutrition is recomputed below.
      const rawQ = `${String(e.quantity ?? '').trim()} ${String(e.unit ?? '').trim()}`.trim();
      const item = parseQuantity(rawQ) || {
        qty: Number(e.quantity) || 1,
        unit: String(e.unit || 'g').slice(0, 12),
        unitType: 'serving',
        provenance: 'USER_ENTERED',
        note: 'unit unrecognized — counted as serving'
      };
      // bare number with no unit → default to the food's own base unit
      if (!item.unit) {
        const base = foodBase(food);
        item.unit = base.unitType === 'ml' ? 'ml' : 'g';
        item.unitType = base.unitType === 'ml' ? 'ml' : 'gram';
      }
      const nutrition = computeNutrition(food, item);
      const lId = id('mlg');
      const quantity = String(e.quantity ?? '');
      await db.run(
        `INSERT INTO meal_logs (id, client_id, meal_id, date, slot, name, calories, protein, carbs, fat, eaten, source, quantity, unit, unit_type)
         VALUES (?, ?, NULL, ?, 'intel', ?, ?, ?, ?, ?, 1, 'intel', ?, ?, ?)`,
        [lId, c.id, d, (food.brand ? food.brand + ' · ' : '') + food.name + (quantity ? ` (${quantity})` : ''),
         nutrition.macros.calories, nutrition.macros.protein, nutrition.macros.carbs, nutrition.macros.fat,
         item.qty ?? null, item.unit ?? null, item.unitType ?? null]);
      committed.push({ id: lId, food_id: food.id, name: food.name, macros: nutrition.macros });
    }
    if (!committed.length) return res.status(404).json({ error: 'None of those foods are available to you' });
    await logEvent(db, c.org_id, c.id, 'nutrition', JSON.stringify(entries),
      { committed: committed.map((x) => x.food_id) }, { count: committed.length }, 'confirm');
    await track(db, { orgId: c.org_id, userId: req.user.sub, type: 'intel_food_logged', data: { clientId: c.id, count: committed.length } });
    res.json({ ok: true, committed, date: d });
  });

  // ---------------- parse workout input ----------------
  r.post('/parse-workout', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
    const parsed = parseWorkoutInput(text);
    if (!parsed.ok) {
      await logEvent(db, c.org_id, c.id, 'workout', text, { ok: false }, { error: parsed.error }, 'parser');
      return res.status(422).json({ error: parsed.error });
    }
    // resolve exercise against the library
    const intent = await searchExercises(db, c.org_id, parsed.exercise);
    const byName = intent.length ? intent : await searchExercisesByName(db, c.org_id, parsed.exercise);
    const resolved = byName[0] || null;
    const needsConfirmation = !resolved || byName.length > 1;
    await logEvent(db, c.org_id, c.id, 'workout', text,
      { exercise: parsed.exercise, resolved: resolved?.name || null, sets: parsed.totalSets },
      { ok: true }, 'parser');
    res.json({ ok: true, ...parsed, resolved, candidates: byName.slice(0, 6), needsConfirmation });
  });

  // ---------------- confirm & commit workout (creates today's session + set logs) ----------------
  r.post('/confirm-workout', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { exercise_id, exercise_name, sets } = req.body || {};
    if (!exercise_id && !exercise_name) return res.status(400).json({ error: 'exercise_id or exercise_name required' });
    if (!Array.isArray(sets) || !sets.length) return res.status(400).json({ error: 'sets required' });
    const ex = exercise_id
      ? await db.q1('SELECT * FROM exercise_library WHERE id = ? AND (is_global = 1 OR org_id = ?)', [exercise_id, c.org_id])
      : null;
    const name = ex?.name || String(exercise_name || '').slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Could not resolve that exercise' });

    const tz = req.tz || 'Asia/Kolkata';
    const d = dayKey(new Date(), tz);
    const wId = id('wko');
    const cleanSets = sets.slice(0, 12).map((s) => ({
      weight: Math.max(0, Number(s.weight) || 0),
      reps: Math.max(0, Math.min(200, Number(s.reps) || 0))
    })).filter((s) => s.reps > 0);

    const t0 = now(); // NL-logged sessions have no measured duration — timestamps are set equal
    const txResult = await db.tx(async (tx) => {
      await tx.run(
        `INSERT INTO workouts (id, org_id, client_id, name, day_label, scheduled_date, status, source, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', 'ai', ?, ?, ?)`,
        [wId, c.org_id, c.id, name, name.slice(0, 40), d, t0, t0, t0]);
      const wxeId = id('wxe');
      await tx.run(
        `INSERT INTO workout_exercises (id, workout_id, exercise_id, position, name, sets, reps, weight, rest_sec, done)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, 90, 1)`,
        [wxeId, wId, ex?.id || null, name, cleanSets.length,
         cleanSets[0].reps, cleanSets[0].weight]);
      const prs = ex ? await evaluatePRs(tx, c.id, ex.id, cleanSets, d) : [];
      const logId = id('wlg');
      const wgtBest = Math.max(...cleanSets.map((s) => s.weight));
      const repsBest = Math.max(...cleanSets.map((s) => s.reps));
      await tx.run(
        `INSERT INTO workout_logs (id, client_id, workout_id, exercise_id, date, sets_done, reps, weight, is_pr)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logId, c.id, wId, ex?.id || null, d, cleanSets.length, repsBest, wgtBest, prs.length ? 1 : 0]);
      for (let i = 0; i < cleanSets.length; i++) {
        const s = cleanSets[i];
        await tx.run(
          `INSERT INTO exercise_set_logs (id, workout_log_id, client_id, exercise_id, set_number, prescribed_reps, actual_reps, prescribed_weight, actual_weight, rest_seconds, completed, is_synthesized)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0)`,
          [id('stl'), logId, c.id, ex?.id || null, i + 1, s.reps, s.reps, s.weight, s.weight]);
      }
      // Calorie estimate from ACTUAL sets (user-confirmed NL input), never planned.
      let calorie = null;
      try {
        const bodyWeightKg = await resolveBodyWeight(tx, c.id, d);
        const input = buildWorkoutCalorieInput({
          client: c,
          workout: { id: wId },
          exercises: ex ? [{
            id: wxeId, exercise_id: ex.id, name, ex_type: ex.ex_type, movement: ex.movement,
            equipment: ex.equipment, primary_muscle: ex.primary_muscle,
            library: { ex_type: ex.ex_type, movement: ex.movement, equipment: ex.equipment, primary_muscle: ex.primary_muscle }
          }] : [],
          setsByExercise: ex ? { [wxeId]: cleanSets.map((s, i) => ({ set_number: i + 1, actual_reps: s.reps, actual_weight: s.weight, completed: 1 })) } : {},
          durationSeconds: null,
          bodyWeightKg
        });
        calorie = estimateWorkoutCalories(input);
        if (calorie) await persistCalorieResult(tx, wId, calorie);
      } catch (e) {
        // Calorie estimation/persistence must NEVER fail workout logging.
        // Log server-side only with safe correlation metadata (request id,
        // workout id, error message) — never bodies, user data, or ML output.
        calorie = null;
        console.error('[sk-os] calorie estimate failed', { req: req.id || null, workout: wId, error: String(e?.message || e).slice(0, 500) });
      }
      return { prs, calorie };
    });
    await logEvent(db, c.org_id, c.id, 'workout', exercise_name || exercise_id,
      { exercise: name, sets: cleanSets.length }, { workoutId: wId }, 'confirm');
    await track(db, { orgId: c.org_id, userId: req.user.sub, type: 'intel_workout_logged', data: { clientId: c.id, workoutId: wId, estimatedKcal: txResult?.calorie?.estimated_active_kcal ?? null } });
    res.json({ ok: true, workoutId: wId, name, setsLogged: cleanSets.length, date: d, calorie: txResult?.calorie ?? null });
  });

  // ---------------- food search / autocomplete ----------------
  r.get('/foods', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const foods = await searchFoods(db, c.org_id, c.id, req.query.q || '', { limit: parseInt(req.query.limit, 10) || 8 });
    res.json({ foods });
  });

  // ---------------- exercise search (intent-aware) ----------------
  r.get('/exercises', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { q = '', muscle, equipment, movement, difficulty } = req.query;
    const filters = { muscle, equipment, movement, difficulty };
    const intent = q && String(q).trim().length >= 2
      ? await searchExercises(db, c.org_id, String(q).trim(), filters)
      : await searchExercises(db, c.org_id, String(q || '').trim(), filters);
    const results = intent.length ? intent : (String(q || '').trim().length >= 2 ? await searchExercisesByName(db, c.org_id, String(q).trim()) : []);
    res.json({ exercises: results });
  });

  // ---------------- generate a program from constraints ----------------
  r.post('/generate-workout', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { goal, days, equipment, exclude, minutes, experience, style } = req.body || {};
    const program = await generateProgram(db, c.org_id, { goal, days, equipment, exclude, minutes, experience, style });
    await logEvent(db, c.org_id, c.id, 'program', JSON.stringify({ goal, days, equipment, exclude }),
      { splitStyle: program.splitStyle, days: program.days }, { week: program.week.map((d) => d.name) }, 'generator');
    res.json(program);
  });

  // ---------------- label scan (photo upload → editable extraction) ----------------
  r.post('/label-scan', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { image } = req.body || {};   // data URL: data:image/png;base64,...
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image required (data URL)' });
    const m = image.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Unsupported image format — use PNG, JPEG, WebP or GIF' });
    const [, mime, ext] = m;
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 5 MB)' });
    // basic dimension sanity: PNG/JPEG header gives width/height
    const dims = readImageDims(buf, ext);
    if (dims && (dims.w < 32 || dims.h < 32)) return res.status(400).json({ error: 'Image too small to read' });
    // store privately (never served statically) — tmp namespace, cleaned on save
    const dir = path.join(UPLOAD_DIR, 'tmp', c.id);
    fs.mkdirSync(dir, { recursive: true });
    const fileId = id('img').replace(/^img_/, '');
    const rel = `tmp/${c.id}/${fileId}.${ext === 'jpg' ? 'jpg' : ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, rel), buf);

    // vision extraction when an AI provider is configured; otherwise editable manual entry
    let ocrFields = null;
    let ocrNote = null;
    if (isConfigured()) {
      try {
        const vis = await visionLabel(image);
        if (vis.ok && vis.name !== undefined) {
          ocrFields = {
            brand: vis.brand || '', name: vis.name || '',
            serving_size: vis.serving_size != null ? String(vis.serving_size) : '',
            unit: vis.unit || 'g',
            calories: vis.calories != null ? String(vis.calories) : '',
            protein: vis.protein != null ? String(vis.protein) : '',
            carbs: vis.carbs != null ? String(vis.carbs) : '',
            fat: vis.fat != null ? String(vis.fat) : '',
            fiber: vis.fiber != null ? String(vis.fiber) : '',
            sugar: vis.sugar != null ? String(vis.sugar) : '',
            sodium: vis.sodium != null ? String(vis.sodium) : ''
          };
          ocrNote = `OCR extracted (${vis.confidence || 'MEDIUM'} confidence). Review every value before saving — OCR is not always correct.`;
        } else {
          ocrNote = vis.note || vis.error || 'OCR returned nothing usable — enter values manually.';
        }
      } catch (e) {
        ocrNote = `OCR failed (${e.message}) — enter values manually.`;
      }
    }
    const note = ocrNote || 'No OCR provider configured — enter the values from the label below (provenance: LABEL SCANNED, user-confirmed).';
    await logEvent(db, c.org_id, c.id, 'label', `image/${ext} ${dims ? dims.w + 'x' + dims.h : '?'}`,
      { stored: rel, ocr: !!ocrFields }, { note }, ocrFields ? 'ocr' : 'manual');
    res.json({
      ok: true,
      imagePath: `/uploads/${rel}`,
      note,
      provenance: 'LABEL_SCANNED',
      ocr: { attempted: isConfigured(), extracted: !!ocrFields, provider: providerName(), confidence: ocrFields ? 'REVIEW REQUIRED' : null },
      fields: ocrFields || {
        brand: '', name: '', serving_size: '', unit: 'g',
        calories: '', protein: '', carbs: '', fat: '', fiber: '', sugar: '', sodium: ''
      }
    });
  });

  // ---------------- meal-photo estimation (ESTIMATED only, never exact) ----------------
  r.post('/meal-photo', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'image required (data URL)' });
    const m = image.match(/^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'Unsupported image format — use PNG, JPEG or WebP' });
    const [, , ext] = m;
    const buf = Buffer.from(m[3], 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 5 MB)' });
    const est = await estimateMeal(image);
    await logEvent(db, c.org_id, c.id, 'meal_photo', `image/${ext} ${buf.length}B`,
      { estimated: est.estimated, confidence: est.confidence || 'LOW' }, est, 'vision');
    res.json({
      ok: true,
      estimated: true,
      ...est,
      note: est.note || 'Calorie values from a photo are ESTIMATED ranges, never exact.'
    });
  });

  // ---------------- ASK SK OS — context-aware questions ----------------
  r.post('/ask', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const tz = req.tz || 'Asia/Kolkata';
    const low = text.toLowerCase();

    // --- intent routing (deterministic; no LLM needed for the common cases) ---
    let topic = 'general';
    if (/protein/.test(low)) topic = 'protein';
    else if (/calori/.test(low)) topic = 'calories';
    else if (/train|workout|should i|today/.test(low)) topic = 'train_today';
    else if (/bench|squat|deadlift|last week|last time|p(r|b)|pr\.|record/.test(low)) topic = 'last_performance';
    else if (/plateau|weight.*(change|stuck|not.*mov)|why.*(gain|loss)/.test(low)) topic = 'weight';
    else if (/meal|food|eat|breakfast|lunch|dinner/.test(low)) topic = 'food';

    const profileCtx = await clientProfileContext(db, c);
    let answer = null;

    if (topic === 'protein' || topic === 'calories') {
      const n = await todayNutrition(db, c, tz);
      const remainingP = n.plan && n.plan.protein > 0 ? Math.max(0, Math.round((n.plan.protein - n.totals.protein) * 10) / 10) : null;
      const remainingK = n.plan && n.plan.calories > 0 ? Math.max(0, Math.round(n.plan.calories - n.totals.calories)) : null;
      answer = {
        topic, provenance: 'MEASURED',
        summary: topic === 'protein'
          ? `You've logged ${n.totals.protein}g protein today across ${n.meals} entries.`
          : `You've logged ${n.totals.calories} kcal today across ${n.meals} entries.`,
        detail: {
          logged: n.totals, meals: n.meals, target: n.plan || null,
          remainingProtein: remainingP, remainingCalories: remainingK
        },
        followup: remainingP != null
          ? `About ${remainingP}g protein left if you hit your ${n.plan.protein}g target.`
          : 'Set a nutrition target (trainer or gym plan) to see remaining goals.'
      };
    } else if (topic === 'train_today') {
      const t = await todayTraining(db, c, tz);
      if (t.schedule) {
        answer = {
          topic, provenance: 'MEASURED',
          summary: `${t.dayName}: ${t.schedule.workout_name} is on your schedule.`,
          detail: t
        };
      } else if (t.programDay) {
        answer = {
          topic, provenance: 'MEASURED',
          summary: `${t.dayName}: ${t.programDay.name} (${t.programDay.program_name}) is your program session today.`,
          detail: t
        };
      } else {
        answer = {
          topic, provenance: 'MEASURED',
          summary: `${t.dayName} is a rest day on your schedule — you've logged ${t.loggedWorkouts} workouts in the last 7 days (${t.weekVolumeSets} sets).`,
          detail: t,
          followup: 'If you want to train anyway, say "Give me a workout" and I can suggest one.'
        };
      }
    } else if (topic === 'last_performance') {
      const exMatch = text.match(/(bench|squat|deadlift|press|curl|row|pulldown|overhead|dumbbell|barbell|machine)[a-z]*/i);
      const exName = exMatch ? exMatch[1] : null;
      const rows = exName ? await lastPerformance(db, c.id, exName, tz) : [];
      if (rows.length) {
        answer = {
          topic, provenance: 'MEASURED',
          summary: `Your most recent ${rows[0].name || exName} session (${rows[0].date}): ${rows[0].weight}kg × ${rows[0].reps} — ${rows[0].sets_done} sets.`,
          detail: { exercise: exName, history: rows },
          followup: rows.length > 1 ? `Previous: ${rows[1].weight}kg × ${rows[1].reps} (${rows[1].date}).` : null
        };
      } else {
        answer = {
          topic, provenance: 'MEASURED',
          summary: exName
            ? `I don't have a log for ${exName} yet. Log your next session and I'll track the trend.`
            : "I don't have enough information — tell me which exercise, e.g. 'What did I bench last week?'",
          detail: { history: [] }
        };
      }
    } else if (topic === 'weight') {
      const w = await weightTrend(db, c);
      if (w && w.series.length >= 2) {
        const rec = w.plateau
          ? 'Your weight has been stable for a couple of weeks — that is a plateau signal, not necessarily a problem. Check nutrition adherence before changing training.'
          : `Your weight has been ${w.direction} (${w.trend > 0 ? '+' : ''}${w.trend} kg over ~2 weeks).`;
        answer = {
          topic, provenance: 'CALCULATED',
          summary: rec,
          detail: { ...w, note: 'Weight trends are noisy day-to-day; look at the 2-week direction.' },
          followup: w.target ? `Goal: ${w.target}kg (current ${w.last}kg).` : null
        };
      } else {
        answer = {
          topic, provenance: 'MEASURED',
          summary: "You haven't logged enough weigh-ins yet for a trend — log your weight a few times a week and I can track it.",
          detail: { series: [] }
        };
      }
    } else {
      // general / food — if an AI provider is configured, frame conversationally
      const ai = await aiCoach(text, profileCtx);
      answer = ai
        ? { topic: 'general', provenance: 'AI_RECOMMENDED', summary: ai, detail: null }
        : { topic: 'general', provenance: 'MEASURED', summary: "Tell me what you'd like to know — e.g. 'How much protein have I eaten today?', 'What did I bench last week?', or 'Should I train today?'", detail: null };
    }

    await logEvent(db, c.org_id, c.id, 'ask', text, { topic }, { summary: answer.summary }, 'context');
    res.json({ ok: true, ...answer });
  });

  // ---------------- save a scanned/entered packaged food ----------------
  r.post('/foods/label', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { brand, name, serving_size, unit, calories, protein, carbs, fat, fiber, sugar, sodium } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Product name required' });
    const num = (v) => (v === '' || v === null || v === undefined ? null : (Number(v) || 0));
    const fId = id('food');
    await db.run(
      `INSERT INTO foods (id, org_id, client_id, name, brand, unit, serving, calories, protein, carbs, fat, fiber, sugar, sodium, category, source, is_global)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'packaged', 'PACKAGING_LABEL', 0)`,
      [fId, c.org_id, c.id, String(name).trim().slice(0, 80), brand ? String(brand).slice(0, 60) : null,
       unit ? String(unit).slice(0, 20) : 'g', serving_size ? `1 ${String(serving_size).slice(0, 20)} ${unit || 'g'}` : null,
       num(calories), num(protein), num(carbs), num(fat), num(fiber), num(sugar), num(sodium)]);
    // cleanup temp image if provided
    if (req.body.imagePath) {
      const safe = String(req.body.imagePath).replace(/^\/uploads\//, '');
      const abs = path.join(UPLOAD_DIR, safe);
      try { if (fs.existsSync(abs) && abs.startsWith(UPLOAD_DIR)) fs.unlinkSync(abs); } catch {}
    }
    await logEvent(db, c.org_id, c.id, 'label', JSON.stringify(req.body),
      { savedFood: fId }, { source: 'PACKAGING_LABEL' }, 'confirm');
    res.json({ id: fId });
  });

  // ================= LOCAL AI COACH (Ollama / optional providers) =================

  // Provider status — lets the UI show "AI Coach unavailable" instead of breaking.
  r.get('/coach/status', async (_req, res) => {
    const p = await aiPing();
    res.json({ ok: true, ...configSummary(), available: p.available, ollama: p });
  });

  // Daily Coach Brief — 3-5 data-driven insights + today's priority.
  r.get('/coach/brief', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const tz = req.tz || 'Asia/Kolkata';
    const ctx = await buildClientAIContext(db, c, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery', 'gym'] }, tz);
    const p = await aiPing();
    let brief = buildBrief(ctx, { withAI: p.available, ai: { providerName } });
    // LLM framing only when Ollama is actually up — never blocks the brief
    if (p.available) {
      try {
        const framed = await aiCoach('Give me today\'s coach brief — 3-5 concise insights and today\'s single priority.', ctx);
        if (framed) brief = { ...brief, ai_framed: true, ai_note: 'Ollama-framed summary — numbers still come from your logged data.', llm_summary: framed };
      } catch { /* keep deterministic brief */ }
    }
    await logEvent(db, c.org_id, c.id, 'coach_brief', 'daily brief',
      { provider: brief.provider, insights: brief.insights.length }, { priority: brief.priority?.title || null }, 'coach');
    res.json(brief);
  });

  // Weekly Coach Review — what went well / needs attention / next priority.
  r.get('/coach/weekly', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const tz = req.tz || 'Asia/Kolkata';
    const ctx = await buildClientAIContext(db, c, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery'] }, tz);
    const review = buildWeekly(ctx);
    await logEvent(db, c.org_id, c.id, 'coach_weekly', 'weekly review',
      { went: review.went_well.length, attention: review.needs_attention.length }, { priority: review.next_week_priority?.title || null }, 'coach');
    res.json(review);
  });

  // Conversational coaching — context-aware answer to a client question.
  // Deterministic data first; Ollama frames the reply when available.
  r.post('/coach/chat', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const tz = req.tz || 'Asia/Kolkata';
    // safety gate: medical/emergency topics are answered by a referral, never by the model
    const low = text.toLowerCase();
    if (/diagnos|prescrib|medication|medicine|drug|emergency|suicid|chest pain|dizzy|faint|severe pain/i.test(low)) {
      return res.json({
        ok: true, provider: 'safety',
        answer: 'That sounds like something a qualified professional should look at. SK OS provides fitness training guidance only — please consult a doctor or appropriate healthcare professional for this.',
        actionable: { action: 'NONE' },
        provenance: 'SAFETY_GATE'
      });
    }
    const ctx = await buildClientAIContext(db, c, { domains: ['profile', 'nutrition', 'training', 'progress', 'recovery', 'gym', 'memory'] }, tz);
    const insights = computeInsights(ctx);
    const p = await aiPing();

    // food-request pattern: "what should I eat" / "I need 40g protein"
    if (/(what (should|can) i eat|need .*protein|protein.*(left|short|need)|suggest (food|meal)|what to eat)/i.test(low)) {
      const needProtein = (low.match(/(\d+)\s*g\s*(of\s*)?protein/) || [])[1] ? Number((low.match(/(\d+)\s*g\s*(of\s*)?protein/) || [])[1]) : null;
      const target = ctx.nutrition?.daily_target?.protein ?? null;
      const todayP = ctx.nutrition?.today?.protein ?? null;
      const gap = needProtein ?? (target && todayP != null ? Math.max(0, Math.round(target - todayP)) : null);
      const suggestions = await suggestFoods(db, c.org_id, c.id, { needProtein: gap || 0 });
      const remaining = target && todayP != null ? Math.round(target - todayP) : null;
      const answer = gap != null && gap > 0
        ? `You need about ${gap}g more protein today${remaining != null ? ` (${todayP}g of ${target}g logged)` : ''}. Options from your food database:`
        : (suggestions.length ? 'Here are protein-rich options from your food database:' : "I don't have enough data to suggest foods yet — log some foods first.");
      await logEvent(db, c.org_id, c.id, 'coach_food', text, { gap }, { suggestions: suggestions.length }, 'coach');
      return res.json({
        ok: true, provider: p.available ? 'ollama' : 'deterministic',
        answer,
        foods: suggestions,
        actionable: { action: 'OPEN_MEALS' },
        provenance: 'CALCULATED'
      });
    }

    // fallback: deterministic answer + optional LLM framing
    let answer = null;
    let actionable = { action: 'NONE' };
    const pri = pickPriority(insights);
    if (/(how am i|how.*doing|status|today)/i.test(low) && pri) {
      answer = `Today's biggest focus: ${pri.title}. ${pri.message}`;
      actionable = { action: pri.action };
    } else if (/(what should i (train|do)|should i train|train today)/i.test(low) && ctx.training?.today_workout) {
      answer = ctx.training.today_done
        ? `${ctx.training.today_workout} is done today. Rest or focus on recovery.`
        : `Today is your ${ctx.training.today_workout} session (${ctx.training.week_workouts} workout${ctx.training.week_workouts === 1 ? '' : 's'} logged this week).`;
      actionable = { action: 'START_WORKOUT' };
    } else if (insights.length) {
      answer = insights.slice(0, 2).map((i) => `${i.title}: ${i.message}`).join(' ');
      actionable = { action: pri?.action || 'NONE' };
    } else {
      answer = "I don't have enough information yet — log a few workouts and meals and I'll be able to coach you properly.";
    }

    let llm = null;
    if (p.available) {
      try { llm = await aiCoach(text, ctx); } catch { llm = null; }
    }
    await logEvent(db, c.org_id, c.id, 'coach_chat', text, { provider: p.available ? 'ollama' : 'deterministic' }, { answer: String(answer).slice(0, 300) }, 'coach');
    res.json({
      ok: true,
      provider: p.available ? 'ollama' : 'deterministic',
      answer,
      llm_summary: llm,
      actionable,
      provenance: 'CALCULATED'
    });
  });

  // Recommendation feedback — "helpful" / "not helpful" / "don't recommend"
  r.post('/coach/feedback', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const { feedback, target_type, target_id, note } = req.body || {};
    if (!['helpful', 'not_helpful', 'dont_recommend', 'not_relevant', 'already_done'].includes(feedback)) {
      return res.status(400).json({ error: 'invalid feedback value' });
    }
    await db.run(
      `INSERT INTO ai_feedback (id, org_id, client_id, feedback, target_type, target_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('aif'), c.org_id, c.id, feedback, target_type ? String(target_type).slice(0, 40) : null,
       target_id ? String(target_id).slice(0, 80) : null, note ? String(note).slice(0, 300) : null, now()]);
    res.json({ ok: true });
  });

  // AI memory — structured long-term preferences (never raw chat).
  r.get('/coach/memory', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const rows = await db.q('SELECT key, value, source, updated_at FROM ai_memory WHERE org_id = ? AND client_id = ? ORDER BY key', [c.org_id, c.id]);
    res.json({ memory: rows.map((r) => ({ key: r.key, value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })(), source: r.source })) });
  });

  r.put('/coach/memory', async (req, res) => {
    const c = await getClient(req, res); if (!c) return;
    const entries = (req.body || {}).entries;
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries required' });
    const allowed = ['equipment_pref', 'disliked_exercises', 'liked_foods', 'workout_duration', 'training_time', 'note'];
    for (const e of entries) {
      if (!allowed.includes(e.key)) return res.status(400).json({ error: `key must be one of: ${allowed.join(', ')}` });
      const val = typeof e.value === 'string' ? e.value.trim() : e.value;
      if (val === '' || val === null || val === undefined) {
        await db.run('DELETE FROM ai_memory WHERE org_id = ? AND client_id = ? AND key = ?', [c.org_id, c.id, e.key]);
        continue;
      }
      await db.run(
        `INSERT INTO ai_memory (id, org_id, client_id, key, value, source, updated_at)
         VALUES (?, ?, ?, ?, ?, 'manual', ?)
         ON CONFLICT (org_id, client_id, key) DO UPDATE SET value = excluded.value, source = 'manual', updated_at = excluded.updated_at`,
        [id('aim'), c.org_id, c.id, e.key, typeof val === 'string' ? val : JSON.stringify(val), now()]);
    }
    res.json({ ok: true });
  });

  return r;
}

// Minimal PNG/JPEG dimension reader — just enough validation.
function readImageDims(buf, ext) {
  try {
    if (ext === 'png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length - 9) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { w: buf.readUInt16BE(o + 7), h: buf.readUInt16BE(o + 5) };
        }
        o += 2 + buf.readUInt16BE(o + 2);
      }
    }
  } catch {}
  return null;
}
