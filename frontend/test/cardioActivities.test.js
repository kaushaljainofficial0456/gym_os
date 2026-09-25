/**
 * These numbers end up in front of people as "you burned about X", so
 * the tests check them against the published values they come from
 * rather than against whatever the code currently returns.
 *
 * The old model added incline, speed and resistance into one "effort
 * score" and compared it to two magic thresholds, which meant walking at
 * 7 km/h and running at 7 km/h — genuinely different activities — came
 * out identical, and a 2% incline scored the same as a resistance of 2.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVITIES, ACTIVITY_BY_ID, metFor, estimateKcal, usesEffortLevel,
  isSport, activityName, SPORT, MACHINE, OUTDOOR,
} from '../src/cardioActivities.js';

describe('the catalogue', () => {
  it('covers machines, outdoor and sport', () => {
    const kinds = new Set(ACTIVITIES.map((a) => a.kind));
    expect(kinds).toContain(MACHINE);
    expect(kinds).toContain(OUTDOOR);
    expect(kinds).toContain(SPORT);
  });

  it('includes the sports people actually play', () => {
    for (const id of ['badminton', 'football', 'cricket', 'basketball', 'tennis', 'kabaddi']) {
      expect(ACTIVITY_BY_ID.has(id), `${id} missing`).toBe(true);
      expect(isSport(id)).toBe(true);
    }
  });

  it('has unique ids and a real name for each', () => {
    const ids = ACTIVITIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACTIVITIES) expect(a.name.length).toBeGreaterThan(1);
  });

  it('asks only for parameters it uses', () => {
    // A field the model ignores is a question with no purpose.
    for (const a of ACTIVITIES) {
      if (typeof a.met === 'function') continue;
      // Categorical activities may still collect a display parameter, but
      // must not collect more than two — that is a form, not a quick log.
      expect(a.fields.length, `${a.id}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('speed-driven activities use the ACSM equations', () => {
  it('separates walking from running at the same speed', () => {
    // The old heuristic could not: both landed in the same effort bucket.
    const walk = metFor('walking', { speed: 7 });
    const run = metFor('running', { speed: 7 });
    expect(run).toBeGreaterThan(walk);
  });

  it('responds continuously to speed rather than in two steps', () => {
    const a = metFor('running', { speed: 8 });
    const b = metFor('running', { speed: 10 });
    const c = metFor('running', { speed: 12 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('matches the published cost of running at 10 km/h', () => {
    // ACSM: VO2 = 0.2 * 166.7 + 3.5 = 36.8 ml/kg/min -> ~10.5 MET.
    expect(metFor('running', { speed: 10 })).toBeCloseTo(10.5, 1);
  });

  it('matches the published cost of walking at 5 km/h', () => {
    // ACSM: VO2 = 0.1 * 83.3 + 3.5 = 11.8 ml/kg/min -> ~3.4 MET.
    expect(metFor('walking', { speed: 5 })).toBeCloseTo(3.4, 1);
  });

  it('makes an incline cost more', () => {
    const flat = metFor('incline_walk', { speed: 5.5, incline: 0 });
    const steep = metFor('incline_walk', { speed: 5.5, incline: 10 });
    expect(steep).toBeGreaterThan(flat * 1.4);
  });

  it('does not let an effort picker double-count speed', () => {
    // Running 12 km/h "easy" is not a different energy cost from running
    // 12 km/h "hard" — it is the same run described two ways.
    expect(metFor('running', { speed: 12 }, 'light'))
      .toBe(metFor('running', { speed: 12 }, 'hard'));
    expect(usesEffortLevel('running')).toBe(false);
    expect(usesEffortLevel('badminton')).toBe(true);
  });
});

describe('categorical activities', () => {
  it('rises with effort', () => {
    expect(metFor('badminton', {}, 'light')).toBeLessThan(metFor('badminton', {}, 'hard'));
  });

  it('uses moderate when the effort is missing or nonsense', () => {
    expect(metFor('badminton', {}, undefined)).toBe(metFor('badminton', {}, 'moderate'));
    expect(metFor('badminton', {}, 'extreme')).toBe(metFor('badminton', {}, 'moderate'));
  });

  it('places sports sensibly against each other', () => {
    // Yoga is not football. If this ever inverts, the table is wrong.
    expect(metFor('yoga', {}, 'moderate')).toBeLessThan(metFor('badminton', {}, 'moderate'));
    expect(metFor('badminton', {}, 'moderate')).toBeLessThan(metFor('football', {}, 'moderate'));
    expect(metFor('golf', {}, 'moderate')).toBeLessThan(metFor('squash', {}, 'hard'));
  });

  it('falls back rather than throwing on an unknown activity', () => {
    expect(metFor('quidditch', {}, 'moderate')).toBeGreaterThan(0);
    expect(activityName('quidditch')).toBe('Activity');
  });
});

describe('energy', () => {
  it('follows the standard MET conversion', () => {
    // 8 MET, 70 kg, 30 min -> 8 * 3.5 * 70 / 200 * 30 = 294 kcal.
    const kcal = estimateKcal({ activityId: 'football', minutes: 30, bodyWeightKg: 70, effort: 'moderate' });
    expect(kcal).toBeCloseTo(8.5 * 3.5 * 70 / 200 * 30, 0);
  });

  it('scales with body mass, which is the point of asking for it', () => {
    const light = estimateKcal({ activityId: 'badminton', minutes: 60, bodyWeightKg: 60 });
    const heavy = estimateKcal({ activityId: 'badminton', minutes: 60, bodyWeightKg: 100 });
    expect(heavy / light).toBeCloseTo(100 / 60, 1);
  });

  it('returns zero rather than a guess when it cannot know', () => {
    // No body weight means no estimate. Inventing a default would put a
    // fabricated number on screen next to real ones.
    expect(estimateKcal({ activityId: 'running', minutes: 30, bodyWeightKg: 0 })).toBe(0);
    expect(estimateKcal({ activityId: 'running', minutes: 0, bodyWeightKg: 70 })).toBe(0);
  });

  it('never returns a negative or non-finite figure', () => {
    for (const a of ACTIVITIES) {
      const kcal = estimateKcal({ activityId: a.id, minutes: 45, bodyWeightKg: 75, params: {}, effort: 'moderate' });
      expect(Number.isFinite(kcal), a.id).toBe(true);
      expect(kcal, a.id).toBeGreaterThan(0);
    }
  });

  it('keeps an hour of every activity inside a believable range', () => {
    // A one-hour bout at 75 kg should land between a gentle 100 kcal and
    // an elite 1200. Anything outside that is a typo in the table.
    for (const a of ACTIVITIES) {
      const kcal = estimateKcal({ activityId: a.id, minutes: 60, bodyWeightKg: 75, effort: 'hard' });
      expect(kcal, `${a.id} = ${kcal}`).toBeGreaterThan(100);
      expect(kcal, `${a.id} = ${kcal}`).toBeLessThan(1200);
    }
  });
});

/* ── machine parameters actually reach the estimate ──────────────────
 *
 * These fields were collected and then discarded: the MET came from a
 * flat light/moderate/hard table, so resistance 3 and resistance 20 on
 * the same bike produced identical calories, and the skipping screen
 * asked for a pace it never read. Reported from the product as "add
 * more factors in cardio to predict more accurate burns".
 */
