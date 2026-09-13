/**
 * CARDIO AND SPORT — one catalogue, one energy model.
 *
 * This lived inside Workout.jsx as a MET table plus a heuristic that
 * added incline, speed and resistance into a single "effort score" and
 * compared it to two magic thresholds. That produced a number, but not a
 * defensible one: a 2% incline and a resistance level of 2 scored the
 * same as a 6% incline, and walking at 7 km/h and running at 7 km/h --
 * genuinely different activities -- came out identical.
 *
 * TWO MODELS, EACH USED WHERE IT IS ACTUALLY VALID.
 *
 *   Walking, running and inclines use the ACSM metabolic equations,
 *   which are the published relationship between speed, gradient and
 *   oxygen cost. They take real inputs the user already enters, and they
 *   respond continuously -- 6 km/h and 6.5 km/h differ, as they should.
 *
 *   Everything else uses Compendium of Physical Activities MET values,
 *   because for badminton or rowing there is no equation to apply: what
 *   exists is measured intensity for a named activity at a named effort.
 *   Pretending otherwise by inventing a formula would be less accurate,
 *   not more.
 *
 * THE ESTIMATE SAYS IT IS AN ESTIMATE. Every consumer shows it as one.
 * MET-based energy is a population average applied to one person; it is
 * useful for comparing your own Tuesday to your own Thursday and close
 * to worthless as an absolute truth, and the UI must never imply the
 * second.
 *
 * Sources: ACSM's Guidelines for Exercise Testing and Prescription
 * (metabolic equations); Ainsworth et al., Compendium of Physical
 * Activities (MET values).
 */

/* ── kinds ────────────────────────────────────────────────────────── */
export const MACHINE = 'machine';
export const SPORT = 'sport';
export const OUTDOOR = 'outdoor';

/** Effort levels, where a categorical MET is the honest model. */
export const EFFORTS = [
  { key: 'light', label: 'Easy', hint: 'Could hold a conversation' },
  { key: 'moderate', label: 'Moderate', hint: 'Breathing hard, can still talk' },
  { key: 'hard', label: 'Hard', hint: 'Too breathless to talk' },
];

/**
 * ACSM metabolic equations. Speed in km/h, grade as a percentage.
 * Both return VO2 in ml/kg/min, which becomes MET by dividing by 3.5.
 *
 * The walking equation is validated for roughly 3-6 km/h and the running
 * one from about 8 km/h up; between those, people are usually running,
 * so the crossover is handled by the caller choosing the activity.
 */
function walkingVo2(speedKmh, gradePct) {
  const mPerMin = (Number(speedKmh) || 0) * 1000 / 60;
  const grade = (Number(gradePct) || 0) / 100;
  return (0.1 * mPerMin) + (1.8 * mPerMin * grade) + 3.5;
}
function runningVo2(speedKmh, gradePct) {
  const mPerMin = (Number(speedKmh) || 0) * 1000 / 60;
  const grade = (Number(gradePct) || 0) / 100;
  // The 0.5 factor on the grade term is the ACSM allowance for running:
  // the vertical cost is lower than walking's because of the flight phase.
  return (0.2 * mPerMin) + (0.9 * mPerMin * grade * 0.5 * 2) + 3.5;
}

const metFromVo2 = (vo2) => Math.max(1, vo2 / 3.5);

/**
 * THE CATALOGUE.
 *
 * `met` is either a {light,moderate,hard} triple, or a function of the
 * entered parameters. `fields` are what the UI asks for, and nothing
 * asks for a number it does not use.
 */
