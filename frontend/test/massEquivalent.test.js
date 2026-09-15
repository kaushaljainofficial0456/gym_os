// ============================================================
// "ABOUT 2.8 HATCHBACK CARS" HAS TO BE TRUE.
//
// This is the one number on the session recap that is not simply the
// member's own data echoed back -- it is a claim about the world, made to
// someone who just worked hard, and it is the easiest thing on the screen
// to quietly get wrong in the flattering direction. So the arithmetic is
// pinned here: the multiplier times the object's real mass must come back
// to the volume it was given, every time.
//
// The selection rule is tested as hard as the arithmetic, because a
// correct number attached to a silly object ("0.4 of an elephant",
// "372 dumbbells") is a worse result than no comparison at all.
// ============================================================
import { describe, it, expect } from 'vitest';
import { massEquivalent, MASS_OBJECTS } from '../src/components/workout/massObjects.jsx';

describe('massEquivalent', () => {
  it('multiplier x object mass returns the original volume', () => {
    for (const kg of [20, 37, 119, 450, 900, 3408, 7500, 12500, 44000, 260000]) {
      const e = massEquivalent(kg);
      expect(e, `${kg} kg should have an equivalent`).toBeTruthy();
      expect(e.count * e.mass).toBeCloseTo(kg, 6);
    }
  });

  it('never picks an object the volume cannot reach at least once', () => {
    // The failure this blocks: "you moved 0.4 of an elephant".
    for (let kg = 20; kg <= 200000; kg = Math.round(kg * 1.17) + 1) {
      const e = massEquivalent(kg);
      expect(e.count, `${kg} kg picked ${e.key} at ${e.count}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('never produces an absurdly large multiplier', () => {
    // The other failure: "372 dumbbells". The rungs are spaced so that
    // clearing one but not the next keeps the count inside one gap; the
    // widest gap in the ladder is what bounds this.
    const widest = MASS_OBJECTS.reduce((m, o, i) => (
      i === 0 ? m : Math.max(m, o.mass / MASS_OBJECTS[i - 1].mass)
    ), 1);
    for (let kg = 20; kg <= 149999; kg = Math.round(kg * 1.13) + 1) {
      const e = massEquivalent(kg);
      expect(e.count, `${kg} kg picked ${e.key} at ${e.count}`).toBeLessThan(widest);
    }
    expect(widest).toBeLessThan(7);
  });

  it('says nothing rather than something silly below the lightest object', () => {
    for (const kg of [0, 1, 12, 19.9]) expect(massEquivalent(kg)).toBeNull();
  });

  it('refuses junk instead of rendering NaN into the sentence', () => {
    for (const bad of [null, undefined, NaN, Infinity, -500, 'heavy', {}]) {
      expect(massEquivalent(bad)).toBeNull();
    }
  });

  it('pluralises on the number actually shown, not the raw count', () => {
    // 1.96 renders as "2.0", and "2.0 x a hatchback car" is wrong English.
    const near2 = massEquivalent(1200 * 1.96);
    expect(near2.countLabel).toBe('2.0');
    expect(near2.label).toBe('hatchback cars');

    const justOne = massEquivalent(1200 * 1.2);
    expect(justOne.countLabel).toBe('1.2');
    expect(justOne.label).toBe('a hatchback car');
  });

  it('drops the decimal once it stops carrying information', () => {
    expect(massEquivalent(20 * 3.14).countLabel).toBe('3.1');
    /* Only the TOP rung can produce a count of 10 or more, because every
       gap below it is under 7x -- so the whole-number branch is reachable
       only past ~1.2 million kg, which no session will ever be. It is
       tested anyway: it is the branch that keeps a nonsense input from
       rendering "14.23847 locomotives" if the ladder is ever extended. */
    expect(massEquivalent(120000 * 14.2).countLabel).toBe('14');
    expect(massEquivalent(120000 * 9.9).countLabel).toBe('9.9');
  });

  it('the ladder itself stays ascending and honest', () => {
    // A rung inserted out of order would silently break the "heaviest
    // object it clears" scan, which walks the array in order.
    for (let i = 1; i < MASS_OBJECTS.length; i += 1) {
      expect(MASS_OBJECTS[i].mass).toBeGreaterThan(MASS_OBJECTS[i - 1].mass);
    }
    for (const o of MASS_OBJECTS) {
      expect(o.one).toMatch(/^(a|an) /);   // reads as "1.4 x a city bus"
      expect(o.many).not.toMatch(/^(a|an) /);
      expect(o.Icon).toBeTruthy();
    }
  });

  it('is unit-agnostic — the ratio is the same for a pound-reading member', () => {
    // The comparison is computed from canonical kg while the headline is
    // rendered in the member's unit. If that ever drifts, a lb member is
    // told they moved 2.2x as many cars as a kg member for the same work.
    const e = massEquivalent(3408);
    expect(e.key).toBe('car');
    expect(e.countLabel).toBe('2.8');
    const lb = 3408 * 2.20462;
    expect(lb / (e.count * e.mass * 2.20462)).toBeCloseTo(1, 9);
  });
});
