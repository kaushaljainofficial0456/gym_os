// Shared subprocess runner for tests that need a specific CALORIE_MODEL_PROVIDER.
//
// Config.js resolves the provider ONCE at startup (single source of truth), so
// a test cannot flip the provider by mutating process.env after import. These
// helpers run a snippet in an isolated child process where the env var is set
// BEFORE any module import — the same boundary production uses. Mirrors the
// subprocess convention in dbPolicy.test.js.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

// Absolute file URLs/snippets can import directly (like dbPolicy.test.js does).
// Paths are normalized to forward slashes so they survive embedding inside
// subprocess snippet string literals on Windows (backslashes would be eaten
// as escape sequences).
export const MODULES = {
  config: `file://${path.join(BACKEND_ROOT, 'src', 'config.js').replace(/\\/g, '/')}`,
  calorieModel: `file://${path.join(BACKEND_ROOT, 'src', 'services', 'intelligence', 'calorieModel.js').replace(/\\/g, '/')}`,
  mlMonitoring: `file://${path.join(BACKEND_ROOT, 'src', 'services', 'intelligence', 'mlMonitoringDashboard.js').replace(/\\/g, '/')}`,
  workouts: `file://${path.join(BACKEND_ROOT, 'src', 'routes', 'workouts.js').replace(/\\/g, '/')}`,
  schema: path.join(BACKEND_ROOT, '..', 'database', 'schema.sql').replace(/\\/g, '/')
};

// Runs `snippet` (ESM, --input-type=module) in a subprocess with a clean env.
// `provider` is injected as CALORIE_MODEL_PROVIDER before any import.
export function runWithProvider({ nodeEnv = 'development', provider, snippet, extraEnv = {} }) {
  const env = { PATH: process.env.PATH, NODE_ENV: nodeEnv, ...extraEnv };
  if (provider !== undefined) env.CALORIE_MODEL_PROVIDER = provider;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', snippet], {
    env, encoding: 'utf8', timeout: 15000, cwd: BACKEND_ROOT
  });
  return { status: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}
