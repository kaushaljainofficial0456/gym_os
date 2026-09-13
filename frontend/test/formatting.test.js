/**
 * The first frontend tests in this repo.
 *
 * Everything here is a pure function that produced a REAL user-visible
 * bug at some point, which is the only reason each one is worth a test:
 * the app's own build and the backend suite both passed while these were
 * wrong, because neither can see what a string renders as.
 *
 *   formatLoad      shipped "60 kg kg" on every row whose weight already
 *                   carried a unit -- the column is free text and holds
 *                   both "60 kg" and "60".
 *   prettyName      the exercise library stores slugs; a screen showing
 *                   "front_squat" to a coach is showing them the database.
 *   prescriptionLine a bodyweight movement must not render an empty load,
 *                   and "0 kg" is a claim ("lift nothing"), not an absence.
 */
import { describe, it, expect } from 'vitest';
import { formatLoad } from '../src/utils.js';
import { prettyName } from '../src/components/trainer/ExercisePicker.jsx';
import { formatRest, prescriptionLine } from '../src/components/trainer/ExerciseCard.jsx';

describe('formatLoad', () => {
  it('adds the unit to a bare number', () => {
    expect(formatLoad('60')).toBe('60 kg');
    expect(formatLoad('22.5')).toBe('22.5 kg');
    expect(formatLoad(60)).toBe('60 kg');
  });

  it('leaves a value that already states its unit alone', () => {
    // The bug: appending unconditionally produced "60 kg kg".
    expect(formatLoad('60 kg')).toBe('60 kg');
    expect(formatLoad('2x20kg')).toBe('2x20kg');
  });

  it('spells out bodyweight rather than showing the abbreviation', () => {
    expect(formatLoad('BW')).toBe('Bodyweight');
    expect(formatLoad('bw')).toBe('Bodyweight');
    expect(formatLoad('bodyweight')).toBe('Bodyweight');
  });

  it('passes through anything else a coach actually typed', () => {
    expect(formatLoad('red band')).toBe('red band');
  });

  it('reports absence as absence, never as a number', () => {
    expect(formatLoad('')).toBeNull();
    expect(formatLoad('   ')).toBeNull();
    expect(formatLoad(null)).toBeNull();
    expect(formatLoad(undefined)).toBeNull();
  });
});

describe('prettyName', () => {
  it('turns a slug into words', () => {
    expect(prettyName('front_squat')).toBe('Front Squat');
    expect(prettyName('incline-dumbbell-press')).toBe('Incline Dumbbell Press');
  });

  it('does not mangle a name that is already human', () => {
    expect(prettyName('Bench Press')).toBe('Bench Press');
  });

  it('is safe on empty input', () => {
    expect(prettyName('')).toBe('');
    expect(prettyName(null)).toBe('');
    expect(prettyName(undefined)).toBe('');
  });
});

describe('formatRest', () => {
  it('reads rest the way a coach says it, not the way the column stores it', () => {
    expect(formatRest(30)).toBe('30s');
    expect(formatRest(60)).toBe('1:00');
    expect(formatRest(90)).toBe('1:30');
    expect(formatRest(120)).toBe('2:00');
    expect(formatRest(150)).toBe('2:30');
  });

  it('treats no rest as nothing to say', () => {
    expect(formatRest(0)).toBeNull();
    expect(formatRest(null)).toBeNull();
    expect(formatRest(undefined)).toBeNull();
  });
});

describe('prescriptionLine', () => {
  it('reads as one sentence', () => {
    expect(prescriptionLine({ sets: 4, reps: '8', weight: '60', rest_sec: 90 }))
      .toBe('4 × 8 · 60 kg · 1:30 rest');
  });

  it('does not double the unit when the stored value has one', () => {
    expect(prescriptionLine({ sets: 3, reps: '10', weight: '22.5 kg', rest_sec: 60 }))
      .toBe('3 × 10 · 22.5 kg · 1:00 rest');
  });

  it('says Bodyweight instead of showing an empty load', () => {
    expect(prescriptionLine({ sets: 3, reps: '15', weight: 'BW', rest_sec: 60 }))
      .toBe('3 × 15 · Bodyweight · 1:00 rest');
  });

  it('omits the parts that do not exist rather than inventing zeroes', () => {
    // No weight at all is an absence. "0 kg" would be a prescription.
    expect(prescriptionLine({ sets: 3, reps: '12' })).toBe('3 × 12');
    expect(prescriptionLine({ sets: 3 })).toBe('3 sets');
    expect(prescriptionLine({})).toBe('');
  });
});
