#!/usr/bin/env node
// ============================================================
// FOOD AI PROVIDER SMOKE TEST — optional, real API calls.
//
// NEVER run by `npm test` / the normal suite (it lives under scripts/, not
// test/, and isn't named *.test.js, so node --test's file discovery never
// picks it up regardless). Run it explicitly:
//   node scripts/food-ai-smoke.js
//
// Makes AT MOST ONE small real call per CONFIGURED provider (Groq, Gemini,
// OpenRouter, Ollama) -- calling each directly via callProviderRaw, NOT
// through the failover chain, because the point here is "does provider X
// itself actually work", which the chain's mock tests already cover
// separately. Same food-v1 prompt/reference-gathering production calls
// use, same fixed test food ("chicken biryani, 1 serving") for every
// provider so the results are comparable.
//
// A provider with no key configured is reported SKIPPED -- never a false
// pass and never silently omitted. Never prints an API key or any header
// value. Never imports a database connection or writes anywhere -- this
// script CANNOT touch the production DB even by accident, because nothing
// in its import graph can reach one.
// ============================================================
// Imported FIRST and only for its .env-loading side effect (process.
// loadEnvFile()) -- aiProvider.js reads ALLOW_PAID_AI at ITS OWN import
// time, so backend/.env must be loaded before that import happens. This
// is the same pattern scripts/init-db.js already uses.
import '../src/config.js';
import { isProviderConfigured, callProviderRaw, parseJSON } from '../src/services/intelligence/aiProvider.js';
import { SYSTEM_PROMPT, buildUserMessage, gatherMeasuredReferences, validateAIFoodResponse } from '../src/services/intelligence/foodAI.js';

const PROVIDERS = ['groq', 'gemini', 'openrouter', 'ollama'];
const TEST_QUERY = 'chicken biryani, 1 serving';
const TIMEOUT_MS = Number(process.env.FOOD_AI_SMOKE_TIMEOUT_MS) || 20_000;

function modelFor(provider) {
  if (provider === 'groq') return process.env.GROQ_MODEL || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
  if (provider === 'gemini') return process.env.GEMINI_MODEL || process.env.LLM_MODEL || 'gemini-1.5-flash';
  if (provider === 'openrouter') return process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || 'openrouter/free';
  if (provider === 'ollama') return process.env.OLLAMA_MODEL || 'llama3.2';
  return 'unknown';
}

async function testProvider(provider) {
  const row = { provider, model: modelFor(provider) };
  if (!isProviderConfigured(provider)) {
    row.status = 'SKIPPED';
    row.detail = provider === 'ollama'
      ? 'not reachable / not configured' // ollama has no "key" -- isProviderConfigured is always true for it, so this branch is effectively unreachable for ollama and left only for symmetry
      : 'API key not configured';
    return row;
  }

  const references = gatherMeasuredReferences(TEST_QUERY);
  const userMessage = buildUserMessage({ query: TEST_QUERY }, references);

  const t0 = Date.now();
  try {
    const { content: raw, model: actualModel } = await callProviderRaw(provider, SYSTEM_PROMPT, userMessage, { json: true, timeoutMs: TIMEOUT_MS });
    row.latencyMs = Date.now() - t0;
    // Overwrite the pre-call guess above with the model this call actually
    // used (vendor-echoed where the API confirms one) -- more accurate
    // than modelFor()'s own hardcoded fallback chain, which can drift from
    // the real env-var-driven resolution in aiProvider.js over time.
    if (actualModel) row.model = actualModel;
    const parsed = parseJSON(raw);
    row.validResponse = !!parsed;
    if (!parsed) {
      row.status = 'FAIL';
      row.detail = 'response was not valid JSON';
      return row;
    }
    const validated = validateAIFoodResponse(parsed);
    row.schemaValid = validated.ok;
    if (!validated.ok) {
      row.status = 'FAIL';
      row.detail = `schema validation failed: ${validated.reason}`;
      return row;
    }
    row.status = 'SUCCESS';
    row.estimate = {
      food_name: validated.value.food_name,
      calories: validated.value.totals?.calories,
      protein_g: validated.value.totals?.protein_g,
      carbs_g: validated.value.totals?.carbs_g,
      fat_g: validated.value.totals?.fat_g,
      confidence: validated.value.confidence,
    };
    return row;
  } catch (e) {
    row.latencyMs = Date.now() - t0;
    row.status = 'FAIL';
    // e.message may echo back response text (see callXWithKey's own
    // `res.status: text.slice(0,200)` error shape) -- providers do not
    // echo back the request's own Authorization header in an error body,
    // so this is safe to print, but never print `apiKey`/`row` fields
    // themselves anywhere in this script.
    row.detail = String(e.message || e).slice(0, 300);
    return row;
  }
}

async function main() {
  console.log('='.repeat(72));
  console.log('FOOD AI PROVIDER SMOKE TEST -- real API calls, one per configured provider');
  console.log(`Test food: "${TEST_QUERY}"`);
  console.log('Never persists to any database. Never prints API keys.');
  console.log('='.repeat(72));
  console.log();

  const results = [];
  for (const provider of PROVIDERS) {
    process.stdout.write(`Testing ${provider}... `);
    const row = await testProvider(provider);
    results.push(row);
    console.log(row.status);
  }

  console.log();
  console.log('-'.repeat(72));
  for (const r of results) {
    console.log(`PROVIDER:       ${r.provider}`);
    console.log(`MODEL:          ${r.model}`);
    console.log(`STATUS:         ${r.status}${r.detail ? ` -- ${r.detail}` : ''}`);
    if (r.latencyMs != null) console.log(`LATENCY:        ${r.latencyMs}ms`);
    if (r.validResponse != null) console.log(`VALID-RESPONSE: ${r.validResponse}`);
    if (r.schemaValid != null) console.log(`SCHEMA-VALID:   ${r.schemaValid}`);
    if (r.estimate) {
      const e = r.estimate;
      console.log(`ESTIMATE:       ${e.food_name} -- ${e.calories} kcal, P${e.protein_g} C${e.carbs_g} F${e.fat_g} (confidence: ${e.confidence})`);
    }
    console.log('-'.repeat(72));
  }

  const succeeded = results.filter((r) => r.status === 'SUCCESS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIPPED');
  console.log();
  console.log(`${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped (not configured)`);
  if (failed.length) {
    console.log('\nExiting non-zero: at least one CONFIGURED provider failed.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Smoke test crashed:', e.message || e);
  process.exitCode = 1;
});
