// ============================================================
// COACH ENGINE — /intelligence/coachEngine.js
// The deterministic "brain" of SK Coach. It computes data-driven
// insights and recommendations from REAL database rows, then
// (optionally) asks the LLM to frame them conversationally.
// The AI NEVER calculates nutrition or progression numbers — those
// come from the nutrition engine / progressive overload service.
// Every recommendation carries a structured type, priority,
// confidence, data_sources and an actionable `action` that the
// frontend can wire to a real SK OS surface.
// ============================================================
import { computeNutrition } from './nutrition.js';
import { resolveFood } from './foodSearch.js';
import { parseQuantity } from './units.js';

const ACTIONS = ['OPEN_NUTRITION', 'START_WORKOUT', 'LOG_WATER', 'LOG_SLEEP', 'VIEW_PROGRESS', 'VIEW_EXERCISE', 'VIEW_GOAL', 'OPEN_MEALS', 'VIEW_BRIEF', 'NONE'];

function insight(type, title, message, reason, { priority = 'MEDIUM', confidence = 'HIGH', data_sources = [], action = 'NONE', detail = null } = {}) {
  if (!ACTIONS.includes(action)) action = 'NONE';
  return { type, title, message, reason, priority, confidence, data_sources, action, detail };
}

// ------------------------------------------------------------------
// Deterministic insights from the client's own data.
// ------------------------------------------------------------------
export function computeInsights(ctx) {
  const out = [];
  const p = ctx.profile || {};
  const n = ctx.nutrition || {};
  const tr = ctx.training || {};
  const pr = ctx.progress || {};
  const rec = ctx.recovery || {};
  const gy = ctx.gym || {};
  const today = n.today || {};

  // --- NUTRITION: protein gap ---
  if (n.daily_target?.protein && today.protein != null) {
    const gap = Math.round((n.daily_target.protein - today.protein) * 10) / 10;
    if (gap >= 10) {
      out.push(insight('NUTRITION', 'Protein is behind target',
        `You're ${gap}g below today's protein target.`,
        `${today.protein}g logged against a ${n.daily_target.protein}g target.`,
        { priority: gap > n.daily_target.protein * 0.3 ? 'HIGH' : 'MEDIUM', action: 'OPEN_NUTRITION', data_sources: ['meal_logs', 'nutrition_plans'] }));
    } else if (gap <= -5) {
      out.push(insight('NUTRITION', 'Protein target reached',
        `You've hit ${today.protein}g of your ${n.daily_target.protein}g protein target.`,
        'No further protein needed today based on logged intake.',
        { priority: 'LOW', confidence: 'HIGH', action: 'NONE', data_sources: ['meal_logs'] }));
    }
  }

  // --- NUTRITION: calorie headroom ---
  if (n.daily_target?.calories && today.calories != null) {
    const remaining = Math.round(n.daily_target.calories - today.calories);
    if (remaining >= 150) {
      out.push(insight('NUTRITION', 'Calorie headroom available',
        `About ${remaining} kcal remaining today (${today.calories} of ${n.daily_target.calories} logged).`,
        'Derived from today\'s logged intake vs the daily plan target.',
        { priority: 'MEDIUM', action: 'OPEN_MEALS', data_sources: ['meal_logs', 'nutrition_plans'] }));
    } else if (remaining < 0) {
      out.push(insight('NUTRITION', 'Calorie target exceeded',
        `You've logged ${Math.abs(remaining)} kcal over today's ${n.daily_target.calories} kcal target.`,
        'Total logged intake is above the plan target.',
        { priority: 'HIGH', confidence: 'MEDIUM', action: 'OPEN_NUTRITION', data_sources: ['meal_logs'] }));
    }
  }

  // --- NUTRITION: week average ---
  if (n.week_avg?.protein && n.daily_target?.protein && n.week_avg.days_logged >= 3) {
    const pct = Math.round((n.week_avg.protein / n.daily_target.protein) * 100);
    if (pct < 80) {
      out.push(insight('NUTRITION', 'Protein has been running low',
        `Your 7-day average protein is ${n.week_avg.protein}g — about ${100 - pct}% below target on days you logged.`,
        `Averaged over ${n.week_avg.days_logged} logged days.`,
        { priority: 'HIGH', confidence: 'MEDIUM', action: 'OPEN_NUTRITION', data_sources: ['meal_logs'] }));
    }
  }

  // --- TRAINING: today's session ---
  if (tr.today_workout) {
    out.push(insight('WORKOUT', tr.today_done ? 'Today\'s session completed' : 'Today\'s session is ready',
      tr.today_done
        ? `You completed ${tr.today_workout} today. Nice work.`
        : `${tr.today_workout} is scheduled for today (${tr.day}).`,
      tr.today_done ? 'Logged workout found for today.' : 'From your planner schedule / active program.',
      { priority: tr.today_done ? 'LOW' : 'HIGH', action: tr.today_done ? 'NONE' : 'START_WORKOUT', data_sources: ['client_workout_schedule', 'training_days'] }));
  }

  // --- TRAINING: weekly volume ---
  if (tr.week_workouts != null && tr.week_workouts >= 1 && tr.week_workouts < 2) {
    out.push(insight('ADHERENCE', 'Only one workout logged this week',
      `You've logged ${tr.week_workouts} workout${tr.week_workouts > 1 ? 's' : ''} in the last 7 days.`,
      'Counted from workout_logs in the last 7 days.',
      { priority: 'MEDIUM', confidence: 'MEDIUM', action: 'START_WORKOUT', data_sources: ['workout_logs'] }));
  }

  // --- RECOVERY: sleep ---
  if (rec.sleep_7d_avg_h != null && p.sleep_target_h) {
    const gap = Math.round((p.sleep_target_h - rec.sleep_7d_avg_h) * 10) / 10;
    if (gap >= 0.75) {
      out.push(insight('SLEEP', 'Sleep is below target',
        `Your 7-day sleep average is ${rec.sleep_7d_avg_h}h — about ${gap}h below your ${p.sleep_target_h}h target.`,
        'Averaged over logged sleep entries in the last 7 days.',
        { priority: 'MEDIUM', confidence: 'MEDIUM', action: 'LOG_SLEEP', data_sources: ['sleep_logs'] }));
    }
  }

  // --- RECOVERY: water ---
  if (rec.water_today_l != null && p.water_target_l) {
    const gap = Math.round((p.water_target_l - rec.water_today_l) * 10) / 10;
    if (gap >= 0.5) {
      out.push(insight('HYDRATION', 'Water intake behind today',
        `You've logged ${rec.water_today_l}L of your ${p.water_target_l}L water target — ${gap}L short.`,
        'Today\'s water logs vs the client water target.',
        { priority: 'MEDIUM', confidence: 'HIGH', action: 'LOG_WATER', data_sources: ['water_logs'] }));
    }
  }

  // --- PROGRESS: weight trend ---
  const w = pr.weight || {};
  if (w.trend_14d != null) {
    if (w.direction === 'losing' && w.trend_14d < -0.6) {
      out.push(insight('PROGRESS', 'Weight trend is moving down',
        `Your 14-day weight trend is about ${Math.abs(w.trend_14d)}kg down.`,
        'Calculated from weight_logs (14-day span).',
        { priority: 'LOW', confidence: 'MEDIUM', action: 'VIEW_PROGRESS', data_sources: ['weight_logs'] }));
    } else if (w.direction === 'stable' && w.count >= 4) {
      out.push(insight('PROGRESS', 'Weight has plateaued recently',
        `Your weight has been stable (within ~0.4kg) over the last two weeks.`,
        'Based on weight_logs trend; day-to-day readings fluctuate.',
        { priority: 'MEDIUM', confidence: 'MEDIUM', action: 'VIEW_PROGRESS', data_sources: ['weight_logs'] }));
    }
  }

  // --- GOAL progress ---
  if (p.goal && p.start_weight != null && p.current_weight != null && p.target_weight != null && p.start_weight !== p.target_weight) {
    const total = Math.abs(p.start_weight - p.target_weight);
    const done = Math.abs(p.start_weight - p.current_weight);
    const pct = Math.round((done / total) * 100);
    out.push(insight('GOAL', `Goal progress: ${pct}%`,
      `You've covered ${Math.round(done * 10) / 10}kg of your ${total}kg ${p.goal} target (${pct}%).`,
      'Start weight vs current weight vs target.',
      { priority: 'LOW', confidence: 'MEDIUM', action: 'VIEW_GOAL', data_sources: ['clients'] }));
  }

  // --- GYM crowd ---
  if (gy.crowd?.status) {
    out.push(insight('GYM', `Gym is ${gy.crowd.status.toLowerCase()}`,
      `Current occupancy is ${gy.crowd.current}/${gy.crowd.capacity}.`,
      'From the gym attendance/occupancy engine.',
      { priority: 'LOW', confidence: 'HIGH', action: 'NONE', data_sources: ['attendance_events'] }));
  }

  // --- insufficient data guard ---
  const dataPoints = (n.today?.meals || 0) + (tr.week_workouts || 0) + (w.count || 0) + (rec.sleep_7d_avg_h != null ? 7 : 0);
  if (dataPoints === 0) {
    out.push(insight('ADHERENCE', 'Not enough data yet',
      'I don\'t have enough logged data to make a confident recommendation yet. Log a few workouts and meals and I\'ll be able to coach you properly.',
      'No meal, workout, weight or sleep logs found.',
      { priority: 'LOW', confidence: 'LOW', action: 'NONE', data_sources: [] }));
  }

  return out;
}

