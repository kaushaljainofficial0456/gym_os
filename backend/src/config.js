// Loads .env via Node's built-in loader (no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* .env is optional — defaults below apply */
}

const nodeEnv = process.env.NODE_ENV || 'development';

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
  // CORS: explicit allow-list. Empty in dev = localhost origins only.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean)
};
