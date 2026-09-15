// A disposable local GymOS stack for testing the Android app on an emulator:
// the API on a throwaway SQLite database, rebuilt and reseeded with the repo's
// demo fixtures on every start, plus the production web build served by
// `vite preview` (the same pairing frontend's Playwright suite uses).
//
//   cd frontend && npm run build        # once, or after web changes
//   node mobile/scripts/local-stack.mjs
//   cd mobile && GYMOS_SERVER_URL=http://10.0.2.2:4311 npm run apk:debug
//
// The emulator reaches this machine's loopback as 10.0.2.2; only debug builds
// allow that cleartext origin. Never point a release build here.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_PORT = Number(process.env.GYMOS_LOCAL_API_PORT || 4310);
const WEB_PORT = Number(process.env.GYMOS_LOCAL_WEB_PORT || 4311);
const EMULATOR_ORIGIN = `http://10.0.2.2:${WEB_PORT}`;

const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  // Resolved from the repo root; init-db --force only ever deletes this file.
  SQLITE_PATH: 'backend/data/android-local.db',
  JWT_SECRET: 'android-local-stack-only-secret',
  CORS_ORIGINS: `${EMULATOR_ORIGIN},http://127.0.0.1:${WEB_PORT}`,
  FRONTEND_URL: EMULATOR_ORIGIN,
};
// A leaked production connection string must never reach init-db --force.
delete apiEnv.DATABASE_URL;

for (const args of [['backend/scripts/init-db.js', '--force'], ['backend/scripts/seed.js']]) {
  const run = spawnSync(process.execPath, args, { cwd: repo, env: apiEnv, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

const children = [
  spawn(process.execPath, ['backend/src/index.js'], { cwd: repo, env: apiEnv, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: join(repo, 'frontend'),
    env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    stdio: 'inherit',
  }),
];

const stop = (code = 0) => {
  for (const child of children) child.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