// ------------------------------------------------------------------
// Priority selection — the client's single biggest actionable focus.
// Deterministic rules; never random.
// ------------------------------------------------------------------
export function pickPriority(insights) {
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const actionable = insights.filter((i) => i.action !== 'NONE');
  const pool = actionable.length ? actionable : insights;
  const byPri = [...pool].sort((a, b) => rank[a.priority] - rank[b.priority] || (b.confidence === 'HIGH' ? 1 : 0) - (a.confidence === 'HIGH' ? 1 : 0));
  const top = byPri[0];
  if (!top) return null;
  return {
    ...top,
    title: top.title,
    message: top.message,
    action: top.action
  };
}

// ------------------------------------------------------------------
// Daily brief — 3–5 concise, data-backed insights + today's priority.
// ------------------------------------------------------------------
export function buildBrief(ctx, { withAI = false, ai = null } = {}) {
  const insights = computeInsights(ctx);
  const priority = pickPriority(insights);
  const brief = {
    ok: true,
    generated_at: new Date().toISOString(),
    provider: withAI && ai?.providerName ? ai.providerName() : 'deterministic',
    ai_framed: !!withAI,
    priority,
    insights: insights.slice(0, 5).map(({ type, title, message, reason, priority, confidence, action }) => ({ type, title, message, reason, priority, confidence, action })),
    note: 'Insights are based on your logged data only — they are training guidance, not medical advice.'
  };
  return brief;
}