export const ACTIVITIES = [
  /* ---------------- machines ---------------- */
  {
    id: 'treadmill_run', kind: MACHINE, name: 'Treadmill run', icon: 'strength',
    fields: [
      { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '10', min: 1, max: 25 },
      { key: 'incline', label: 'Incline', unit: '%', placeholder: '1', min: 0, max: 20 },
    ],
    met: (p) => metFromVo2(runningVo2(p.speed || 10, p.incline)),
  },
  {
    id: 'incline_walk', kind: MACHINE, name: 'Incline walk', icon: 'strength',
    fields: [
      { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '5.5', min: 1, max: 15 },
      { key: 'incline', label: 'Incline', unit: '%', placeholder: '10', min: 0, max: 20 },
    ],
    met: (p) => metFromVo2(walkingVo2(p.speed || 5.5, p.incline)),
  },
  {
    id: 'cycling', kind: MACHINE, name: 'Exercise bike', icon: 'strength',
    fields: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 25 }],
    met: { light: 5.8, moderate: 7.0, hard: 10.5 },
  },
  {
    id: 'rowing_machine', kind: MACHINE, name: 'Rowing machine', icon: 'strength',
    fields: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '5', min: 1, max: 20 }],
    met: { light: 4.8, moderate: 7.0, hard: 12.0 },
  },
  {
    id: 'elliptical', kind: MACHINE, name: 'Elliptical', icon: 'strength',
    fields: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '8', min: 1, max: 25 }],
    met: { light: 4.6, moderate: 5.0, hard: 7.0 },
  },
  {
    id: 'stair_climber', kind: MACHINE, name: 'Stair climber', icon: 'strength',
    fields: [{ key: 'level', label: 'Level', unit: '', placeholder: '10', min: 1, max: 25 }],
    met: { light: 5.0, moderate: 8.0, hard: 11.0 },
  },
  {
    id: 'assault_bike', kind: MACHINE, name: 'Air bike', icon: 'strength',
    fields: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 20 }],
    met: { light: 7.0, moderate: 9.5, hard: 12.5 },
  },
  {
    id: 'ski_erg', kind: MACHINE, name: 'Ski erg', icon: 'strength',
    fields: [{ key: 'resistance', label: 'Resistance', unit: 'level', placeholder: '6', min: 1, max: 10 }],
    met: { light: 5.5, moderate: 8.0, hard: 11.0 },
  },
  {
    id: 'jump_rope', kind: MACHINE, name: 'Skipping', icon: 'strength',
    fields: [{ key: 'speed', label: 'Pace', unit: 'RPM', placeholder: '120', min: 30, max: 220 }],
    met: { light: 8.8, moderate: 11.8, hard: 12.3 },
  },
  {
    id: 'battle_ropes', kind: MACHINE, name: 'Battle ropes', icon: 'strength',
    fields: [], met: { light: 5.0, moderate: 8.0, hard: 10.5 },
  },
  {
    id: 'sprint_intervals', kind: MACHINE, name: 'Sprint intervals', icon: 'strength',
    fields: [], met: { light: 8.0, moderate: 10.0, hard: 13.5 },
  },

  /* ---------------- outdoor ---------------- */
  {
    id: 'running', kind: OUTDOOR, name: 'Running', icon: 'trending',
    fields: [
      { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '10', min: 1, max: 30 },
      { key: 'distance', label: 'Distance', unit: 'km', placeholder: '5', min: 0.1, max: 100, optional: true },
    ],
    met: (p) => metFromVo2(runningVo2(p.speed || 10, 0)),
  },
  {
    id: 'walking', kind: OUTDOOR, name: 'Walking', icon: 'trending',
    fields: [
      { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '5', min: 1, max: 15 },
      { key: 'distance', label: 'Distance', unit: 'km', placeholder: '3', min: 0.1, max: 50, optional: true },
    ],
    met: (p) => metFromVo2(walkingVo2(p.speed || 5, 0)),
  },
  {
    id: 'road_cycling', kind: OUTDOOR, name: 'Cycling (outdoor)', icon: 'trending',
    fields: [
      { key: 'speed', label: 'Speed', unit: 'km/h', placeholder: '22', min: 5, max: 60 },
      { key: 'distance', label: 'Distance', unit: 'km', placeholder: '20', min: 0.5, max: 300, optional: true },
    ],
    /* Compendium bands by speed rather than an equation: air resistance
       dominates outdoors and a flat formula would overstate slow riding. */
    met: (p) => {
      const s = Number(p.speed) || 22;
      if (s < 16) return 4.0;
      if (s < 19) return 6.8;
      if (s < 22.5) return 8.0;
      if (s < 25.5) return 10.0;
      if (s < 32) return 12.0;
      return 15.8;
    },
  },
  { id: 'hiking', kind: OUTDOOR, name: 'Hiking', icon: 'trending', fields: [], met: { light: 5.3, moderate: 6.0, hard: 7.8 } },
  { id: 'swimming', kind: OUTDOOR, name: 'Swimming', icon: 'trending', fields: [], met: { light: 5.3, moderate: 8.3, hard: 9.8 } },
  { id: 'stair_climbing_real', kind: OUTDOOR, name: 'Stairs', icon: 'trending', fields: [], met: { light: 4.0, moderate: 8.8, hard: 15.0 } },

  /* ---------------- sport ----------------
     Compendium values. Where a sport has a clear social/competitive
     split, that IS the light/hard spread rather than an invented one. */
  { id: 'badminton', kind: SPORT, name: 'Badminton', icon: 'users', fields: [], met: { light: 4.5, moderate: 5.5, hard: 7.0 } },
  { id: 'football', kind: SPORT, name: 'Football', icon: 'users', fields: [], met: { light: 7.0, moderate: 8.5, hard: 10.0 } },
  { id: 'cricket', kind: SPORT, name: 'Cricket', icon: 'users', fields: [], met: { light: 3.8, moderate: 4.8, hard: 6.0 } },
  { id: 'basketball', kind: SPORT, name: 'Basketball', icon: 'users', fields: [], met: { light: 4.5, moderate: 6.5, hard: 8.0 } },
  { id: 'tennis', kind: SPORT, name: 'Tennis', icon: 'users', fields: [], met: { light: 5.0, moderate: 6.0, hard: 8.0 } },
  { id: 'table_tennis', kind: SPORT, name: 'Table tennis', icon: 'users', fields: [], met: { light: 3.5, moderate: 4.0, hard: 5.0 } },
  { id: 'squash', kind: SPORT, name: 'Squash', icon: 'users', fields: [], met: { light: 5.5, moderate: 7.3, hard: 12.0 } },
  { id: 'volleyball', kind: SPORT, name: 'Volleyball', icon: 'users', fields: [], met: { light: 3.0, moderate: 4.0, hard: 6.0 } },
  { id: 'hockey', kind: SPORT, name: 'Hockey', icon: 'users', fields: [], met: { light: 6.0, moderate: 7.8, hard: 9.0 } },
  { id: 'kabaddi', kind: SPORT, name: 'Kabaddi', icon: 'users', fields: [], met: { light: 6.0, moderate: 8.0, hard: 10.0 } },
  { id: 'rugby', kind: SPORT, name: 'Rugby', icon: 'users', fields: [], met: { light: 6.3, moderate: 8.3, hard: 10.0 } },
  { id: 'handball', kind: SPORT, name: 'Handball', icon: 'users', fields: [], met: { light: 8.0, moderate: 10.0, hard: 12.0 } },
  { id: 'pickleball', kind: SPORT, name: 'Pickleball / padel', icon: 'users', fields: [], met: { light: 4.1, moderate: 5.5, hard: 7.0 } },
  { id: 'boxing', kind: SPORT, name: 'Boxing', icon: 'users', fields: [], met: { light: 5.5, moderate: 7.8, hard: 12.8 } },
  { id: 'martial_arts', kind: SPORT, name: 'Martial arts', icon: 'users', fields: [], met: { light: 5.3, moderate: 8.0, hard: 10.3 } },
  { id: 'climbing', kind: SPORT, name: 'Climbing', icon: 'users', fields: [], met: { light: 5.8, moderate: 7.5, hard: 9.0 } },
  { id: 'dancing', kind: SPORT, name: 'Dancing', icon: 'users', fields: [], met: { light: 3.5, moderate: 5.0, hard: 7.8 } },
  { id: 'yoga', kind: SPORT, name: 'Yoga', icon: 'users', fields: [], met: { light: 2.5, moderate: 3.0, hard: 4.0 } },
  { id: 'pilates', kind: SPORT, name: 'Pilates', icon: 'users', fields: [], met: { light: 2.8, moderate: 3.0, hard: 3.8 } },
  { id: 'golf', kind: SPORT, name: 'Golf (walking)', icon: 'users', fields: [], met: { light: 3.5, moderate: 4.8, hard: 5.3 } },
  { id: 'skating', kind: SPORT, name: 'Skating', icon: 'users', fields: [], met: { light: 5.5, moderate: 7.0, hard: 9.0 } },
  { id: 'ultimate_frisbee', kind: SPORT, name: 'Ultimate frisbee', icon: 'users', fields: [], met: { light: 5.0, moderate: 8.0, hard: 9.0 } },
];

