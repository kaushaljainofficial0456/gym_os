// ============================================================
// PROGRESS INTELLIGENCE — assembles everything the Progress screen
// reasons about, in ONE round trip, and derives the insights server-side
// so the trend maths has exactly one implementation (trendEngine.js).
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
// 1. CAPABILITIES ARE DERIVED, NEVER ASSUMED. A user without a wearable
//    must not be shown empty Sleep/HRV/Recovery cards -- so the response
//    reports, per metric, whether real data exists and where it came
//    from. The UI hides what isn't there instead of rendering a wall of
//    "--". Availability is per-METRIC, not a single hasWearable flag,
//    because Apple Health may give sleep with no recovery score while
//    WHOOP gives both.
//
// 2. NO FABRICATION. Every number here traces to a stored row. Where
//    there is no data the field is null and the reason is explicit;
//    nothing is defaulted to zero to make a card look populated.
//
// Reuses the EXISTING sources of truth rather than recomputing them:
// personal_records (services/personalRecords.js's engine),
// health_daily_summaries (the Health Intelligence Engine), meal_logs,
// workout_logs/exercise_set_logs, weight_logs, adherence_records.
// ============================================================
import { analyzeSeries, comparePeriods, streak, goalProgress, normalizeSeries } from './trendEngine.js';