// ------------------------------------------------------------------
// Weekly review — what went well / needs attention / next priority.
// ------------------------------------------------------------------
export function buildWeekly(ctx) {
  const insights = computeInsights(ctx);
  const n = ctx.nutrition || {};
  const tr = ctx.training || {};
  const rec = ctx.recovery || {};
  const w = (ctx.progress || {}).weight || {};

  const wentWell = [];
  const needsAttention = [];

  if (tr.week_workouts >= 3) wentWell.push(`You logged ${tr.week_workouts} workouts this week.`);
  if (n.week_avg?.days_logged >= 4 && n.week_avg.protein != null && n.daily_target?.protein && n.week_avg.protein >= n.daily_target.protein * 0.9) {
    wentWell.push(`Protein averaged ${n.week_avg.protein}g on logged days — at or near your ${n.daily_target.protein}g target.`);
  }
  if (rec.sleep_7d_avg_h != null && ctx.profile?.sleep_target_h && rec.sleep_7d_avg_h >= ctx.profile.sleep_target_h - 0.5) {
    wentWell.push(`Sleep averaged ${rec.sleep_7d_avg_h}h — close to your ${ctx.profile.sleep_target_h}h target.`);
  }
  if (w.trend_14d != null && w.trend_14d < -0.6) wentWell.push(`Weight trend is ${Math.abs(w.trend_14d)}kg down over 14 days.`);

  if (tr.week_workouts < 2) needsAttention.push(`Only ${tr.week_workouts} workout${tr.week_workouts === 1 ? '' : 's'} logged this week.`);
  if (n.week_avg?.protein != null && n.daily_target?.protein && n.week_avg.protein < n.daily_target.protein * 0.8) {
    needsAttention.push(`Protein averaged ${n.week_avg.protein}g — below the ${n.daily_target.protein}g target on logged days.`);
  }
  if (rec.sleep_7d_avg_h != null && ctx.profile?.sleep_target_h && rec.sleep_7d_avg_h < ctx.profile.sleep_target_h - 0.75) {
    needsAttention.push(`Sleep averaged ${rec.sleep_7d_avg_h}h against a ${ctx.profile.sleep_target_h}h target.`);
  }
  if (n.week_avg?.days_logged != null && n.week_avg.days_logged < 3) {
    needsAttention.push(`Nutrition was logged on only ${n.week_avg.days_logged} of the last 7 days — more consistent logging helps the coach see your real intake.`);
  }

  // next priority from the deterministic insight ranking
  const pri = pickPriority(insights);

  const insufficient = (tr.week_workouts || 0) + (n.week_avg?.days_logged || 0) + (w.count || 0) < 4;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    week_label: 'last 7 days',
    went_well: wentWell.length ? wentWell : ['Not enough data to call out wins yet.'],
    needs_attention: needsAttention.length ? needsAttention : ['Nothing stands out — keep logging to keep this review useful.'],
    next_week_priority: pri ? {
      type: pri.type,
      title: pri.title,
      message: pri.message,
      action: pri.action
    } : null,
    insufficient_data: insufficient,
    note: 'Based on your logged data over the last 7 days — training guidance, not medical advice.'
  };
}

