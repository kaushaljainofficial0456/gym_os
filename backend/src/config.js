// Loads .env via Node's built-in loader (no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  /* .env is optional — defaults below apply */
}

const nodeEnv = process.env.NODE_ENV || 'development';

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

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: jwtSecret || 'dev-secret-change-me',  // dev fallback only — never used in production
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl: process.env.DATABASE_URL || null,   // runtime PG connection (required in staging/production); unset => dev SQLite
  nodeEnv,
  sqlitePath: process.env.SQLITE_PATH || 'backend/data/physique.db',
  // CORS: explicit allow-list. Empty in dev = localhost origins only.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean)
};
