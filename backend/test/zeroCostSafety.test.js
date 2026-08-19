// ============================================================
// ZERO-COST AI SAFETY TESTS
//
// Proves that paid AI providers (OpenAI, Gemini) CANNOT be called
// in the default configuration. Even with env vars set, paid
// providers are blocked unless ALLOW_PAID_AI=true.
//
// These tests run in a subprocess with controlled env to prove
// the safety gate works at the module level.
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ---- Helper: run a Node script with controlled env ----
// Scripts run from ROOT so relative imports resolve correctly.
async function runWithEnv(script, env = {}) {
  const fullEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    ...env
  };
  try {
    const { stdout, stderr } = await exec('node', ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: fullEnv,
      timeout: 15000
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (e) {
    return { stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || '', exitCode: e.code || 1 };
  }
}

// ============================================================
// TEST 1: Default config — no paid provider reachable
// ============================================================
describe('Zero-cost safety — default configuration', () => {
  it('providerName() returns "mock" when AI_PROVIDER=openai but no ALLOW_PAID_AI', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'fake-key-for-test' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'providerName must be mock when ALLOW_PAID_AI is not set');
    assert.equal(data.configured, false, 'isConfigured must be false when paid provider is blocked');
  });

  it('providerName() returns "mock" when AI_PROVIDER=gemini but no ALLOW_PAID_AI', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake-key-for-test' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock', 'providerName must be mock for gemini without ALLOW_PAID_AI');
    assert.equal(data.configured, false, 'isConfigured must be false when paid provider is blocked');
  });

  it('providerName() returns "ollama" when AI_PROVIDER=ollama (local, free)', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'ollama' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'ollama', 'ollama is local and free — always allowed');
    assert.equal(data.configured, true, 'ollama is always configured (availability checked at call time)');
  });

  it('providerName() returns "mock" when AI_PROVIDER=mock (deterministic)', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'mock' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'mock');
    assert.equal(data.configured, false);
  });

  it('providerName() returns "ollama" with NO env vars (local, free, safe)', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, {});
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'ollama', 'absolute default is ollama (local, free)');
    assert.equal(data.configured, true, 'ollama is always configured');
  });
});

// ============================================================
// TEST 2: callAI() throws for blocked paid providers
// ============================================================
describe('Zero-cost safety — callAI blocks paid providers', () => {
  it('interpret() returns graceful error when paid provider is blocked', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      const r = await m.interpret('eat 200g chicken');
      console.log(JSON.stringify(r));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake-key' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false, 'interpret must return ok:false for blocked provider');
    assert.ok(data.error, 'must include error message');
    assert.ok(!data.error.includes('sk-fake'), 'error must not leak the API key');
  });

  it('visionLabel() returns graceful error when paid provider is blocked', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      const r = await m.visionLabel('data:image/png;base64,fake');
      console.log(JSON.stringify(r));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake-key' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, false, 'visionLabel must return ok:false for blocked provider');
  });

  it('estimateMeal() returns graceful error when paid provider is blocked', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      const r = await m.estimateMeal('data:image/png;base64,fake');
      console.log(JSON.stringify(r));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake-key' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.ok, true, 'estimateMeal returns ok:true (graceful degradation)');
    assert.equal(data.confidence, 'LOW', 'confidence must be LOW');
    assert.ok(data.items.length === 0, 'must return empty items');
  });

  it('coach() returns null when paid provider is blocked', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      const r = await m.coach('how am i doing', {});
      console.log(JSON.stringify(r));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake-key' });
    const data = JSON.parse(r.stdout);
    assert.equal(data, null, 'coach must return null for blocked provider (fallback to deterministic)');
  });
});

// ============================================================
// TEST 3: ALLOW_PAID_AI=true actually enables the provider
// ============================================================
describe('Zero-cost safety — ALLOW_PAID_AI opt-in', () => {
  it('providerName() returns "openai" when ALLOW_PAID_AI=true + AI_PROVIDER=openai', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake-key', ALLOW_PAID_AI: 'true' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'openai', 'with explicit opt-in, openai is enabled');
    assert.equal(data.configured, true);
  });

  it('providerName() returns "gemini" when ALLOW_PAID_AI=true + AI_PROVIDER=gemini', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      console.log(JSON.stringify({ name: m.providerName(), configured: m.isConfigured() }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'fake-key', ALLOW_PAID_AI: 'true' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.name, 'gemini');
    assert.equal(data.configured, true);
  });
});

// ============================================================
// TEST 4: Core features work without any AI provider
// ============================================================
describe('Zero-cost safety — core features without AI', () => {
  it('food estimation works (100% local)', async () => {
    const script = `
      const m = await import('./backend/src/services/foodEstimator.js');
      const r = m.estimateFood('2 roti, dal and curd');
      console.log(JSON.stringify({ items: r.items.length, calories: r.total.calories }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'mock' });
    const data = JSON.parse(r.stdout);
    assert.ok(data.items >= 2, 'food estimation finds items');
    assert.ok(data.calories > 100, 'food estimation returns calories');
  });

  it('deterministic parsing works for multi-food input', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/parseFoods.js');
      const r = m.parseFoodInput('200g paneer + 150g rice + 2 roti');
      console.log(JSON.stringify({ items: r.items?.length || 0, parseable: !r.unparseable }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'mock' });
    const data = JSON.parse(r.stdout);
    assert.ok(data.items >= 2, 'deterministic parser handles multi-food input');
    assert.equal(data.parseable, true, 'input is parseable without AI');
  });

  it('deterministic parsing works', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/parseFoods.js');
      const r = m.parseFoodInput('200g paneer + 150g rice');
      console.log(JSON.stringify({ items: r.items?.length || 0 }));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'mock' });
    const data = JSON.parse(r.stdout);
    assert.ok(data.items >= 1, 'deterministic parser finds items');
  });
});

// ============================================================
// TEST 5: configSummary shows safety state
// ============================================================
describe('Zero-cost safety — configSummary', () => {
  it('configSummary includes zero-cost policy state', async () => {
    const script = `
      const m = await import('./backend/src/services/intelligence/aiProvider.js');
      const s = m.configSummary();
      console.log(JSON.stringify(s));
    `;
    const r = await runWithEnv(script, { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake' });
    const data = JSON.parse(r.stdout);
    assert.equal(data.provider, 'mock', 'provider shown as mock when blocked');
  });
});