// ------------------------------------------------------------------
// Food suggestions — search the REAL database for protein fillers.
// Nutrition values come from the DB, never invented.
// ------------------------------------------------------------------
export async function suggestFoods(db, orgId, clientId, { needProtein = 0, needCalories = 0, limit = 4 } = {}) {
  const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [clientId]);
  const diet = profile?.diet_type || null;
  const exclusions = String(profile?.food_exclusions || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const foods = await db.q(
    `SELECT * FROM foods WHERE (is_global = 1 OR org_id = ? OR client_id = ?) AND (calories > 0 OR protein > 0) ORDER BY protein DESC LIMIT 40`,
    [orgId, clientId]);
  const scored = [];
  const NON_VEG_RE = /chicken|fish|prawn|mutton|tuna|salmon|egg/i;
  const ANIMAL_RE = /chicken|fish|prawn|mutton|tuna|salmon|egg|milk|curd|paneer|whey|ghee|butter|cheese|yogurt/i;
  for (const f of foods) {
    const name = f.name.toLowerCase();
    if (diet === 'VEG' && NON_VEG_RE.test(name)) continue;
    if (diet === 'VEGAN' && ANIMAL_RE.test(name)) continue;
    if (exclusions.some((ex) => name.includes(ex))) continue;
    const proteinPer = f.protein || 0;
    const calPer = f.calories || 0;
    let score = proteinPer;
    if (needProtein > 0) score += Math.min(proteinPer, needProtein) * 2;
    if (needCalories > 0) score += Math.max(0, needCalories - calPer) * -0.01;
    scored.push({ food: f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ food: f }) => ({
    name: f.name,
    serving: f.serving || `${f.unit || 'serving'}`,
    calories: f.calories,
    protein: f.protein,
    carbs: f.carbs,
    fat: f.fat,
    source: f.source || 'USER_ENTERED'
  }));
}
