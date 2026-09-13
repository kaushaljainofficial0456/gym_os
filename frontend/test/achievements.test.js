/**
 * The rule this file exists to hold: an achievement must be computed from
 * data the app genuinely has. Nothing is awarded for opening a screen and
 * nothing is awarded on a promise — so the tests are mostly about what
 * happens when the data ISN'T there, which is the state every new account
 * is in and the easiest one to get wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAchievements, achievementSummary, ACHIEVEMENT_FAMILIES, ACHIEVEMENT_GROUPS,
} from '../src/achievements.js';

const empty = {};

describe('the catalogue itself', () => {
  it('is the size it claims to be', () => {
    const all = buildAchievements(empty);
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(all.length).toBeLessThanOrEqual(150);
  });

  it('gives every achievement a unique key', () => {
    // Duplicate keys would collide as React children and silently drop one.
    const keys = buildAchievements(empty).map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('files every achievement under a group the UI renders', () => {
    // An achievement in a group with no tab is unreachable.
    for (const a of buildAchievements(empty)) {
      expect(ACHIEVEMENT_GROUPS).toContain(a.group);
    }
  });

  it('orders every family\'s tiers so the ladder climbs', () => {
    for (const fam of ACHIEVEMENT_FAMILIES) {
      const sorted = [...fam.tiers].sort((a, b) => a - b);
      expect(fam.tiers, `${fam.id} tiers must ascend`).toEqual(sorted);
      expect(new Set(fam.tiers).size, `${fam.id} has a repeated tier`).toBe(fam.tiers.length);
    }
  });
});

describe('a brand-new account', () => {
  it('earns nothing, and does not crash trying', () => {
    // Every `value` reads deep into a payload that is entirely absent here.
    const all = buildAchievements(empty);
    expect(all.every((a) => !a.earned)).toBe(true);
    expect(all.every((a) => a.progress === 0)).toBe(true);
  });

  it('survives a payload full of nulls', () => {
    const hostile = {
      training: null, prs: undefined, consistency: { activeDays: null },
      weight: { analysis: { change: 'not a number' } }, nutrition: { days: 'nope' },
    };
    expect(() => buildAchievements(hostile)).not.toThrow();
    expect(achievementSummary(buildAchievements(hostile)).earned).toBe(0);
  });
});

describe('earning', () => {
  const intel = {
    training: {
      sessions: Array.from({ length: 12 }, () => ({ volume: 1000, sets: 10, duration_min: 65 })),
      qualifyingDays: Array.from({ length: 12 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
      byMuscle: [{ muscle: 'chest', sets: 10 }, { muscle: 'back', sets: 8 }, { muscle: 'legs', sets: 6 }],
    },
    prs: { total: 6, recentCount: 2, byExercise: [{}, {}, {}, {}, {}] },
    consistency: {
      activeDays: Array.from({ length: 40 }, (_, i) => `2026-0${(i % 3) + 1}-${String((i % 28) + 1).padStart(2, '0')}`),
      nutritionDays: Array.from({ length: 9 }, (_, i) => `2026-01-${i + 1}`),
      bothDays: ['2026-01-01', '2026-01-02'],
      streak: { best: 8 },
    },
    weight: { analysis: { change: -6.2 }, series: Array.from({ length: 15 }, () => ({})) },
    measurements: { waist: [{}, {}, {}], chest: [{}] },
    nutrition: { targets: { protein: 150, calories: 2000 }, days: [{ protein: 150, calories: 2000 }, { protein: 40, calories: 900 }] },
  };

  it('awards the tiers actually reached and no more', () => {
    const all = buildAchievements(intel);
    const sessions = all.filter((a) => a.familyId === 'sessions');
    // 12 sessions clears 1, 5 and 10 — and not 25.
    expect(sessions.filter((a) => a.earned).map((a) => a.tier)).toEqual([1, 5, 10]);
  });

  it('counts a loss as a loss and not as a gain', () => {
    // Down 6.2 kg: the "weight down" ladder moves, the "weight up" one
    // does not. A gain is a different thing, not a smaller loss.
    const all = buildAchievements(intel);
    expect(all.filter((a) => a.familyId === 'weight-lost' && a.earned).length).toBeGreaterThan(0);
    expect(all.filter((a) => a.familyId === 'weight-gained' && a.earned).length).toBe(0);
  });

  it('only counts a measurement site that is actually being tracked', () => {
    // Waist has three readings; chest has one, which is a note, not a trend.
    const measured = buildAchievements(intel).find((a) => a.familyId === 'measured' && a.tier === 1);
    expect(measured.value).toBe(1);
  });

  it('reports how far off an unearned tier is', () => {
    const next = buildAchievements(intel).find((a) => a.familyId === 'sessions' && a.tier === 25);
    expect(next.earned).toBe(false);
    expect(next.remaining).toBe(13);
    expect(next.progress).toBeCloseTo(12 / 25, 5);
  });

  it('summarises honestly', () => {
    const all = buildAchievements(intel);
    const { earned, total } = achievementSummary(all);
    expect(total).toBe(all.length);
    expect(earned).toBe(all.filter((a) => a.earned).length);
    expect(earned).toBeGreaterThan(0);
    expect(earned).toBeLessThan(total);
  });

  it('needs a target before it can say a target was hit', () => {
    // Without a nutrition plan there is nothing to be within 10% of, and
    // guessing one would award a badge for a number nobody set.
    const noTargets = { ...intel, nutrition: { targets: null, days: intel.nutrition.days } };
    const all = buildAchievements(noTargets);
    expect(all.filter((a) => a.familyId === 'protein-days' && a.earned).length).toBe(0);
    expect(all.filter((a) => a.familyId === 'calorie-days' && a.earned).length).toBe(0);
  });
});

describe('units', () => {
  it('describes weight milestones in the reader\'s unit', () => {
    const imperial = buildAchievements(empty, (kg) => `${Math.round(kg / 0.45359237)} lb`);
    const lost = imperial.find((a) => a.familyId === 'weight-lost' && a.tier === 10);
    expect(lost.description).toContain('lb');
    expect(lost.description).not.toContain('kg');
  });

  it('falls back to kilograms rather than printing "undefined"', () => {
    const plain = buildAchievements(empty);
    const lost = plain.find((a) => a.familyId === 'weight-lost' && a.tier === 10);
    expect(lost.description).toContain('kg');
  });
});
