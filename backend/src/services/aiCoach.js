// ============================================================
// AI COACH — service abstraction.
// Deterministic rule-based engine for the MVP. Every insight is
// derived ONLY from data present in the database, and the payload
// carries explicit provenance so the UI can badge each number as:
//   measured  — directly recorded (weight, logs)
//   calculated — derived from measured data (adherence, averages)
//   estimate  — approximated (AI food estimates)
// Swap this file's internals for a real LLM call later — the
// function contract (analyzeClientProgress → insight object) stays.
// ============================================================
import { computeAdherence } from './adherence.js';
import { suggestNextTarget } from './progressiveOverload.js';
import { daysAgoIso, todayKey, weekDay, round1, round2 } from '../utils/time.js';

function plateauAnalysis(weights) {
  // Match the at-risk engine: look at the most recent 35 days only.
  const cutoff = daysAgoIso(35);
  const recent = weights.filter(w => w.date >= cutoff);
  if (recent.length < 3) return null;
  const span = Math.round((new Date(recent[recent.length - 1].date) - new Date(recent[0].date)) / 86400000);
  const net = recent[0].weight - recent[recent.length - 1].weight;
  return { span, net: round2(net), flat: span >= 21 && net < 0.3,
    first: recent[0].weight, last: recent[recent.length - 1].weight };
}

function weekendVsWeekday(mealLogs) {
  const eaten = mealLogs.filter(l => l.eaten);
  const wk = eaten.filter(l => { const d = weekDay(l.date); return d === 0 || d === 6; });
  const wd = eaten.filter(l => { const d = weekDay(l.date); return d >= 1 && d <= 5; });
  if (wk.length < 2 || wd.length < 2) return null;
  const avg = (arr) => round1(arr.reduce((s, l) => s + l.calories, 0) / arr.length);
  const wkV = avg(wk), wdV = avg(wd);
  return { weekend: wkV, weekday: wdV, deviation: round1(wkV - wdV), weekendDays: wk.length, weekdayDays: wd.length };
}

