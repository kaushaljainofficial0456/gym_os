// ============================================================
// AI PROVIDER ABSTRACTION — /intelligence/aiProvider.js
//   Methods: interpret() · visionLabel() · estimateMeal() · coach()
//            · brief() · weekly() · ping()
//   Implementations: ollama (local — default for dev),
//                    openai (chat-completions compatible),
//                    gemini (REST), groq (OpenAI-compatible, fast/cheap
//                    inference), openrouter (OpenAI-compatible proxy over
//                    many models), mock (deterministic fallback).
// Deterministic intelligence (parsing, search, calculation,
// permissions) NEVER goes through here — only ambiguous NL,
// vision, contextual coaching and recommendation framing.
// If no provider is configured/available, callers fall back to
// deterministic engines — SK OS keeps working, never crashes.
//
// ZERO-COST SAFETY POLICY:
// Paid providers (openai, gemini, groq) are DISABLED by default.
// Setting AI_PROVIDER=openai/gemini/groq WITHOUT ALLOW_PAID_AI=true
// has NO EFFECT — the provider silently falls back to 'mock'.
// This prevents accidental API billing from env var misconfig.
// Groq is included here even though it has a free tier: it is still a
// third-party API requiring a key and subject to its own rate limits/
// terms, so it gets the same explicit opt-in as any other paid vendor
// rather than a silent exception carved out for it.
//
// GENERIC DISPATCH (callProviderRaw) — added for callers that need to
// pick a DIFFERENT provider than the app-wide AI_PROVIDER/AI_MODEL pair
// (e.g. the food-AI Tier 4 estimator, which has its own
// FOOD_AI_PROVIDER/FOOD_AI_FALLBACK_PROVIDER config and a two-provider
// try/fallback chain). It reuses the exact same per-vendor HTTP calls and
// the exact same zero-cost gate — nothing about vendor wiring or safety
// is duplicated, only which provider name and API key get used.
// ============================================================

const PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
const KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || '';

// --- ZERO-COST GATE ---
// Paid providers require BOTH the provider selection AND an explicit
// safety flag. Without ALLOW_PAID_AI=true, paid providers are blocked.
const ALLOW_PAID_AI = process.env.ALLOW_PAID_AI === 'true';
const FREE_PROVIDERS = new Set(['ollama', 'mock']);
const PAID_BLOCKED = !ALLOW_PAID_AI && !FREE_PROVIDERS.has(PROVIDER);
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

// Per-provider API key lookup, for callers (like foodAI.js) selecting a
// provider independently of the app-wide AI_PROVIDER value above.
function keyFor(provider) {
  if (provider === 'openai') return process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || '';
  if (provider === 'groq') return process.env.GROQ_API_KEY || '';
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
  return '';
}

export function providerName() {
  if (PROVIDER === 'ollama') return 'ollama';
  if (PAID_BLOCKED) return 'mock'; // paid provider blocked by zero-cost policy
  if (KEY) return PROVIDER;
  return 'mock';
}

export function isConfigured() {
  if (PROVIDER === 'ollama') return true; // base URL + model are config; availability is checked at call time
  if (PAID_BLOCKED) return false; // paid provider blocked by zero-cost policy
  return !!KEY;
}

// Same shape as isConfigured(), for a provider name a caller supplies
// itself rather than the module-wide AI_PROVIDER. 'ollama'/'mock' are
// always allowed (zero-cost); anything else needs ALLOW_PAID_AI=true AND
// its own API key.
export function isProviderConfigured(provider) {
  const p = String(provider || '').toLowerCase();
  if (!p) return false;
  if (FREE_PROVIDERS.has(p)) return true;
  if (!ALLOW_PAID_AI) return false;
  return !!keyFor(p);
}

export function configSummary() {
  return {
    provider: providerName(),
    ollamaBase: PROVIDER === 'ollama' ? OLLAMA_BASE : null,
    ollamaModel: PROVIDER === 'ollama' ? OLLAMA_MODEL : null,
    hasKey: !!KEY
  };
}