const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// PostgreSQL returns SUM()/COUNT() over integers as BIGINT, and node-pg
// hands BIGINT back as a STRING to avoid silent precision loss. SQLite
// returns a JS number for the same query, so an un-coerced aggregate
// works perfectly in local dev and breaks only in production -- which is
// exactly how it shipped: `sets` arrived as "17", the UI's
// `total + row.sets` concatenated instead of adding, and a sets total
// rendered as 1,71,71,71,73,13,13,... Every aggregate below goes through
// this on the way out.
const int = (v) => {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** Local calendar day N days back, as YYYY-MM-DD. */
function daysAgoKey(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------

/**
 * What can this user's Progress screen actually show?
 *
 * Derived from real rows, per metric. `source` names WHERE the data came
 * from so the UI can label provenance (spec: never hide provenance when
 * it affects interpretation).
 */
async function detectCapabilities(db, { userId, clientId }) {
  const [weightRow, measureRow, photoRow, workoutRow, mealRow, prRow, healthRows, connections] = await Promise.all([
    db.q1('SELECT COUNT(*) AS n FROM weight_logs WHERE client_id = ?', [clientId]),
    db.q1('SELECT COUNT(*) AS n FROM measurements WHERE client_id = ?', [clientId]),
    db.q1('SELECT COUNT(*) AS n FROM progress_photos WHERE client_id = ?', [clientId]),
    db.q1('SELECT COUNT(*) AS n FROM workout_logs WHERE client_id = ?', [clientId]),
    db.q1('SELECT COUNT(*) AS n FROM meal_logs WHERE client_id = ?', [clientId]),
    db.q1('SELECT COUNT(*) AS n FROM personal_records WHERE client_id = ?', [clientId]),
    // One scan of the cached daily summaries tells us which physiological
    // metrics actually have values -- far cheaper than probing each.
    db.q(`SELECT sleep_duration_seconds, recovery_score, readiness_score, resting_energy, active_energy, steps, training_load
            FROM health_daily_summaries WHERE user_id = ? AND date >= ?`, [userId, daysAgoKey(120)]),
    db.q('SELECT provider, status FROM health_provider_connections WHERE user_id = ? AND status = ?', [userId, 'connected']),
  ]);

  const anyHealth = (field) => healthRows.some((r) => r[field] != null);
  const connectedProviders = connections.map((c) => c.provider);
  // Only claim a wearable source when one is genuinely connected AND the
  // metric has values; otherwise the value came from SK OS's own model.
  const wearableSource = connectedProviders.length ? connectedProviders.join(', ') : null;

  return {
    // Universally available SK OS data
    weight: { available: int(weightRow?.n) > 0, count: int(weightRow?.n), source: 'manual' },
    measurements: { available: int(measureRow?.n) > 0, count: int(measureRow?.n), source: 'manual' },
    progressPhotos: { available: int(photoRow?.n) > 0, count: int(photoRow?.n), source: 'manual' },
    workouts: { available: int(workoutRow?.n) > 0, count: int(workoutRow?.n), source: 'skos' },
    nutrition: { available: int(mealRow?.n) > 0, count: int(mealRow?.n), source: 'skos' },
    prs: { available: int(prRow?.n) > 0, count: int(prRow?.n), source: 'skos' },
    // Health-data dependent -- each gated on real values existing
    sleep: { available: anyHealth('sleep_duration_seconds'), source: wearableSource },
    recovery: { available: anyHealth('recovery_score'), source: wearableSource },
    readiness: { available: anyHealth('readiness_score'), source: wearableSource },
    steps: { available: anyHealth('steps'), source: wearableSource },
    energy: { available: anyHealth('active_energy') || anyHealth('resting_energy'), source: wearableSource || 'skos' },
    trainingLoad: { available: anyHealth('training_load'), source: 'skos' },
    connectedProviders,
  };
}

// ---------------------------------------------------------------
// Personal records
// ---------------------------------------------------------------

/**
 * PRs from the EXISTING engine's table -- this file never recomputes what
 * constitutes a PR (services/personalRecords.js owns that).
 *
 * personal_records is UNIQUE(client_id, exercise_id, type), i.e. it holds
 * CURRENT bests only and is overwritten as they improve. The historical
 * timeline therefore comes from workout_logs.is_pr, which marks the
 * session where each record was actually set -- the two are different
 * questions ("what is my best?" vs "when did I set it?") and need
 * different sources.
 */
async function loadPersonalRecords(db, clientId) {
  const [current, timeline] = await Promise.all([
    db.q(`SELECT pr.*, el.name AS exercise_name, el.primary_muscle
            FROM personal_records pr
            LEFT JOIN exercise_library el ON el.id = pr.exercise_id
           WHERE pr.client_id = ?
           ORDER BY pr.date DESC`, [clientId]),
    db.q(`SELECT wl.date, wl.weight, wl.reps, wl.exercise_id, el.name AS exercise_name, el.primary_muscle
            FROM workout_logs wl
            LEFT JOIN exercise_library el ON el.id = wl.exercise_id
           WHERE wl.client_id = ? AND wl.is_pr = 1
           ORDER BY wl.date DESC, wl.created_at DESC
           LIMIT 60`, [clientId]),
  ]);

  const byExercise = new Map();
  for (const pr of current) {
    const key = pr.exercise_id;
    if (!key) continue;
    const entry = byExercise.get(key) || { exerciseId: key, exercise: pr.exercise_name || 'Exercise', muscle: pr.primary_muscle || null, records: {} };
    entry.records[pr.type] = { value: pr.value, weight: pr.weight, reps: pr.reps, date: pr.date };
    byExercise.set(key, entry);
  }

  return {
    byExercise: [...byExercise.values()],
    timeline: timeline.map((t) => ({
      date: t.date, exerciseId: t.exercise_id, exercise: t.exercise_name || 'Exercise',
      muscle: t.primary_muscle || null, weight: t.weight, reps: t.reps,
    })),
    recentCount: timeline.filter((t) => t.date >= daysAgoKey(30)).length,
    total: current.length,
  };
}

/** Every logged set for ONE exercise, for the PR explorer's progression
 *  chart -- the journey toward the record, not just the record. */
export async function exerciseHistory(db, { clientId, exerciseId }) {
  const rows = await db.q(
    `SELECT date, weight, reps, sets_done, is_pr FROM workout_logs
      WHERE client_id = ? AND exercise_id = ? AND weight IS NOT NULL
      ORDER BY date`, [clientId, exerciseId]);
  return rows.map((r) => ({
    date: r.date,
    weight: r.weight,
    reps: r.reps,
    sets: r.sets_done,
    // Epley, the same formula personalRecords.js uses -- not a second
    // competing definition of estimated 1RM.
    est1rm: r.weight != null && r.reps ? round(r.weight * (1 + r.reps / 30), 1) : null,
    volume: r.weight != null && r.reps && r.sets_done ? r.weight * r.reps * r.sets_done : null,
    isPr: !!r.is_pr,
  }));
}

// ---------------------------------------------------------------
// Training / nutrition aggregates
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// What counts as a TRAINING DAY
// ---------------------------------------------------------------
//
// A streak is only worth anything if it cannot be padded. Real data from
// this app already contains 38-second and 32-second "workouts" with a
// single logged set -- a mis-tap, an accidental start, or a session
// abandoned immediately. Counting those as training days makes the streak
// a measure of how often someone opened the app, not how often they
// trained.
//
// A day qualifies when EITHER floor is cleared:
//   - real work was logged (>= MIN_SETS completed sets), or
//   - a session of plausible length was actually spent training.
// Either one alone is enough: a heavy triple-set day is short but real,
// and a long mobility session may log few sets.
//
// Multiple sessions in one day collapse into ONE day (the GROUP BY below),
// and their sets/duration are summed -- two half sessions make one real
// training day, not two.
const MIN_SETS_FOR_TRAINING_DAY = 3;
const MIN_SECONDS_FOR_TRAINING_DAY = 8 * 60;
// Same ceiling the health engine uses: a session left running across a
// day boundary is a data artefact, not a 16-hour workout, so its duration
// is ignored rather than being allowed to qualify a day on its own.
const MAX_PLAUSIBLE_SESSION_SECONDS = 6 * 3600;

async function loadTraining(db, clientId, since) {
  const [sessions, muscle, durations] = await Promise.all([
    db.q(`SELECT wl.date,
                 SUM(COALESCE(wl.weight,0) * COALESCE(wl.reps,0) * COALESCE(wl.sets_done,0)) AS volume,
                 SUM(COALESCE(wl.sets_done,0)) AS sets,
                 SUM(COALESCE(wl.reps,0) * COALESCE(wl.sets_done,0)) AS reps,
                 COUNT(DISTINCT wl.exercise_id) AS exercises
            FROM workout_logs wl
           WHERE wl.client_id = ? AND wl.date >= ?
           GROUP BY wl.date ORDER BY wl.date`, [clientId, since]),
    db.q(`SELECT el.primary_muscle AS muscle,
                 SUM(COALESCE(wl.sets_done,0)) AS sets,
                 SUM(COALESCE(wl.weight,0) * COALESCE(wl.reps,0) * COALESCE(wl.sets_done,0)) AS volume
            FROM workout_logs wl JOIN exercise_library el ON el.id = wl.exercise_id
           WHERE wl.client_id = ? AND wl.date >= ? AND el.primary_muscle IS NOT NULL
           GROUP BY el.primary_muscle ORDER BY volume DESC`, [clientId, since]),
    // Session durations, so a day with few logged sets can still qualify
    // on time actually spent training.
    db.q(`SELECT scheduled_date AS date, started_at, completed_at FROM workouts
           WHERE client_id = ? AND scheduled_date >= ? AND started_at IS NOT NULL AND completed_at IS NOT NULL`,
      [clientId, since]),
  ]);

  const secondsByDate = new Map();
  for (const w of durations) {
    const sec = (Date.parse(w.completed_at) - Date.parse(w.started_at)) / 1000;
    if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_PLAUSIBLE_SESSION_SECONDS) continue;
    secondsByDate.set(w.date, (secondsByDate.get(w.date) || 0) + sec);
  }
  const mapped = sessions.map((s) => {
    const seconds = secondsByDate.get(s.date) || 0;
    const qualifies = int(s.sets) >= MIN_SETS_FOR_TRAINING_DAY || seconds >= MIN_SECONDS_FOR_TRAINING_DAY;
    return {
      date: s.date, volume: round(s.volume, 0), sets: int(s.sets), reps: int(s.reps), exercises: int(s.exercises),
      seconds: seconds || null, qualifies,
    };
  });

  return {
    // `sessions` stays the FULL record -- nothing is deleted, and the
    // charts still show every day work was logged. `qualifies` is the flag
    // the streak and the training-day count respect.
    sessions: mapped,
    qualifyingDays: mapped.filter((m) => m.qualifies).map((m) => m.date),
    skippedDays: mapped.filter((m) => !m.qualifies).length,
    byMuscle: muscle.map((m) => ({ muscle: m.muscle, sets: int(m.sets), volume: round(m.volume, 0) })),
  };
}

async function loadNutrition(db, clientId, since) {
  const [days, plan] = await Promise.all([
    db.q(`SELECT date,
                 SUM(calories) AS calories, SUM(protein) AS protein,
                 SUM(carbs) AS carbs, SUM(fat) AS fat, COUNT(*) AS entries
            FROM meal_logs WHERE client_id = ? AND date >= ? AND eaten = 1
           GROUP BY date ORDER BY date`, [clientId, since]),
    db.q1('SELECT calories, protein, carbs, fat FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [clientId]),
  ]);
  return {
    days: days.map((d) => ({
      date: d.date, calories: round(d.calories, 0), protein: round(d.protein, 0),
      carbs: round(d.carbs, 0), fat: round(d.fat, 0), entries: int(d.entries),
    })),
    targets: plan ? { calories: plan.calories, protein: plan.protein, carbs: plan.carbs, fat: plan.fat } : null,
  };
}

// ---------------------------------------------------------------
// Insight engine
// ---------------------------------------------------------------

/**
 * Ranked, data-backed observations. Every insight must name the numbers
 * it came from -- an insight the user cannot verify against their own
 * charts is just a slogan.
 *
 * Nothing here claims causation. Relationships are phrased as what the
 * data shows ("X rose while Y fell"), never as one causing the other.
 */
function buildInsights({ weightAnalysis, weightGoal, training, nutrition, prs, adherenceStreak, capabilities, nutritionCompare }) {
  const out = [];
  const push = (i) => out.push(i);

  // --- Body ---
  if (weightAnalysis && !weightAnalysis.insufficient) {
    const { change, ratePerWeek, spanDays, current } = weightAnalysis;
    if (ratePerWeek != null && Math.abs(ratePerWeek) >= 0.05) {
      push({
        type: ratePerWeek < 0 ? 'positive' : 'observation',
        priority: 90,
        title: `Trending ${ratePerWeek < 0 ? 'down' : 'up'} ${Math.abs(round(ratePerWeek, 2))} kg/week`,
        description: `Your weight moved ${change >= 0 ? '+' : ''}${round(change, 1)} kg over the last ${Math.round(spanDays)} days, now ${round(current, 1)} kg.`,
        metric: 'weight',
        confidence: weightAnalysis.count >= 8 ? 'high' : 'medium',
      });
    } else if (ratePerWeek != null && Math.abs(ratePerWeek) < 0.05 && spanDays >= 14) {
      push({
        type: 'warning',
        priority: 80,
        title: 'Your weight has plateaued',
        description: `Essentially flat across ${Math.round(spanDays)} days (${round(weightAnalysis.min, 1)}–${round(weightAnalysis.max, 1)} kg). If the goal is movement, calories or training volume are the levers.`,
        metric: 'weight',
        confidence: 'medium',
      });
    }
  }

  // --- Strength vs bodyweight: the relationship worth surfacing ---
  if (prs?.timeline?.length && weightAnalysis && !weightAnalysis.insufficient && weightAnalysis.change < -0.5) {
    const recent = prs.recentCount;
    if (recent > 0) {
      push({
        type: 'positive',
        priority: 95,
        title: 'Getting stronger while getting lighter',
        description: `${recent} personal record${recent === 1 ? '' : 's'} in the last 30 days while body weight fell ${Math.abs(round(weightAnalysis.change, 1))} kg.`,
        metric: 'prs',
        confidence: 'high',
      });
    }
  }

  // --- PRs ---
  if (prs?.recentCount > 0) {
    const latest = prs.timeline[0];
    push({
      type: 'milestone',
      priority: 88,
      title: `${prs.recentCount} new PR${prs.recentCount === 1 ? '' : 's'} in 30 days`,
      description: latest
        ? `Most recent: ${latest.exercise}${latest.weight ? ` at ${round(latest.weight, 1)} kg` : ''}${latest.reps ? ` × ${latest.reps}` : ''}.`
        : 'Keep the sessions coming.',
      metric: 'prs',
      confidence: 'high',
    });
  }

  // --- Training consistency ---
  if ((training?.qualifyingDays?.length || 0) >= 3) {
    const days = training.qualifyingDays.length;
    const totalVolume = training.sessions.reduce((s, x) => s + (x.volume || 0), 0);
    push({
      type: 'observation',
      priority: 70,
      title: `${days} training day${days === 1 ? '' : 's'} logged`,
      description: `${Math.round(totalVolume).toLocaleString()} kg of total volume across those sessions.`,
      metric: 'training',
      confidence: 'high',
    });
  }

  // --- Nutrition ---
  if (nutritionCompare && Math.abs(nutritionCompare.changePercent ?? 0) >= 5) {
    const up = nutritionCompare.change > 0;
    push({
      type: up ? 'positive' : 'observation',
      priority: 75,
      title: `Average protein ${up ? 'up' : 'down'} ${Math.abs(round(nutritionCompare.changePercent, 1))}%`,
      description: `${round(nutritionCompare.current, 0)} g/day now versus ${round(nutritionCompare.previous, 0)} g/day in the period before.`,
      metric: 'nutrition',
      confidence: 'medium',
    });
  }

  // --- Consistency ---
  if (adherenceStreak?.current >= 3) {
    push({
      type: 'positive',
      priority: 65,
      title: `${adherenceStreak.current}-day logging streak`,
      description: adherenceStreak.best > adherenceStreak.current
        ? `Your best run so far is ${adherenceStreak.best} days.`
        : 'This is your best run so far.',
      metric: 'consistency',
      confidence: 'high',
    });
  }

  // --- Goal ---
  if (weightGoal?.weeksToTarget != null) {
    push({
      type: 'observation',
      priority: 85,
      title: `About ${Math.round(weightGoal.weeksToTarget)} weeks from your target`,
      description: `${Math.abs(round(weightGoal.remaining, 1))} kg to go at your current trend. An estimate, not a promise — it moves as the trend moves.`,
      metric: 'goal',
      confidence: 'low',
    });
  }

  return out.sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------

/**
 * Everything the Progress screen needs, in one call.
 * `days` bounds the aggregate windows; the weight series is returned in
 * full so the client can switch periods without another round trip.
 */
export async function getProgressIntel(db, { userId, clientId, days = 90 }) {
  const since = daysAgoKey(days);

  const [capabilities, weights, adherence, prs, training, nutrition, healthDays, client, measurementRows] = await Promise.all([
    detectCapabilities(db, { userId, clientId }),
    db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date', [clientId]),
    db.q('SELECT date, score FROM adherence_records WHERE client_id = ? AND date >= ? ORDER BY date', [clientId, daysAgoKey(120)]),
    loadPersonalRecords(db, clientId),
    loadTraining(db, clientId, since),
    loadNutrition(db, clientId, since),
    db.q(`SELECT date, active_energy, resting_energy, total_energy, steps, sleep_duration_seconds,
                 recovery_score, readiness_score, training_load, data_quality
            FROM health_daily_summaries WHERE user_id = ? AND date >= ? ORDER BY date`, [userId, since]),
    db.q1('SELECT current_weight, target_weight, goal, height_cm, age, sex FROM clients WHERE id = ?', [clientId]),
    db.q('SELECT taken_at, waist, chest, arms, thighs, hips, neck FROM measurements WHERE client_id = ? ORDER BY taken_at', [clientId]),
  ]);

  const weightAnalysis = analyzeSeries(weights, { valueKey: 'weight', days });
  const weightAll = normalizeSeries(weights, { valueKey: 'weight' });

  const weightGoal = client?.target_weight && weightAnalysis.current != null
    ? goalProgress({
      start: weightAll.length ? weightAll[0].value : null,
      current: weightAnalysis.current,
      target: client.target_weight,
      ratePerWeek: weightAnalysis.ratePerWeek,
    })
    : null;

  const nutritionCompare = comparePeriods(nutrition.days, { days: Math.min(days, 30), valueKey: 'protein' });
  // CONSISTENCY. The streak counts a day where the user actually did
  // something -- trained (to the qualifying bar above) or logged food.
  // It used to key off adherence_records alone, which meant the heatmap
  // could show a wall of training days while the streak beside it read
  // zero: two different questions presented as one.
  const qualifyingTrainingDays = new Set(training.qualifyingDays || []);
  const nutritionDays = new Set((nutrition.days || []).map((d) => d.date));
  const activeDays = new Set([...qualifyingTrainingDays, ...nutritionDays]);
  const adherenceStreak = streak([...activeDays]);
  const consistency = {
    trainedDays: [...qualifyingTrainingDays],
    nutritionDays: [...nutritionDays],
    // Days that were BOTH -- the strongest days, and previously invisible:
    // the heatmap painted them the same colour as train-only days.
    bothDays: [...qualifyingTrainingDays].filter((d) => nutritionDays.has(d)),
    activeDays: [...activeDays],
    streak: adherenceStreak,
    // Short/mis-tapped sessions that did NOT qualify. Surfaced rather than
    // silently dropped, so the number is explainable.
    skippedShortSessions: training.skippedDays || 0,
  };

  const insights = buildInsights({
    weightAnalysis, weightGoal, training, nutrition, prs, adherenceStreak, capabilities, nutritionCompare,
  });

  // Only measurement types the user has ACTUALLY recorded become series.
  // A 'Chest' chart with no chest readings is the empty-card problem in
  // another costume.
  const MEASUREMENT_FIELDS = ['waist', 'chest', 'arms', 'thighs', 'hips', 'neck'];
  const measurements = {};
  for (const field of MEASUREMENT_FIELDS) {
    const series = measurementRows
      .filter((r) => r[field] != null)
      .map((r) => ({ date: String(r.taken_at).slice(0, 10), value: r[field] }));
    if (series.length) measurements[field] = normalizeSeries(series);
  }

  // THIS WEEK vs LAST WEEK -- the personal report, computed from the same
  // qualifying-day rule the streak uses so the two can never disagree.
  const weekAgo = daysAgoKey(7);
  const twoWeeksAgo = daysAgoKey(14);
  const inWeek = (d) => d >= weekAgo;
  const inPrevWeek = (d) => d >= twoWeeksAgo && d < weekAgo;
  const weekNutrition = (nutrition.days || []).filter((d) => inWeek(d.date));
  const prevWeekNutrition = (nutrition.days || []).filter((d) => inPrevWeek(d.date));
  const weekSessions = (training.sessions || []).filter((sn) => inWeek(sn.date) && sn.qualifies);
  const prevWeekSessions = (training.sessions || []).filter((sn) => inPrevWeek(sn.date) && sn.qualifies);
  const meanBy = (arr, k) => (arr.length ? arr.reduce((a, b) => a + (b[k] || 0), 0) / arr.length : null);
  const week = {
    workouts: weekSessions.length,
    previousWorkouts: prevWeekSessions.length,
    volume: round(weekSessions.reduce((a, b) => a + (b.volume || 0), 0), 0),
    previousVolume: round(prevWeekSessions.reduce((a, b) => a + (b.volume || 0), 0), 0),
    nutritionDays: weekNutrition.length,
    avgProtein: round(meanBy(weekNutrition, 'protein'), 0),
    previousAvgProtein: round(meanBy(prevWeekNutrition, 'protein'), 0),
    avgCalories: round(meanBy(weekNutrition, 'calories'), 0),
    prs: (prs.timeline || []).filter((t) => inWeek(t.date)).length,
    // Only true when there IS a previous week to have beaten.
    hasPrevious: prevWeekSessions.length > 0 || prevWeekNutrition.length > 0,
  };

  return {
    capabilities,
    period: { days, since },
    measurements,
    week,
    weight: { series: weightAll, analysis: weightAnalysis, goal: weightGoal, target: client?.target_weight ?? null },
    adherence: { series: adherence, streak: adherenceStreak },
    consistency,
    training,
    nutrition,
    prs,
    health: { days: healthDays },
    profile: { goal: client?.goal ?? null },
    insights,
  };
}
