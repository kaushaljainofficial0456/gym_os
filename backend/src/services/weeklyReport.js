// Weekly client report: aggregates the last 7 days of real data.
import { computeAdherence } from './adherence.js';
import { generateWeeklySummary } from './aiCoach.js';
import { daysAgoIso, todayKey, lastNDays, round1, DOW } from '../utils/time.js';

export async function generateWeeklyReport(db, clientId) {
  const client = await db.q1('SELECT * FROM clients WHERE id = ?', [clientId]);
  const user = await db.q1('SELECT name FROM users WHERE id = ?', [client.user_id]);
  const days = lastNDays(7);
  const start = daysAgoIso(7);

  const [weights, workouts, water, sleep] = await Promise.all([
    db.q('SELECT date, weight FROM weight_logs WHERE client_id = ? AND date >= ? ORDER BY date', [clientId, start]),
    db.q('SELECT status FROM workouts WHERE client_id = ? AND scheduled_date >= ?', [clientId, start]),
    db.q('SELECT date, litres FROM water_logs WHERE client_id = ? AND date >= ?', [clientId, start]),
    db.q('SELECT date, duration_h FROM sleep_logs WHERE client_id = ? AND date >= ?', [clientId, start])
  ]);

  const a = await computeAdherence(db, clientId);
  const summary = await generateWeeklySummary(db, clientId);

  const wStart = weights[0]?.weight, wEnd = weights[weights.length - 1]?.weight;
  const avgWater = water.length ? round1(water.reduce((s, w) => s + w.litres, 0) / water.length) : null;
  const avgSleep = sleep.length ? round1(sleep.reduce((s, x) => s + x.duration_h, 0) / sleep.length) : null;

  return {
    clientId,
    clientName: user?.name || 'Client',
    period: { start, end: todayKey(), days: 7 },
    weight: wStart && wEnd ? { start: wStart, end: wEnd, delta: round1(wEnd - wStart) } : null,
    workouts: { done: workouts.filter(w => w.status === 'completed').length, scheduled: workouts.length },
    adherence: a,
    avgWater,
    avgSleep,
    daily: days.map(d => ({
      date: d,
      dow: DOW[new Date(d + 'T00:00:00Z').getUTCDay()],
      water: water.find(w => w.date === d)?.litres ?? 0,
      sleep: sleep.find(s => s.date === d)?.duration_h ?? null,
      weight: weights.find(w => w.date === d)?.weight ?? null
    })),
    coachSummary: summary.summary,
    nextWeek: [summary.recommendation],
    generatedAt: new Date().toISOString()
  };
}
