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

// Production payment safety. The hazard this guards against is the MOCK
// payment provider answering real production traffic: it mints its own
// valid-looking signatures in-process, so POST /api/payments/mock/complete
// (routes/paymentsDev.js) would let anyone with an account forge a payment
// and flip a subscription to ACTIVE without money moving. That must never
// be reachable in production.
//
// The fix for that is NOT "refuse to boot without Razorpay credentials".
// Payments are one optional feature; the rest of the app -- workouts,
// nutrition, clients, tracking -- has no dependency on them, and an
// operator who has not signed up with a gateway yet should still be able
// to run the product. Refusing to boot turns a disabled feature into a
// total outage.
//
// So there are three states, enforced together with providerName():
//   razorpay  PAYMENT_PROVIDER=razorpay + both API keys  -> live payments
//   none      production, no provider requested          -> payments DISABLED
//   mock      development/staging only                   -> unchanged
//
// 'none' is what makes booting safe: providerName() returns 'none' rather
// than falling back to 'mock', every provider operation throws
// PaymentsNotConfiguredError (surfaced as a controlled 503), and both
// signature verifiers fail closed. Nothing can be created, activated,
// refunded or forged while payments are off.
//
// The one case that still refuses to boot is a HALF-configured Razorpay:
// PAYMENT_PROVIDER=razorpay set but a key or the webhook secret missing.
// That state is genuinely dangerous rather than merely disabled -- it can
// create real gateway orders it is then permanently unable to verify or
// activate, so a paying customer's subscription would silently never
// activate. Fail loud there, exactly as a missing JWT_SECRET does.
//
// Scoped to production only (not staging, unlike the DATABASE_URL/JWT
// checks above) -- deliberately narrower: nothing in this codebase's
// existing docs or tests establishes that every staging deployment
// already has real Razorpay credentials, and requiring them there
// without being asked risks breaking a legitimate staging workflow this
// change has no visibility into. Revisit if staging is ever meant to
// take real payments too.
if (nodeEnv === 'production') {
  const paymentProviderEnv = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
  const razorpayRequested = paymentProviderEnv === 'razorpay';
  const missingPayment = [];
  if (!process.env.RAZORPAY_KEY_ID) missingPayment.push('RAZORPAY_KEY_ID');
  if (!process.env.RAZORPAY_KEY_SECRET) missingPayment.push('RAZORPAY_KEY_SECRET');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) missingPayment.push('RAZORPAY_WEBHOOK_SECRET');

  if (razorpayRequested && missingPayment.length) {
    // Razorpay was explicitly ASKED FOR but is only half-configured. This
    // is the genuinely dangerous state and still refuses to boot: a
    // deployment that reports 'razorpay' while missing a key would create
    // real orders it can never verify or activate (see paymentProvider.js
    // -- providerName() ignores PAYMENT_PROVIDER without both API keys,
    // and verifyWebhookSignature fails closed without the webhook secret),
    // so a paying customer's subscription would silently never activate.
    console.error(`[sk-os] FATAL: PAYMENT_PROVIDER=razorpay is set but the integration is incomplete — missing: ${missingPayment.join(', ')}. Set the missing variables, or unset PAYMENT_PROVIDER to run with payments disabled.`);
    process.exit(1);
  }

  if (!razorpayRequested) {
    // No payment provider configured at all. This is a SUPPORTED state,
    // not an error: the rest of the application has no dependency on
    // payments, so refusing to boot here would take down an entire
    // deployment over a feature the operator has not enabled yet.
    //
    // Critically this does NOT fall back to the mock provider -- that was
    // the original hazard this gate existed to prevent, since the mock
    // gateway mints its own valid-looking signatures and would let anyone
    // with an account forge a payment. paymentProvider.js's providerName()
    // returns 'none' in production instead: every provider operation
    // throws PaymentsNotConfiguredError (a controlled 503) and both
    // signature verifiers fail closed, so no payment can be created,
    // activated, refunded or forged while unconfigured.
    //
    // Setting PAYMENT_PROVIDER=razorpay + the three Razorpay variables
    // switches the existing, untouched integration on with no code change.
    console.warn('[sk-os] WARN: no payment provider configured — payments are DISABLED in this production deployment. Payment endpoints return 503 payments_not_configured. Set PAYMENT_PROVIDER=razorpay plus RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to enable Razorpay.');
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