// ------------------------------------------------------------------
// OLLAMA — local LLM. POST /api/chat (OpenAI-compatible shape).
// Ollama's /api/chat returns { message: { role, content } }.
// ------------------------------------------------------------------
async function callOllama(system, user, { json = true, imageDataUrl = null, signal } = {}) {
  const payload = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    stream: false,
    options: { temperature: 0.2 }
  };
  if (imageDataUrl) {
    // Ollama vision models accept base64 in "images"
    const m = String(imageDataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (m) payload.images = [m[2]];
  }
  // `signal` was silently dropped here before -- callProviderRaw's
  // AbortController-based timeout (used by foodAI.js) had NO EFFECT on the
  // ollama path specifically, because this function never read it out of
  // its options object. A hung local Ollama call would have blocked
  // forever instead of timing out. Found by a test that mocked a fetch
  // that only resolves on abort and never actually aborted.
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.message?.content || '';
  // Ollama's JSON mode isn't strict — strip fenced code if present
  const cleaned = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return json ? cleaned : content;
}

// Health check — is Ollama up and does the model exist?
let pingCache = { at: 0, ok: false };
export async function ping() {
  if (PROVIDER !== 'ollama') return { available: false, reason: 'provider-not-ollama' };
  const now = Date.now();
  if (now - pingCache.at < 8000) return pingCache;
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { method: 'GET' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name || '');
    const modelKnown = models.length === 0 || models.some((m) => m.includes(OLLAMA_MODEL.split(':')[0]));
    const out = { available: true, model: OLLAMA_MODEL, modelKnown, models: models.slice(0, 20) };
    pingCache = { at: now, ...out };
    return out;
  } catch (e) {
    const out = { available: false, reason: String(e.message || e), model: OLLAMA_MODEL };
    pingCache = { at: now, ok: false, ...out };
    return out;
  }
}