export async function analyzeClientProgress(db, clientId) {
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) return null;
  const profile = await db.q1('SELECT * FROM client_profiles WHERE client_id = ?', [clientId]);
  const plan = await db.q1('SELECT * FROM nutrition_plans WHERE client_id = ? ORDER BY created_at DESC LIMIT 1', [clientId]);

  const [weights, workoutLogs, mealLogs, sleepLogs, adherence, workouts] = await Promise.all([
    db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? AND date >= ? ORDER BY date', [clientId, daysAgoIso(60)]),
    db.q('SELECT date, exercise_id, weight, reps FROM workout_logs WHERE client_id = ? AND date >= ? ORDER BY date', [clientId, daysAgoIso(42)]),
    db.q('SELECT date, calories, protein, eaten FROM meal_logs WHERE client_id = ? AND date >= ?', [clientId, daysAgoIso(28)]),
    db.q('SELECT date, duration_h FROM sleep_logs WHERE client_id = ? AND date >= ? ORDER BY date DESC', [clientId, daysAgoIso(14)]),
    computeAdherence(db, clientId),
    db.q('SELECT status, scheduled_date FROM workouts WHERE client_id = ? AND scheduled_date >= ?', [clientId, daysAgoIso(28)])
  ]);

  // ---- measured data ----
  const measured = {
    lastWeight: weights.length ? weights[weights.length - 1] : null,
    weightCount: weights.length,
    workoutLogCount: workoutLogs.length,
    workoutCount: workouts.length,
    completedWorkouts: workouts.filter(w => w.status === 'completed').length,
    mealLogCount: mealLogs.filter(l => l.eaten).length,
    sleepDays: sleepLogs.length,
    avgSleepH: sleepLogs.length ? round2(sleepLogs.reduce((s, l) => s + l.duration_h, 0) / sleepLogs.length) : null
  };

  // ---- calculated values ----
  const plateau = plateauAnalysis(weights);
  const weekend = weekendVsWeekday(mealLogs);
  const calculated = {
    adherence: adherence.score,
    adherenceComponents: adherence.components,
    plateau,
    weekendCalories: weekend
  };

  // ---- decide the insight ----
  const exclusions = profile?.food_exclusions ? profile.food_exclusions.split(',').map(s => s.trim().toLowerCase()) : [];
  const target = plan ? { kcal: plan.calories, protein: plan.protein } : null;

  let type = 'general', summary = '', recommendation = '';
  const firstName = client.user_id ? (await db.q1('SELECT name FROM users WHERE id = ?', [client.user_id]))?.name?.split(' ')[0] || 'Client' : 'Client';

  if (plateau && plateau.flat) {
    type = 'plateau';
    const work = adherence.components.workout ?? null;
    const nut = adherence.components.nutrition ?? null;
    summary = `${firstName}'s training adherence is ${work !== null ? 'strong at ' + work + '%' : 'solid'}, but the ${plateau.span}-day plateau appears more related to nutrition consistency than workout performance.` +
      (weekend && Math.abs(weekend.deviation) >= 50
        ? ` Weekend calorie intake averages ${weekend.weekend} kcal vs ${weekend.weekday} kcal on weekdays — the largest visible deviation.`
        : ' Nutrition adherence sits at ' + (nut ?? 0) + '% — the biggest lever to pull.');
    recommendation = target
      ? `Review weekend meals and consider cutting ~100–150 kcal/day (target ≈ ${Math.round(target.kcal - 125)} kcal) if the plateau continues for another week.`
      : `Set a calorie target for ${firstName} so weekend intake can be monitored.`;
  } else if (adherence.components.protein !== null && adherence.components.protein < 80) {
    type = 'protein';
    summary = `${firstName}'s protein adherence is ${adherence.components.protein}% over the last 7 days — below the 80% floor that protects muscle during a cut.`;
    const excluded = exclusions.length ? ` (excluded: ${exclusions.join(', ')})` : '';
    recommendation = `Add one high-protein source per day — e.g. 150 g curd or 2 boiled eggs${excluded ? `, respecting exclusions${excluded}` : ''}.`;
  } else if (adherence.components.sleep !== null && adherence.components.sleep < 82) {
    type = 'sleep';
    summary = `${firstName} averages ${measured.avgSleepH}h of sleep vs an ${profile?.sleep_target_h ?? 8}h target (${adherence.components.sleep}% adherence). Sleep debt is linked to higher hunger and stalled fat loss.`;
    recommendation = `Move bedtime 30–45 min earlier for the next 7 days and log sleep daily — re-check adherence next week.`;
  } else if (adherence.components.nutrition !== null && adherence.components.nutrition < 65 && adherence.components.workout !== null && adherence.components.workout >= 70) {
    type = 'nutrition_gap';
    summary = `${firstName} trains consistently (${adherence.components.workout}% workout adherence) but meal adherence is ${adherence.components.nutrition}% — the gap between training effort and nutrition is the main bottleneck.`;
    recommendation = `Reduce plan complexity: simplify to 4 meals and confirm the meal times match ${firstName}'s actual eating windows.`;
  } else if (weekend && Math.abs(weekend.deviation) >= 150) {
    type = 'weekend_drift';
    summary = `${firstName}'s average intake rises ${weekend.deviation} kcal on weekends (${weekend.weekend} vs ${weekend.weekday} kcal).`;
    recommendation = `Pre-log weekend meals and schedule a Saturday check-in to keep the plan honest.`;
  } else if (workoutLogs.length) {
    // progressive overload angle — only for weighted lifts, not bodyweight movements
    const weighted = [...workoutLogs].reverse().find(l => l.weight > 0 && l.exercise_id);
    if (weighted && weighted.exercise_id) {
      const suggestion = await suggestNextTarget(db, clientId, weighted.exercise_id);
      if (suggestion) {
        type = 'overload';
        summary = `${firstName}'s last weighted session shows ${weighted.weight}kg × ${weighted.reps} — ${suggestion.rationale}`;
        recommendation = `Next target: ${suggestion.suggested.weight}kg × ${suggestion.suggested.reps} (${suggestion.increment}kg progression).`;
      }
    }
  }

  if (!summary) {
    summary = `${firstName} is tracking steadily — ${measured.weightCount} weight logs, ${adherence.components.workout ?? 0}% workout adherence, ${adherence.components.protein ?? 0}% protein. Keep the current plan consistent.`;
    recommendation = target
      ? `Hold calories near ${Math.round(target.kcal)} kcal and keep protein ≥ ${Math.round(target.protein)}g. Re-analyze in 7 days.`
      : `Set a nutrition plan so tracking can begin.`;
  }

  return {
    clientId, type,
    summary,
    recommendation,
    data: {
      measured,                       // directly recorded
      calculated,                     // derived from measured
      estimates: {},                  // AI estimates (populated when AI food logging used)
      provenance: ['measured', 'calculated'] // which categories were used
    },
    generatedAt: new Date().toISOString()
  };
}

export async function generateWeeklySummary(db, clientId) {
  const insight = await analyzeClientProgress(db, clientId);
  const a = await computeAdherence(db, clientId);
  return {
    summary: insight.summary,
    recommendation: insight.recommendation,
    adherence: a
  };
}

// Short, data-backed message shown on the client home screen.
export async function generateCoachMessage(db, clientId) {
  const a = await computeAdherence(db, clientId);
  const weights = await db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? ORDER BY date DESC LIMIT 2', [clientId]);
  const parts = [];
  if (weights.length === 2) {
    const delta = round1(weights[0].weight - weights[1].weight);
    parts.push(delta > 0.2 ? `Weight is trending down (${delta} kg this week) — keep going.` :
      delta < -0.2 ? `Weight crept up ${Math.abs(delta)} kg — let's review this week's intake.` : `Weight is holding steady this week.`);
  }
  if (a.components.protein !== null) parts.push(a.components.protein >= 85 ? 'Protein is on point.' : `Protein is at ${a.components.protein}% — aim a bit higher.`);
  if (a.components.workout !== null) parts.push(`Workout completion ${a.components.workout}%.`);
  return parts.join(' ') || 'Log your day and I\'ll have a sharper read tomorrow.';
}
