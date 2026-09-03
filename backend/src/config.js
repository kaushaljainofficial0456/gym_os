// Loads .env via Node's built-in loader (no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* .env is optional — defaults below apply */
}

// Vercel sets NODE_ENV=production for EVERY built deployment, Preview
// ones included -- so NODE_ENV alone cannot tell a real production
// deployment apart from a preview. VERCEL_ENV can: it is 'production'
// only for the production deployment and 'preview' for every preview
// build, so where it exists it is the authoritative signal and NODE_ENV
// is not consulted at all.
//
// A Vercel Preview maps onto this codebase's 'staging' tier, which is
// exactly the intended posture: the DATABASE_URL requirement and the
// NOBYPASSRLS-role check below both cover staging and stay fully active,
// while the production-only live-payment gate above does not fire -- a
// preview must never need real Razorpay credentials merely to boot for
// validation.
//
// This also closes a live footgun. Preview deployments were previously
// surviving that payment gate only because a gitignored local .env
// carrying NODE_ENV=development leaked into the CLI-uploaded bundle and
// was picked up by process.loadEnvFile() above. That was silently
// downgrading previews to 'development', which ALSO switched off the
// DATABASE_URL and BYPASSRLS-role guards -- a preview could have run
// against a misconfigured database with RLS disabled and nothing would
// have caught it. Reading VERCEL_ENV first makes that leak unable to
// influence the tier in either direction.
const vercelEnv = (process.env.VERCEL_ENV || '').toLowerCase();
const nodeEnv = vercelEnv === 'production' ? 'production'
  : vercelEnv === 'preview' ? 'staging'
  : (process.env.NODE_ENV || 'development');

// ---- calorie model provider: validated backend configuration ----
// Centralized here so routes/services never re-implement provider string
// logic. Supported: baseline | mock | ml. An invalid value must never
// silently select an unintended provider — staging/production fail fast at
// startup (below); development falls back to the documented safe default.
export const CALORIE_PROVIDERS = Object.freeze(['baseline', 'mock', 'ml']);
export const DEFAULT_CALORIE_PROVIDER = 'baseline';

// Normalize + validate a raw provider value (trimmed, lowercased).
//   { ok: true, value }                  valid provider
//   { ok: false, reason: 'missing' }     absent or empty
//   { ok: false, reason: 'invalid', raw } supplied but unsupported
export function parseCalorieProvider(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { ok: false, reason: 'missing' };
  if (CALORIE_PROVIDERS.includes(value)) return { ok: true, value };
  return { ok: false, reason: 'invalid', raw };
}

const providerParsed = parseCalorieProvider(process.env.CALORIE_MODEL_PROVIDER);
// Staging/production: an invalid provider is a configuration error — fail
// clearly instead of silently running an unintended provider. Missing is
// allowed (the safe baseline default applies).
if ((nodeEnv === 'staging' || nodeEnv === 'production') && providerParsed.reason === 'invalid') {
  console.error(`[sk-os] FATAL: CALORIE_MODEL_PROVIDER must be one of: baseline, mock, ml (got '${providerParsed.raw}').`);
  process.exit(1);
}
// Development: never crash — fall back to the documented safe default, but
// make the fallback visible instead of silent.
if (nodeEnv === 'development' && providerParsed.reason === 'invalid') {
  console.warn(`[sk-os] WARN: CALORIE_MODEL_PROVIDER '${providerParsed.raw}' is invalid — using '${DEFAULT_CALORIE_PROVIDER}'.`);
}

// Production safety: refuse to boot with a default/known-weak JWT secret.
const jwtSecret = process.env.JWT_SECRET || '';
if (nodeEnv === 'production') {
  if (!jwtSecret || jwtSecret.length < 16 || jwtSecret === 'dev-secret-change-me') {
    console.error('[sk-os] FATAL: JWT_SECRET must be set to a strong secret (16+ chars) in production.');
    process.exit(1);
  }
}

// Production payment safety: a production boot must never silently run on
// the mock payment provider (see services/payments/paymentProvider.js).
// Unlike the AI zero-cost gate this mirrors, an unconfigured payment
// provider isn't a merely-inconvenient default -- providerName() falling
// back to 'mock' in production means the app is deployed and answering
// real traffic while every "payment" is really an in-process fake that
// never moves money and can be triggered by anyone with an account (see
// routes/paymentsDev.js's POST /mock/complete, also hard-disabled in
// production separately in index.js -- this is the belt to that
// suspenders: even if that route were ever re-enabled by mistake,
// providerName() itself must never be able to report 'mock' here). "Boots
// fine, quietly does the safe thing" -- this codebase's usual posture for
// a missing zero-cost-gated config -- is the WRONG failure mode when the
// safe thing is silently pretending to take payment. Fail loud at boot
// instead, the same way a missing JWT_SECRET or DATABASE_URL already
// does above. Requires the exact same "go live" condition
// providerName() itself checks (PAYMENT_PROVIDER=razorpay + both API
// keys) PLUS RAZORPAY_WEBHOOK_SECRET, which providerName() does NOT
// check but verifyWebhookSignature's own fail-closed guard absolutely
// requires -- without it, a production boot would pass providerName()'s
// own check (report 'razorpay', create real orders) while being
// permanently unable to activate anything, because no webhook could ever
// verify. Better to catch that missing var here, at boot, than have a
// paying customer's subscription silently never activate.
//
// Scoped to production only (not staging, unlike the DATABASE_URL/JWT
// checks above) -- deliberately narrower: nothing in this codebase's
// existing docs or tests establishes that every staging deployment
// already has real Razorpay credentials, and requiring them there
// without being asked risks breaking a legitimate staging workflow this
// change has no visibility into. Revisit if staging is ever meant to
// take real payments too.
if (nodeEnv === 'production') {
  const paymentProviderEnv = (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
  const missingPayment = [];
  if (paymentProviderEnv !== 'razorpay') missingPayment.push('PAYMENT_PROVIDER=razorpay');
  if (!process.env.RAZORPAY_KEY_ID) missingPayment.push('RAZORPAY_KEY_ID');
  if (!process.env.RAZORPAY_KEY_SECRET) missingPayment.push('RAZORPAY_KEY_SECRET');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) missingPayment.push('RAZORPAY_WEBHOOK_SECRET');
  if (missingPayment.length) {
    console.error(`[sk-os] FATAL: production requires a fully configured live payment provider — missing: ${missingPayment.join(', ')}. The mock payment provider must never run in production.`);
    process.exit(1);
  }
}