describe('machine resistance and power change the answer', () => {
  const KG = 70;

  it('a heavier resistance burns more than a light one', () => {
    const easy = metFor('cycling', { resistance: 3 }, 'moderate', KG);
    const hard = metFor('cycling', { resistance: 20 }, 'moderate', KG);
    expect(hard).toBeGreaterThan(easy);
  });

  it('stays inside the activity own published anchors', () => {
    // The interpolation must not invent intensities the source does not
    // contain -- level 1 is the easy value, the top of the range is hard.
    expect(metFor('cycling', { resistance: 1 }, 'moderate', KG)).toBeCloseTo(5.8, 1);
    expect(metFor('cycling', { resistance: 25 }, 'moderate', KG)).toBeCloseTo(10.5, 1);
  });

  it('prefers measured watts over a resistance level', () => {
    // 150 W on an ergometer is a known oxygen cost (ACSM); a "level" is
    // not comparable between two machines, so power wins when given.
    const byPower = metFor('cycling', { watts: 150, resistance: 1 }, 'light', KG);
    expect(byPower).toBeGreaterThan(8);
    expect(byPower).toBeLessThan(10);
  });

  it('scales power with body mass, as the equation does', () => {
    const light = metFor('cycling', { watts: 150 }, 'moderate', 55);
    const heavy = metFor('cycling', { watts: 150 }, 'moderate', 95);
    expect(light).toBeGreaterThan(heavy);   // same watts costs a smaller person more METs
  });

  it('rows on the ergometer manufacturer own power relationship', () => {
    const met = metFor('rowing_machine', { watts: 150 }, 'moderate', KG);
    expect(met).toBeGreaterThan(9);
    expect(met).toBeLessThan(14);
  });

  it('reads the skipping pace it asks for', () => {
    const slow = metFor('jump_rope', { speed: 100 }, 'moderate', KG);
    const fast = metFor('jump_rope', { speed: 140 }, 'moderate', KG);
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeCloseTo(8.8, 1);
    expect(fast).toBeCloseTo(12.3, 1);
  });

  it('falls back to the chosen effort when nothing was entered', () => {
    expect(metFor('cycling', {}, 'light', KG)).toBeCloseTo(5.8, 1);
    expect(metFor('cycling', {}, 'moderate', KG)).toBeCloseTo(7.0, 1);
    expect(metFor('cycling', {}, 'hard', KG)).toBeCloseTo(10.5, 1);
  });

  it('keeps the effort picker for machines whose parameters are optional', () => {
    // Speed-driven activities hide it (the speed IS the effort); a bike
    // logged with no resistance still needs somewhere to say how hard.
    expect(usesEffortLevel('cycling')).toBe(true);
    expect(usesEffortLevel('rowing_machine')).toBe(true);
    expect(usesEffortLevel('treadmill_run')).toBe(false);
  });

  it('turns a different resistance into a different calorie figure', () => {
    const easy = estimateKcal({ activityId: 'cycling', minutes: 30, bodyWeightKg: KG, params: { resistance: 3 } });
    const hard = estimateKcal({ activityId: 'cycling', minutes: 30, bodyWeightKg: KG, params: { resistance: 20 } });
    expect(hard).toBeGreaterThan(easy);
  });
});