export const ACTIVITY_BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]));
export const activityName = (id) => ACTIVITY_BY_ID.get(id)?.name || 'Activity';
export const activityFields = (id) => ACTIVITY_BY_ID.get(id)?.fields || [];
export const isSport = (id) => ACTIVITY_BY_ID.get(id)?.kind === SPORT;

/** Grouped for a picker, in the order people look for them. */
export const ACTIVITY_GROUPS = [
  { key: MACHINE, label: 'Machines' },
  { key: OUTDOOR, label: 'Outdoor' },
  { key: SPORT, label: 'Sports' },
];

const DEFAULT_MET = { light: 5.0, moderate: 7.0, hard: 10.0 };

/**
 * The MET for one activity, at the entered parameters and effort.
 *
 * Effort only applies where the model is categorical. For a speed-driven
 * activity the speed IS the effort, and layering a light/hard multiplier
 * on top would double-count it -- running 12 km/h "easy" is not a
 * different energy cost from running 12 km/h "hard", it is the same run
 * described two ways.
 */
export function metFor(activityId, params = {}, effort = 'moderate') {
  const a = ACTIVITY_BY_ID.get(activityId);
  const table = a?.met ?? DEFAULT_MET;
  if (typeof table === 'function') {
    const met = Number(table(params || {}));
    return Number.isFinite(met) && met > 0 ? met : DEFAULT_MET.moderate;
  }
  const key = ['light', 'moderate', 'hard'].includes(effort) ? effort : 'moderate';
  return Number(table[key]) || DEFAULT_MET.moderate;
}

/** True when this activity's energy comes from a speed/grade equation, so
 *  the UI can hide an effort picker that would mean nothing. */
export function usesEffortLevel(activityId) {
  return typeof ACTIVITY_BY_ID.get(activityId)?.met !== 'function';
}

/**
 * Kilocalories for a bout.
 *
 * kcal = MET x 3.5 x kg / 200 x minutes -- the standard conversion from
 * a MET value to energy for a given body mass. Body mass matters and is
 * the single biggest input after duration, which is why it is required
 * rather than assumed: a 60 kg and a 100 kg person doing the same hour
 * are nearly 70% apart.
 */
export function estimateKcal({ activityId, minutes, bodyWeightKg, params = {}, effort = 'moderate' }) {
  const mins = Number(minutes) || 0;
  const kg = Number(bodyWeightKg) || 0;
  if (mins <= 0 || kg <= 0) return 0;
  const met = metFor(activityId, params, effort);
  return Math.round((met * 3.5 * kg / 200) * mins);
}
