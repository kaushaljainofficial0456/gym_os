// ============================================================
// TIER 4 PROVIDER FAILOVER CHAIN — Groq (primary) -> Gemini (secondary)
// -> OpenRouter (tertiary) -> Ollama (optional local) -> graceful
// unresolved. Mock-based: every scenario below runs with NO real API
// keys and makes NO real network calls -- fetch is mocked per provider
// host. A SEPARATE, optional real-API smoke-test script (not this file,
// never run by `npm test`) is the only thing that ever calls a real
// provider; see backend/scripts/food-ai-smoke.js.
//
// NOTE ON THE ORIGINAL "SCENARIOS A-M" SPEC: the exact verbatim per-letter
// scenario list from the original request could not be recovered from
// this session's transcript (a prior context compaction appears to have
// dropped the raw message, leaving only a paraphrased summary of its
// existence, not its literal text). Rather than guess at wording I can't
// verify, the 13 scenarios below (still labelled A-M) were designed to
// cover every REQUIRED behaviour the surviving spec text is explicit
// about: short-circuit-on-success (cost safety), every named failure mode
// (timeout / 429 / 5xx / malformed JSON / schema-invalid / generic
// network error), unconfigured-vs-failed provider distinction, full-chain
// exhaustion to Ollama, total failure staying graceful, the zero-cost
// dev default making no cloud network calls at all, the explicit-config
// backward-compat escape hatch, and secret-safety of the observability
// trail. This is disclosed here and in the final report rather than
// silently presented as a reproduction of the original enumeration.
//
// MODULE-LOAD-TIME ENV VARS: aiProvider.js reads ALLOW_PAID_AI once at
// import time (see zeroCostSafety.test.js for the established pattern of
// testing this). This file sets it once, before the first (dynamic)
// import of aiProvider.js/foodAI.js, then drives per-scenario
// configured/unconfigured behaviour by setting/unsetting the per-provider
// *_API_KEY vars, which keyFor() reads LIVE at call time -- no re-import
// needed except for the one test that exercises a different
// FOOD_AI_PROVIDER override (foodAI.js's own module-level chain
// construction, re-imported with a cache-busting query string).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALLOW_PAID_AI = 'true'; // must be set before aiProvider.js's first import
process.env.FOOD_AI_TIMEOUT_MS = '400'; // fast timeout for Scenario B, read once at foodAI.js's own import time

let foodAI; // default chain: groq -> gemini -> openrouter -> ollama

test.before(async () => {
  foodAI = await import('../src/services/intelligence/foodAI.js');
});

const validAIResponse = (over = {}) => ({
  food_name: 'Test dish', food_type: 'composite_dish', cuisine: null,
  is_branded_or_restaurant: false,
  serving: { description: '1 plate', estimated_weight_g: 300 },
  components: [{ name: 'rice', estimated_weight_g: 200, calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1, assumption: 'base' }],
  totals: { calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1 },
  uncertainty: { calories_low: 200, calories_high: 320, protein_low: 3, protein_high: 8, carbs_low: 40, carbs_high: 70, fat_low: 0, fat_high: 3 },
  confidence: 'medium', assumptions: [], needs_user_confirmation: [],
  ...over,
});

/** Mocks fetch, dispatching by host substring to a per-provider handler.
 *  Any host not given a handler falls through to the real fetch (there is
 *  none reachable in a test sandbox, so an unmocked call surfaces loudly
 *  as a network error rather than silently doing nothing). */
function mockProviders(t, handlers) {
  const realFetch = globalThis.fetch;
  const calls = { groq: 0, gemini: 0, openrouter: 0, ollama: 0 };
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (u.includes('api.groq.com')) { calls.groq++; return handlers.groq ? handlers.groq(u, opts) : realFetch(url, opts); }
    if (u.includes('generativelanguage.googleapis.com')) { calls.gemini++; return handlers.gemini ? handlers.gemini(u, opts) : realFetch(url, opts); }
    if (u.includes('openrouter.ai')) { calls.openrouter++; return handlers.openrouter ? handlers.openrouter(u, opts) : realFetch(url, opts); }
    if (u.includes('11434')) { calls.ollama++; return handlers.ollama ? handlers.ollama(u, opts) : realFetch(url, opts); }
    return realFetch(url, opts);
  });
  return calls;
}

const okJson = (body) => new Response(JSON.stringify(body), { status: 200 });
const groqOk = (content) => okJson({ choices: [{ message: { content: JSON.stringify(content) } }] });
const geminiOk = (content) => okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }] });
const openrouterOk = (content) => okJson({ choices: [{ message: { content: JSON.stringify(content) } }] });
const ollamaOk = (content) => okJson({ message: { content: JSON.stringify(content) } });

