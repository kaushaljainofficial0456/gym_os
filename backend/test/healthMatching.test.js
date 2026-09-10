// ============================================================
// Unit tests for the WorkoutMatchingEngine (backend/src/services/health/matching.js).
// Pure functions, no DB -- these assert the deterministic scoring
// formula and coverage math the spec's own TEST 1-15 depend on.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreMatch, findBestMatch, computeCoverage, timeOverlap,
  activitySimilarity, durationSimilarity, MATCH_WEIGHTS, MATCH_THRESHOLD, FULL_COVERAGE_THRESHOLD,
} from '../src/services/health/matching.js';

test('MATCH_WEIGHTS sum to 1 (spec §16: configurable, not magic numbers)', () => {
  const sum = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum}, expected 1`);
});

test('activitySimilarity: exact match = 1, either unknown = 0.5, mismatch = 0', () => {
  assert.equal(activitySimilarity('running', 'running'), 1);
  assert.equal(activitySimilarity('running', 'other'), 0.5);
  assert.equal(activitySimilarity(null, 'running'), 0.5);
  assert.equal(activitySimilarity('running', 'strength_training'), 0);
});

test('durationSimilarity: identical durations = 1, half-length = 0.5', () => {
  assert.equal(durationSimilarity('2026-01-01T18:00:00Z', '2026-01-01T19:00:00Z', '2026-01-01T18:00:00Z', '2026-01-01T19:00:00Z'), 1);
  const half = durationSimilarity('2026-01-01T18:00:00Z', '2026-01-01T19:00:00Z', '2026-01-01T18:00:00Z', '2026-01-01T18:30:00Z');
  assert.ok(Math.abs(half - 0.5) < 1e-9);
});

test('timeOverlap: full containment (wearable 18:08-18:52 inside SK OS 18:00-19:00)', () => {
  const o = timeOverlap('2026-01-01T18:00:00Z', '2026-01-01T19:00:00Z', '2026-01-01T18:08:00Z', '2026-01-01T18:52:00Z');
  assert.equal(o.intersectionMs, 44 * 60 * 1000);
  // overlapRatio is relative to A (the SK OS session) -- 44/60 minutes, NOT 100%
  assert.ok(Math.abs(o.overlapRatio - 44 / 60) < 1e-9);
});

test('timeOverlap: no overlap at all', () => {
  const o = timeOverlap('2026-01-01T18:00:00Z', '2026-01-01T19:00:00Z', '2026-01-01T20:00:00Z', '2026-01-01T21:00:00Z');
  assert.equal(o.intersectionMs, 0);
  assert.equal(o.overlapRatio, 0);
});

test('scoreMatch: near-identical session (spec TEST 2 shape) scores high and clears threshold', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training' };
  const wearable = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training', heart_rate_avg: 130 };
  const r = scoreMatch(skos, wearable);
  assert.ok(r.score >= MATCH_THRESHOLD, `score ${r.score} should clear threshold`);
  assert.ok(r.score > 0.9, `near-perfect match should score very high, got ${r.score}`);
});

test('scoreMatch: unrelated events (different day) never match', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training' };
  const unrelated = { start_time: '2026-01-02T07:00:00Z', end_time: '2026-01-02T07:30:00Z', activity_type: 'running' };
  const r = scoreMatch(skos, unrelated);
  assert.ok(r.score < MATCH_THRESHOLD);
});

test('findBestMatch: returns null when nothing clears the threshold (spec §17: never force a weak match)', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z', activity_type: 'strength_training' };
  const candidates = [{ start_time: '2026-01-01T09:00:00Z', end_time: '2026-01-01T09:20:00Z', activity_type: 'walking' }];
  assert.equal(findBestMatch(skos, candidates), null);
});

test('computeCoverage: TEST 3 shape -- partial overlap leaves a real uncovered gap, not rounded to full', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z' };
  const wearable = { start_time: '2026-01-01T18:08:00Z', end_time: '2026-01-01T18:52:00Z' };
  const c = computeCoverage(skos, [wearable]);
  assert.ok(Math.abs(c.coveredSeconds - 44 * 60) < 1);
  assert.ok(Math.abs(c.uncoveredSeconds - 16 * 60) < 1);
  assert.ok(c.coverageRatio < FULL_COVERAGE_THRESHOLD);
  assert.equal(c.uncoveredIntervals.length, 2); // gap before 18:08 AND after 18:52
});

test('computeCoverage: two overlapping wearable intervals merge, not double-count (spec §60 partitioning)', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z' };
  const a = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T18:40:00Z' };
  const b = { start_time: '2026-01-01T18:30:00Z', end_time: '2026-01-01T19:00:00Z' }; // overlaps `a` by 10 min
  const c = computeCoverage(skos, [a, b]);
  // Union of [18:00-18:40] and [18:30-19:00] is the FULL hour, not 70 minutes.
  assert.ok(Math.abs(c.coveredSeconds - 60 * 60) < 1);
  assert.equal(c.uncoveredIntervals.length, 0);
});

test('computeCoverage: full 55-min coverage of a 60-min session clears FULL_COVERAGE_THRESHOLD', () => {
  const skos = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T19:00:00Z' };
  const wearable = { start_time: '2026-01-01T18:00:00Z', end_time: '2026-01-01T18:55:00Z' };
  const c = computeCoverage(skos, [wearable]);
  assert.ok(c.coverageRatio >= FULL_COVERAGE_THRESHOLD, `coverage ${c.coverageRatio} should clear ${FULL_COVERAGE_THRESHOLD}`);
});