async function callOpenAI(system, user, { json = true, model } = {}) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: model || process.env.LLM_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(system, user, { json = true, model } = {}) {
  const modelId = model || process.env.LLM_MODEL || 'gemini-3.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
        ...(json ? { generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } } : {})
      })
    });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGroq(system, user, { json = true, model } = {}) {
  // Groq's API is OpenAI-compatible (same chat-completions shape, same
  // response_format.type: 'json_object' JSON mode) at a different host and
  // model namespace, hence a near-duplicate of callOpenAI rather than a
  // shared helper — the two vendors could diverge independently and this
  // keeps that divergence local instead of forcing a shared abstraction
  // over two things that only coincidentally match today.
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: model || process.env.GROQ_MODEL || process.env.LLM_MODEL || 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callOpenRouter(system, user, { json = true, model } = {}) {
  // OpenRouter is ALSO OpenAI-compatible chat-completions, at yet another
  // host/model namespace -- same near-duplicate-on-purpose reasoning as
  // Groq above. Two OpenRouter-specific optional headers (HTTP-Referer,
  // X-Title) identify the calling app for OpenRouter's own analytics/
  // leaderboard; requests work without them, they are not auth.
  // response_format JSON mode is best-effort here: unlike Groq/OpenAI,
  // OpenRouter proxies many underlying models and not all of them honour
  // response_format -- parseJSON()'s fenced-code/prose-stripping fallback
  // (already required for Ollama's looser JSON mode) is the real safety
  // net for this provider, not a guarantee from the API shape.
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://skos.app',
      'X-Title': 'SK OS'
    },
    body: JSON.stringify({
      model: model || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || 'openrouter/free',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ------------------------------------------------------------------
// callProviderRaw — dispatch to an EXPLICITLY NAMED provider, independent
// of the module-wide AI_PROVIDER selection above. For callers (foodAI.js)
// that configure their own provider + fallback chain rather than using
// whichever provider the rest of the app is set to. Applies the same
// zero-cost gate (isProviderConfigured) and adds a request timeout, which
// none of the fixed-PROVIDER call* functions above have -- every caller
// through THIS path gets a bounded-latency guarantee, load-bearing for
// "AI is a fallback, never a hard dependency" (a hung fetch must not hang
// the food-logging request indefinitely).
// ------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 12_000;

// Returns { content, model } -- `model` is the real model identifier this
// call actually used (see the call*WithKey functions' own comment). Ollama
// has no per-call model override (callOllama always uses the fixed
// OLLAMA_MODEL constant, ignoring opts.model) and its response body isn't
// parsed here for an echoed model field, so OLLAMA_MODEL itself is reported
// -- genuinely accurate, not a guess, since it's the exact value every
// ollama request actually sends.
export async function callProviderRaw(provider, system, user, opts = {}) {
  const p = String(provider || '').toLowerCase();
  if (!isProviderConfigured(p)) {
    throw new Error(FREE_PROVIDERS.has(p) || p === 'ollama'
      ? `Provider '${p}' is not available`
      : `Zero-cost policy: paid provider '${p}' is disabled. Set ALLOW_PAID_AI=true to enable.`);
  }
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOpts = { ...opts, signal: controller.signal };
  try {
    if (p === 'ollama') {
      const content = await callOllama(system, user, fetchOpts);
      return { content, model: OLLAMA_MODEL };
    }
    if (p === 'mock') throw new Error('mock provider has no raw call — callers should special-case it');
    const key = keyFor(p);
    if (p === 'groq') return await callGroqWithKey(system, user, { ...fetchOpts, apiKey: key });
    if (p === 'gemini') return await callGeminiWithKey(system, user, { ...fetchOpts, apiKey: key });
    if (p === 'openrouter') return await callOpenRouterWithKey(system, user, { ...fetchOpts, apiKey: key });
    if (p === 'openai') return await callOpenAIWithKey(system, user, { ...fetchOpts, apiKey: key });
    // Unknown provider name: fail loudly rather than silently dispatching
    // to OpenAI's endpoint with a key that isn't an OpenAI key. This WAS a
    // bug before openrouter existed as a name -- any unrecognised provider
    // fell through here and got dispatched to callOpenAIWithKey regardless.
    throw new Error(`Unknown provider '${p}'`);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${p} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Key-parameterised siblings of callOpenAI/callGemini/callGroq, used only
// by callProviderRaw above (which may need a DIFFERENT key/provider than
// the module-wide PROVIDER/KEY this file otherwise runs on). Kept as thin
// wrappers rather than rewriting the originals so every existing caller of
// interpret()/coach()/etc. is byte-for-byte unaffected.
//
// Each returns { content, model } rather than a bare string -- `model` is
// the REAL model identifier this call actually used: the vendor's own
// echoed value from its response body when it provides one (OpenAI/Groq/
// OpenRouter all echo `model`; Gemini echoes `modelVersion`), falling back
// to the resolved request-side model id (model param -> provider-specific
// env var -> LLM_MODEL -> hardcoded default) when the response doesn't
// confirm one. Never a guess disconnected from what was actually sent or
// returned -- see foodAI.js's use of this for why (AI provenance recorded
// against a real food estimate must never be fabricated).
async function callOpenAIWithKey(system, user, { json = true, model, apiKey, signal } = {}) {
  const modelId = model || process.env.LLM_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content || '', model: data.model || modelId };
}

async function callGeminiWithKey(system, user, { json = true, model, apiKey, signal } = {}) {
  // GEMINI_MODEL was documented in .env.example (and set in some
  // deployments' env) but never actually read here -- only the
  // module-wide, non-provider-specific LLM_MODEL was. A caller through
  // callProviderRaw (food-AI Tier 4, which explicitly names its own
  // provider+model independent of the app-wide AI_PROVIDER) is exactly
  // the case this env var exists for.
  const modelId = model || process.env.GEMINI_MODEL || process.env.LLM_MODEL || 'gemini-3.5-flash-lite';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
        ...(json ? { generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } } : {})
      })
    });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.candidates?.[0]?.content?.parts?.[0]?.text || '', model: data.modelVersion || modelId };
}