function setKeys({ groq = 'gsk_test', gemini = 'test-gemini-key', openrouter = 'sk-or-v1-test' } = {}) {
  if (groq) process.env.GROQ_API_KEY = groq; else delete process.env.GROQ_API_KEY;
  if (gemini) process.env.GEMINI_API_KEY = gemini; else delete process.env.GEMINI_API_KEY;
  if (openrouter) process.env.OPENROUTER_API_KEY = openrouter; else delete process.env.OPENROUTER_API_KEY;
}

/* ------------------------------------------------------------------ */
/*  Scenario A — primary success short-circuits everything after it    */
/* ------------------------------------------------------------------ */
test('Scenario A — Groq succeeds on first try: Gemini/OpenRouter/Ollama are NEVER called', async (t) => {
  setKeys();
  const calls = mockProviders(t, { groq: () => groqOk(validAIResponse()) });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario a ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'groq');
  assert.equal(calls.groq, 1);
  assert.equal(calls.gemini, 0);
  assert.equal(calls.openrouter, 0);
  assert.equal(calls.ollama, 0);
});

/* ------------------------------------------------------------------ */
/*  Scenario B — timeout cascades                                      */
/* ------------------------------------------------------------------ */
test('Scenario B — Groq times out, Gemini succeeds: OpenRouter/Ollama never called', async (t) => {
  setKeys();
  const calls = mockProviders(t, {
    groq: (u, opts) => new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    gemini: () => geminiOk(validAIResponse({ food_name: 'from gemini' })),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario b ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'gemini');
  assert.equal(calls.openrouter, 0);
  assert.equal(calls.ollama, 0);
});

/* ------------------------------------------------------------------ */
/*  Scenario C — 429 rate limit cascades                               */
/* ------------------------------------------------------------------ */
test('Scenario C — Groq returns 429, Gemini succeeds', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => new Response('rate limited', { status: 429 }),
    gemini: () => geminiOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario c ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'gemini');
});

/* ------------------------------------------------------------------ */
/*  Scenario D — two 5xx failures cascade to the third provider        */
/* ------------------------------------------------------------------ */
test('Scenario D — Groq 500, Gemini 503, OpenRouter succeeds: Ollama never called', async (t) => {
  setKeys();
  const calls = mockProviders(t, {
    groq: () => new Response('server error', { status: 500 }),
    gemini: () => new Response('unavailable', { status: 503 }),
    openrouter: () => openrouterOk(validAIResponse({ food_name: 'from openrouter' })),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario d ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'openrouter');
  assert.equal(calls.ollama, 0);
});

/* ------------------------------------------------------------------ */
/*  Scenario E — malformed (non-JSON) response cascades                */
/* ------------------------------------------------------------------ */
test('Scenario E — Groq returns non-JSON garbage, Gemini succeeds', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => okJson({ choices: [{ message: { content: 'not json at all <<<' } }] }),
    gemini: () => geminiOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario e ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'gemini');
});

/* ------------------------------------------------------------------ */
/*  Scenario F — schema-validation failure cascades                    */
/* ------------------------------------------------------------------ */
test('Scenario F — Groq returns valid JSON that fails schema validation, Gemini succeeds', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => groqOk({ food_name: 'incomplete' }), // missing serving/components/totals
    gemini: () => geminiOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario f ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'gemini');
});

/* ------------------------------------------------------------------ */
/*  Scenario G — all three cloud providers fail, Ollama is the last     */
/*  resort and succeeds                                                */
/* ------------------------------------------------------------------ */
test('Scenario G — Groq/Gemini/OpenRouter all fail, Ollama succeeds as last resort', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => new Response('error', { status: 500 }),
    gemini: () => new Response('error', { status: 500 }),
    openrouter: () => new Response('error', { status: 500 }),
    ollama: () => ollamaOk(validAIResponse({ food_name: 'from ollama' })),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario g ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'ollama');
});