// Database policy: PostgreSQL/Neon is the ONLY database for staging and
// production. SQLite exists for local development/tests only — the app must
// never silently fall back to SQLite outside development (fail fast instead).
const dbRequired = nodeEnv === 'staging' || nodeEnv === 'production';
if (dbRequired && !process.env.DATABASE_URL) {
  console.error(`[sk-os] FATAL: DATABASE_URL is required in ${nodeEnv} — PostgreSQL/Neon is the only allowed database here (SQLite is for local development only).`);
  process.exit(1);
}
// The runtime connection must use the dedicated NOBYPASSRLS application role.
// Neon's admin role (neondb_owner) has BYPASSRLS — using it as DATABASE_URL
// would silently disable Row-Level Security.
if (dbRequired && process.env.DATABASE_URL) {
  let dbUser = '';
  try { dbUser = decodeURIComponent(new URL(process.env.DATABASE_URL).username || '').toLowerCase(); } catch { /* malformed URL — pg surfaces it at connect */ }
  if (dbUser === 'neondb_owner') {
    console.error("[sk-os] FATAL: DATABASE_URL uses the admin role 'neondb_owner' (BYPASSRLS — RLS would be disabled). Use the runtime role 'skos_app' (NOBYPASSRLS).");
    process.exit(1);
  }
}

// CORS fails CLOSED without CORS_ORIGINS (falls back to the localhost dev
// list), not open — so this isn't a security gap the way a missing
// JWT_SECRET or DATABASE_URL would be. But it's a silent one: a production
// deploy that forgets to set it boots fine and then every request from the
// real frontend origin is invisibly blocked by the browser, which looks
// like "the API is down" with no server-side clue why. Same visibility
// treatment as the checks above, just a warning instead of exit(1).
if (dbRequired && !process.env.CORS_ORIGINS) {
  console.warn(`[sk-os] WARN: CORS_ORIGINS is not set in ${nodeEnv} — falling back to localhost origins only. Requests from the real frontend origin will be blocked until this is set.`);
}

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: jwtSecret || 'dev-secret-change-me',  // dev fallback only — never used in production
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl: process.env.DATABASE_URL || null,   // runtime PG connection (required in staging/production); unset => dev SQLite
  nodeEnv,
  // Calorie model provider — validated above; missing/empty => safe baseline default.
  calorieModelProvider: providerParsed.ok ? providerParsed.value : DEFAULT_CALORIE_PROVIDER,
  sqlitePath: process.env.SQLITE_PATH || 'backend/data/physique.db',
  // Live barcode lookup fallback (used only when a scanned code isn't in the
  // static local snapshot or the DB cache — see barcodeLookup.js). Defaults
  // to Open Food Facts' public v3 API (v2 still works and is accepted by
  // fetchFromExternalApi's response parsing, but OFF's own docs now steer
  // new integrations to v3 — notably a real HTTP 404 on a miss instead of
  // v2's always-200-with-a-status-flag, which maps far more cleanly onto
  // this app's own status-code contract). Free, no key required, and the
  // same data provenance as the pre-baked off_barcode_index.json snapshot
  // this app already ships. FOOD_DATABASE_API_KEY is only for a differently
  // configured provider that requires one — Open Food Facts does not.
  foodDatabaseApiUrl: process.env.FOOD_DATABASE_API_URL || 'https://world.openfoodfacts.org/api/v3/product',
  foodDatabaseApiKey: process.env.FOOD_DATABASE_API_KEY || null,
  // CORS: explicit allow-list. Empty in dev = localhost origins only.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // F-10: base URL the frontend is actually served from, used ONLY to
  // build the verify-email/reset-password LINKS embedded in outgoing
  // emails (e.g. `${frontendUrl}/reset-password?token=...`) -- the API
  // itself never redirects here or trusts this for anything security-
  // relevant. Falls back to the same localhost dev origin api.js/vite
  // already assume elsewhere in this codebase.
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')
};
