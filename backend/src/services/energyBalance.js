// ============================================================
// NET ENERGY BALANCE — "am I in a surplus or a deficit today?"
//
// The app could already tell you what you ATE and, separately, roughly
// what you BURNED, and never once subtracted one from the other. That
// difference is the single number a cut or a bulk is actually run on:
// eating 2,800 against 2,600 burned is +200, and whether that figure is
// positive or negative, day after day, IS the outcome. Both halves
// existed; nothing joined them.
//
// ── WHAT GOES INTO BURN, AND WHY EACH IS SAFE TO ADD ─────────────────
//
// RESTING comes from Mifflin-St Jeor via restingEnergy.js — the same
// formula the nutrition targets use, imported rather than re-derived, so
// the two cannot drift apart. It is PRORATED for a day in progress:
// showing a full 24 hours of resting burn at 9am would report a deficit
// nobody has earned yet, and the feature would read as a lie by lunch.
//
// WORKOUTS come from workouts.estimated_active_kcal, which the schema
// defines as energy ABOVE resting for that session. Active and resting
// energy are disjoint by construction, so these add cleanly.
//
// CARDIO is the one needing correction. cardio_sessions.kcal comes from
// a MET model (frontend/src/cardioActivities.js), and MET figures are
// GROSS — 1 MET is the definition of merely existing, so a 7-MET hour
// contains an hour of resting energy inside it. Adding that straight
// onto a full day of resting counts the overlap twice. So the resting
// share of each bout is subtracted and only the ACTIVE remainder is
// added, matching how workouts are already stored. For a 45-minute
// 7-MET session at 70 kg that is 331 rather than 386 kcal — not huge,
// and exactly the sort of quiet 15% inflation that makes someone trust
// a deficit which was never there.
//
// ── WHEN WE DO NOT KNOW ──────────────────────────────────────────────
// Mifflin-St Jeor needs weight, height, age and sex. Miss any one and
// BMR is null — and then resting is null, burn is null, and net is
// null. It is NOT "intake minus the parts we happen to have", which
// would report a wild surplus to every user with an incomplete profile
// while looking exactly like a working feature. `missing` names what to
// ask for instead.
// ============================================================
import { mifflinStJeorBmr, restingEnergyForSeconds, elapsedSecondsOfDay } from './intelligence/restingEnergy.js';
import { dayStartHour } from './logDay.js';
import { DEFAULT_TZ } from '../utils/time.js';

/** Milliseconds at which `dateKey` begins for this client — the logging
 *  day boundary (day_start_hour), not midnight, so the elapsed-time
 *  proration agrees with which day a log was actually filed under.
 *
 *  The zone offset is MEASURED at that instant rather than assumed, so a
 *  client whose region observes DST still gets the right boundary on the
 *  two days a year it shifts. */
function dayStartMsFor(dateKey, tz, startHour) {
  const naive = Date.parse(dateKey + 'T' + String(startHour).padStart(2, '0') + ':00:00Z');
  if (!Number.isFinite(naive)) return NaN;
  const probe = new Date(naive);
  const asLocal = new Date(probe.toLocaleString('en-US', { timeZone: tz }));
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  return naive + (asUtc.getTime() - asLocal.getTime());
}

/** The resting energy contained INSIDE a bout of exercise, which a gross
 *  MET figure has already counted once. */