async function callGroqWithKey(system, user, { json = true, model, apiKey, signal } = {}) {
  const modelId = model || process.env.GROQ_MODEL || process.env.LLM_MODEL || 'openai/gpt-oss-120b';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content || '', model: data.model || modelId };
}

async function callOpenRouterWithKey(system, user, { json = true, model, apiKey, signal } = {}) {
  const modelId = model || process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || 'openrouter/free';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://skos.app',
      'X-Title': 'SK OS'
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content || '', model: data.model || modelId };
}

async function callAI(system, user, opts = {}) {
  if (PROVIDER === 'ollama') return callOllama(system, user, opts);
  if (PROVIDER === 'groq') {
    if (PAID_BLOCKED) throw new Error(`Zero-cost policy: paid provider '${PROVIDER}' is disabled. Set ALLOW_PAID_AI=true to enable.`);
    if (!KEY) throw new Error('AI provider not configured');
    return callGroq(system, user, opts);
  }
  if (PAID_BLOCKED) throw new Error(`Zero-cost policy: paid provider '${PROVIDER}' is disabled. Set ALLOW_PAID_AI=true to enable.`);
  if (!KEY) throw new Error('AI provider not configured');
  if (PROVIDER === 'gemini') return callGemini(system, user, opts);
  return callOpenAI(system, user, opts);
}

// Exported: foodAI.js (and any future caller parsing model output) reuses
// this rather than re-implementing "strip fenced code, extract the first
// {...} blob" -- LLMs wrap JSON in prose/markdown often enough that every
// caller needs this, and a second implementation could silently diverge in
// what it accepts.
export function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ------------------------------------------------------------------
// interpret — ambiguous natural language → structured intent.
// Deterministic routing (food/workout parse, search, etc.) runs FIRST
// in the route; this is only the fallback for inputs that need it.
// ------------------------------------------------------------------
export async function interpret(text, clientContext = {}) {
  if (!isConfigured()) {
    return {
      ok: false, requiresKey: true,
      error: 'I need a bit more context to understand that. Try "220g paneer", "Bench press 60x8", or "Show dumbbell chest exercises".'
    };
  }
  const system = `You are the intent router for SK OS, a fitness app. Convert the user's message into ONE structured JSON action. Never invent numbers. Available actions:
{"intent":"LOG_FOOD","food":"...","quantity":number,"unit":"g|ml|pc|serving|scoop|cup|bowl"}
{"intent":"LOG_WORKOUT","exercise":"...","sets":[{"weight":number,"reps":number}]}
{"intent":"SEARCH_EXERCISES","query":"..."}
{"intent":"GENERATE_WORKOUT","goal":"...","days":number,"equipment":"...","minutes":number}
{"intent":"ASK_CONTEXT","topic":"protein|train_today|last_workout|weight|progress|calories|general"}
{"intent":"UNKNOWN","reason":"..."}
Use ASK_CONTEXT for questions about the user's own data. If a food or exercise name is uncertain, still provide your best guess but mark "uncertain":true. Return ONLY the JSON object.`;
  try {
    const raw = await callAI(system, `Client context: ${JSON.stringify(clientContext)}\nUser: "${text}"`);
    const out = parseJSON(raw);
    return out ? { ok: true, ...out } : { ok: false, error: 'Could not interpret that request.' };
  } catch (e) {
    return { ok: false, requiresKey: true, error: `AI provider unavailable (${e.message}). Try a structured phrase like "220g paneer" or "Bench press 60x8".` };
  }
}

