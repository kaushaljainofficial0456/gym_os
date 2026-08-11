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

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: jwtSecret || 'dev-secret-change-me',  // dev fallback only — never used in production
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl: process.env.DATABASE_URL || null,   // set => PostgreSQL, unset => dev SQLite
  nodeEnv,
  sqlitePath: process.env.SQLITE_PATH || 'backend/data/physique.db',
  // CORS: explicit allow-list. Empty in dev = localhost origins only.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((s) => s.trim()).filter(Boolean)
};