function restingShareOfBout(bmrPerDay, durationSec) {
  if (!Number.isFinite(bmrPerDay) || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return (bmrPerDay / 86400) * durationSec;
}

const r0 = (n) => (n == null ? null : Math.round(n));

/**
 * One day's energy balance, every figure in kcal.
 * net = intake - burn, so POSITIVE is a surplus and NEGATIVE a deficit.
 */
export function composeBalance({ dateKey, bmrPerDay, elapsedSeconds, intakeKcal, workoutKcal, cardio }) {
  const resting = restingEnergyForSeconds(bmrPerDay, elapsedSeconds);

  // Each bout contributes only what it added ON TOP of simply existing.
  const cardioActive = (cardio || []).reduce((sum, c) => {
    const gross = Number(c.kcal);
    if (!Number.isFinite(gross) || gross <= 0) return sum;
    const active = gross - restingShareOfBout(bmrPerDay, Number(c.duration_sec));
    return sum + Math.max(0, active);
  }, 0);

  const workout = Number.isFinite(Number(workoutKcal)) ? Number(workoutKcal) : 0;
  const intake = Number(intakeKcal) || 0;
  const burn = resting == null ? null : resting + workout + cardioActive;

  return {
    date: dateKey,
    intakeKcal: r0(intake),
    burn: {
      restingKcal: r0(resting),
      workoutKcal: r0(workout),
      cardioKcal: r0(cardioActive),
      totalKcal: r0(burn),
    },
    // Null, never a half-computed figure — see the header.
    netKcal: burn == null ? null : Math.round(intake - burn),
    partialDay: elapsedSeconds < 86400,
  };
}

/** Which profile fields Mifflin-St Jeor is still waiting on, so the UI
 *  can ask for the missing one by name instead of showing a dash. */
export function missingForBmr(client) {
  const need = [
    ['weight', client && client.current_weight],
    ['height', client && client.height_cm],
    ['age', client && client.age],
  ];
  const out = need.filter(([, v]) => !Number.isFinite(Number(v)) || Number(v) <= 0).map(([k]) => k);
  if (!client || !String(client.sex || '').trim()) out.push('sex');
  return out;
}

/**
 * Balance for every day in [fromKey, toKey] inclusive.
 *
 * Days with nothing logged are still returned. A gap in a cut IS
 * information — a chart that silently closes up over the days you tracked
 * nothing would draw a continuous line through weeks that never happened.
 */
export async function balanceRange(db, client, { fromKey, toKey, tz = DEFAULT_TZ, now = new Date() }) {
  const startHour = await dayStartHour(db, client.id);
  const bmrPerDay = mifflinStJeorBmr({
    weightKg: client.current_weight, heightCm: client.height_cm, age: client.age, sex: client.sex,
  });

  const [meals, workouts, cardio] = await Promise.all([
    db.q('SELECT date, SUM(calories) AS kcal FROM meal_logs'
       + ' WHERE client_id = ? AND date >= ? AND date <= ? AND eaten = 1 GROUP BY date',
    [client.id, fromKey, toKey]),
    // Only COMPLETED sessions burned anything. One still in progress, or
    // scheduled and never done, must not contribute.
    db.q('SELECT substr(completed_at, 1, 10) AS date, SUM(estimated_active_kcal) AS kcal'
       + ' FROM workouts WHERE client_id = ? AND completed_at IS NOT NULL'
       + ' AND estimated_active_kcal IS NOT NULL'
       + ' AND substr(completed_at, 1, 10) >= ? AND substr(completed_at, 1, 10) <= ?'
       + ' GROUP BY substr(completed_at, 1, 10)',
    [client.id, fromKey, toKey]),
    db.q('SELECT date, kcal, duration_sec FROM cardio_sessions'
       + ' WHERE client_id = ? AND date >= ? AND date <= ?',
    [client.id, fromKey, toKey]),
  ]);

  const intakeBy = new Map(meals.map((m) => [m.date, Number(m.kcal) || 0]));
  const workoutBy = new Map(workouts.map((w) => [w.date, Number(w.kcal) || 0]));
  const cardioBy = new Map();
  for (const c of cardio) {
    if (!cardioBy.has(c.date)) cardioBy.set(c.date, []);
    cardioBy.get(c.date).push(c);
  }

  const days = [];
  const nowMs = now.getTime();
  const cursor = new Date(fromKey + 'T00:00:00Z');
  for (let guard = 0; guard < 800; guard += 1) {
    const key = cursor.toISOString().slice(0, 10);
    if (key > toKey) break;
    days.push(composeBalance({
      dateKey: key,
      bmrPerDay,
      elapsedSeconds: elapsedSecondsOfDay({ dayStartMs: dayStartMsFor(key, tz, startHour), nowMs }),
      intakeKcal: intakeBy.get(key) || 0,
      workoutKcal: workoutBy.get(key) || 0,
      cardio: cardioBy.get(key) || [],
    }));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { days, bmrPerDay: r0(bmrPerDay), missing: missingForBmr(client) };
}
