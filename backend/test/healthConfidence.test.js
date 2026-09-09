// ============================================================
// Unit tests for the ConfidenceEngine (backend/src/services/health/confidence.js).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence, confidenceLevel, dataQualityState, CONFIDENCE_THRESHOLDS } from '../src/services/health/confidence.js';

test('confidenceLevel maps score to the right bucket at the thresholds', () => {
  assert.equal(confidenceLevel(0.95), 'high');
  assert.equal(confidenceLevel(CONFIDENCE_THRESHOLDS.high), 'high');
  assert.equal(confidenceLevel(CONFIDENCE_THRESHOLDS.high - 0.01), 'medium');
  assert.equal(confidenceLevel(CONFIDENCE_THRESHOLDS.low - 0.01), 'very_low');
});

test('a direct, fully-covered, good-quality wearable reading scores high', () => {
  const r = computeConfidence({ sourceType: 'wearable_direct', coverageRatio: 1, dataQuality: 'good' });
  assert.equal(r.level, 'high');
});

test('a pure MET-fallback estimate never scores high', () => {
  const r = computeConfidence({ sourceType: 'met_fallback', coverageRatio: 1, dataQuality: 'good' });
  assert.notEqual(r.level, 'high');
});

test('flagged data quality and a large disagreement compound to push confidence down, never to negative/over 1', () => {
  const r = computeConfidence({ sourceType: 'wearable_direct', coverageRatio: 1, dataQuality: 'flagged', disagreementRatio: 0.9 });
  assert.ok(r.score >= 0 && r.score <= 1);
  assert.notEqual(r.level, 'high');
});

test('confidence never displays a raw decimal to reasons -- reasons are human strings', () => {
  const r = computeConfidence({ sourceType: 'skos_ml', coverageRatio: 0.5 });
  assert.ok(r.reasons.every((s) => typeof s === 'string'));
});

test('dataQualityState buckets coverage ratio correctly, including the "no evidence at all" case', () => {
  assert.equal(dataQualityState(1), 'complete');
  assert.equal(dataQualityState(0.8), 'mostly_complete');
  assert.equal(dataQualityState(0.5), 'partial');
  assert.equal(dataQualityState(0.1), 'poor');
  assert.equal(dataQualityState(0), 'unknown', 'zero evidence is "unknown", never presented as a confident zero');
});