// ------------------------------------------------------------------
// visionLabel — nutrition-label photo → structured fields.
// Never fabricates missing values; confidence reflects OCR quality.
// ------------------------------------------------------------------
export async function visionLabel(imageDataUrl) {
  if (PROVIDER !== 'ollama' && !isConfigured()) {
    return { ok: false, requiresKey: true, note: 'No OCR provider configured — enter the values manually (provenance: LABEL SCANNED).' };
  }
  const system = `You extract nutrition facts from a photo of a packaged food label. Return ONLY JSON. Do NOT invent values. Allowed keys: brand, name, serving_size (number), unit, servings_per_container, calories, protein, carbs, fat, saturated_fat, fiber, sugar, sodium. Numbers are per serving. Add "confidence": "HIGH|MEDIUM|LOW" based on how legible the label is. Add "missing": ["list of standard fields not visible"].`;
  try {
    const raw = await callAI(system, `Nutrition label photo (data URL): ${imageDataUrl}`, { imageDataUrl });
    const out = parseJSON(raw);
    return out ? { ok: true, ...out } : { ok: false, error: 'Could not read the label. Please enter values manually.' };
  } catch (e) {
    return { ok: false, requiresKey: true, error: `OCR unavailable (${e.message}). Enter the values manually.` };
  }
}

// ------------------------------------------------------------------
// estimateMeal — photo of ACTUAL FOOD. Always ESTIMATED with a range.
// Never claims exact calories from a photo.
// ------------------------------------------------------------------
export async function estimateMeal(imageDataUrl) {
  if (PROVIDER !== 'ollama' && !isConfigured()) {
    return {
      ok: true, estimated: true, requiresKey: true,
      note: 'Meal-photo estimation needs an AI vision provider. Estimated values are ranges, never exact.',
      items: [], range: { calories: [null, null] }, confidence: 'LOW'
    };
  }
  const system = `You estimate a meal from a photo. This is ESTIMATION ONLY — never present as exact. Return ONLY JSON: {"items":[{"food":"rice","portion_g":[150,200],"calories":[173,231]}],"range":{"calories":[450,550]},"confidence":"HIGH|MEDIUM|LOW","note":"brief caveat"}. Use realistic per-100g values. Portion sizes are ranges. If you cannot identify the food, say so in "note" and use wide ranges.`;
  try {
    const raw = await callAI(system, `Meal photo (data URL): ${imageDataUrl}`, { imageDataUrl });
    const out = parseJSON(raw);
    if (!out) return { ok: true, estimated: true, note: 'Could not estimate from this photo.', items: [], range: { calories: [null, null] }, confidence: 'LOW' };
    return { ok: true, estimated: true, ...out };
  } catch (e) {
    return { ok: true, estimated: true, requiresKey: true, note: `Vision provider unavailable (${e.message}).`, items: [], range: { calories: [null, null] }, confidence: 'LOW' };
  }
}

// ------------------------------------------------------------------
// coach — conversational coaching. Returns text or null (fallback to
// deterministic engines). Never crashes SK OS.
// ------------------------------------------------------------------
export async function coach(userMessage, contextSummary) {
  if (!isConfigured()) return null;
  const system = `You are SK Coach for SK OS, a data-driven fitness coaching assistant. Be short, specific and actionable. Use ONLY the provided context — if a fact is absent, say "I don't have enough information". Distinguish MEASURED / CALCULATED / ESTIMATED / RECOMMENDATION. Never diagnose disease, never prescribe medical treatment, never promise results. This is fitness guidance, not medical advice.`;
  try {
    const raw = await callAI(system, `Context: ${JSON.stringify(contextSummary)}\nClient: ${userMessage}`, { json: false });
    return String(raw || '').trim().slice(0, 2000);
  } catch {
    return null;
  }
}

export default {
  providerName, isConfigured, isProviderConfigured, configSummary, ping,
  interpret, visionLabel, estimateMeal, coach, callProviderRaw, parseJSON
};
