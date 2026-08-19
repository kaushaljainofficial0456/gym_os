// ============================================================
// AI PROVIDER ABSTRACTION — /intelligence/aiProvider.js
//   Methods: interpret() · visionLabel() · estimateMeal() · coach()
//            · brief() · weekly() · ping()
//   Implementations: ollama (local — default for dev),
//                    openai (chat-completions compatible),
//                    gemini (REST), mock (deterministic fallback).
// Deterministic intelligence (parsing, search, calculation,
// permissions) NEVER goes through here — only ambiguous NL,
// vision, contextual coaching and recommendation framing.
// If no provider is configured/available, callers fall back to
// deterministic engines — SK OS keeps working, never crashes.
//
// ZERO-COST SAFETY POLICY:
// Paid providers (openai, gemini) are DISABLED by default.
// Setting AI_PROVIDER=openai/gemini WITHOUT ALLOW_PAID_AI=true
// has NO EFFECT — the provider silently falls back to 'mock'.
// This prevents accidental API billing from env var misconfig.
// ============================================================

const PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
const KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || '';

// --- ZERO-COST GATE ---
// Paid providers require BOTH the provider selection AND an explicit
// safety flag. Without ALLOW_PAID_AI=true, paid providers are blocked.
const ALLOW_PAID_AI = process.env.ALLOW_PAID_AI === 'true';
const PAID_BLOCKED = !ALLOW_PAID_AI && PROVIDER !== 'ollama' && PROVIDER !== 'mock';
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

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
async function callOllama(system, user, { json = true, imageDataUrl = null } = {}) {
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
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
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
  const modelId = model || process.env.LLM_MODEL || 'gemini-1.5-flash';
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

async function callAI(system, user, opts = {}) {
  if (PROVIDER === 'ollama') return callOllama(system, user, opts);
  if (PAID_BLOCKED) throw new Error(`Zero-cost policy: paid provider '${PROVIDER}' is disabled. Set ALLOW_PAID_AI=true to enable.`);
  if (!KEY) throw new Error('AI provider not configured');
  if (PROVIDER === 'gemini') return callGemini(system, user, opts);
  return callOpenAI(system, user, opts);
}

function parseJSON(text) {
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

export default { providerName, isConfigured, configSummary, ping, interpret, visionLabel, estimateMeal, coach };