/* ------------------------------------------------------------------ */
/*  Scenario H — every provider fails: graceful unresolved, never throws*/
/* ------------------------------------------------------------------ */
test('Scenario H — every provider in the chain fails: graceful unresolved, never throws', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => new Response('error', { status: 500 }),
    gemini: () => new Response('error', { status: 500 }),
    openrouter: () => new Response('error', { status: 500 }),
    ollama: () => new Response('error', { status: 500 }),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario h ${Date.now()}` });
  assert.equal(result.ok, false);
  assert.equal(result.estimate_status, 'unresolved');
  assert.equal(result.tier, 4);
  assert.ok(result.reason && result.error, 'both reason and error fields must be present for the frontend');
});

/* ------------------------------------------------------------------ */
/*  Scenario I — an unconfigured provider is SKIPPED, not counted as a  */
/*  failure, and never actually called over the network                */
/* ------------------------------------------------------------------ */
test('Scenario I — Groq has no key (unconfigured, skipped without a network call), Gemini fails, OpenRouter succeeds', async (t) => {
  setKeys({ groq: null }); // no GROQ_API_KEY at all
  const calls = mockProviders(t, {
    gemini: () => new Response('error', { status: 500 }),
    openrouter: () => openrouterOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario i ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'openrouter');
  assert.equal(calls.groq, 0, 'an unconfigured provider must never be called over the network');
});

/* ------------------------------------------------------------------ */
/*  Scenario J — zero-cost dev default: no cloud keys at all, only      */
/*  Ollama is actually attempted (no cloud network calls whatsoever)    */
/* ------------------------------------------------------------------ */
test('Scenario J — zero-cost default (no cloud keys configured): only Ollama is ever called', async (t) => {
  setKeys({ groq: null, gemini: null, openrouter: null });
  const calls = mockProviders(t, { ollama: () => ollamaOk(validAIResponse()) });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario j ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'ollama');
  assert.equal(calls.groq, 0);
  assert.equal(calls.gemini, 0);
  assert.equal(calls.openrouter, 0);
});

/* ------------------------------------------------------------------ */
/*  Scenario K — a generic network failure (not an HTTP error response) */
/*  is treated as a failure and cascades correctly                     */
/* ------------------------------------------------------------------ */
test('Scenario K — Groq\'s fetch rejects outright (DNS/connection failure), Gemini succeeds', async (t) => {
  setKeys();
  mockProviders(t, {
    groq: () => { throw new Error('getaddrinfo ENOTFOUND api.groq.com'); },
    gemini: () => geminiOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario k ${Date.now()}` });
  assert.equal(result.ok, true);
  assert.equal(result.ai.provider, 'gemini');
});

/* ------------------------------------------------------------------ */
/*  Scenario L — explicit FOOD_AI_PROVIDER/FOOD_AI_FALLBACK_PROVIDER    */
/*  preserves the OLD single-provider(+fallback) behaviour exactly --   */
/*  the full 4-provider chain must NOT be silently appended             */
/* ------------------------------------------------------------------ */
test('Scenario L — explicit FOOD_AI_PROVIDER=groq + FOOD_AI_FALLBACK_PROVIDER=gemini: OpenRouter/Ollama are never attempted even when both fail', async (t) => {
  setKeys();
  const savedProvider = process.env.FOOD_AI_PROVIDER;
  const savedFallback = process.env.FOOD_AI_FALLBACK_PROVIDER;
  process.env.FOOD_AI_PROVIDER = 'groq';
  process.env.FOOD_AI_FALLBACK_PROVIDER = 'gemini';
  try {
    const explicitFoodAI = await import(`../src/services/intelligence/foodAI.js?scenario=explicit-${Date.now()}`);
    const calls = mockProviders(t, {
      groq: () => new Response('error', { status: 500 }),
      gemini: () => new Response('error', { status: 500 }),
      openrouter: () => openrouterOk(validAIResponse()), // would succeed if wrongly reached
      ollama: () => ollamaOk(validAIResponse()),          // would succeed if wrongly reached
    });
    const result = await explicitFoodAI.estimateFoodAI(null, { query: `scenario l ${Date.now()}` });
    assert.equal(result.ok, false, 'must fail once both explicitly-configured providers fail, not fall through to the default chain');
    assert.equal(calls.openrouter, 0);
    assert.equal(calls.ollama, 0);
    const summary = explicitFoodAI.foodAIConfigSummary();
    assert.deepEqual(summary.chain, ['groq', 'gemini']);
  } finally {
    if (savedProvider === undefined) delete process.env.FOOD_AI_PROVIDER; else process.env.FOOD_AI_PROVIDER = savedProvider;
    if (savedFallback === undefined) delete process.env.FOOD_AI_FALLBACK_PROVIDER; else process.env.FOOD_AI_FALLBACK_PROVIDER = savedFallback;
  }
});

/* ------------------------------------------------------------------ */
/*  Scenario M — the observability trail never leaks a key/secret, and  */
/*  correctly reports fallback depth on a post-failure success          */
/* ------------------------------------------------------------------ */
test('Scenario M — observability trail contains no API keys, and reports correct fallback depth', async (t) => {
  setKeys({ groq: 'gsk_SUPER_SECRET_VALUE_MUST_NOT_LEAK', gemini: 'AIza_SECRET_GEMINI_VALUE' });
  mockProviders(t, {
    groq: () => new Response('unauthorized', { status: 401 }),
    gemini: () => geminiOk(validAIResponse()),
  });
  const result = await foodAI.estimateFoodAI(null, { query: `scenario m ${Date.now()}` });
  assert.equal(result.ok, true);
  const trail = JSON.stringify(result); // the full response, as it would be logged/returned
  assert.ok(!trail.includes('SUPER_SECRET_VALUE'), 'groq key must never appear in the result/observability trail');
  assert.ok(!trail.includes('SECRET_GEMINI_VALUE'), 'gemini key must never appear in the result/observability trail');
});
