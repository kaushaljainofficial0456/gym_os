import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests: end-to-end journeys, accessibility scans and visual
 * regression, all against the PRODUCTION build (`vite preview`, which also
 * sends the production CSP -- see vite.config.js) talking to a real backend
 * on a throwaway SQLite database that is rebuilt and reseeded on every run.
 *
 *   npm run test:e2e        journeys + accessibility + responsive
 *   npm run test:visual     screenshot comparison (see e2e/visual.spec.js)
 *
 * Uses the installed Chrome (`channel: 'chrome'`) rather than Playwright's
 * downloaded Chromium, so no browser download is needed locally or on a
 * GitHub runner, which ships Chrome.
 */
const API_PORT = Number(process.env.E2E_API_PORT || 4310);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4311);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  // The suite shares one seeded database and several specs write to it
  // (logging food, a workout), so one worker keeps runs deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  // Screenshots differ by OS font rendering, so baselines are kept per
  // platform rather than pretending one image fits Windows and Linux.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]] : [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    channel: process.env.E2E_CHANNEL || 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'desktop',
      testIgnore: /visual\.spec\.js/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL || 'chrome', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'visual-desktop',
      testMatch: /visual\.spec\.js/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL || 'chrome', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'visual-mobile',
      testMatch: /visual\.spec\.js/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], channel: process.env.E2E_CHANNEL || 'chrome' },
    },
  ],
  webServer: [
    {
      // Rebuild the throwaway database from scratch, then serve the API.
      // SQLITE_PATH is resolved from the repo root, and --force only ever
      // deletes the file at that path -- never the dev database.
      command: 'node backend/scripts/init-db.js --force && node backend/scripts/seed.js && node backend/src/index.js',
      cwd: '..',
      port: API_PORT,
      timeout: 180_000,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        SQLITE_PATH: 'backend/data/e2e.db',
        PORT: String(API_PORT),
        NODE_ENV: 'development',
        JWT_SECRET: 'e2e-only-secret-not-used-anywhere-else',
        CORS_ORIGINS: WEB_ORIGIN,
      },
    },
    {
      command: `${process.env.E2E_SKIP_BUILD ? '' : 'npm run build && '}npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      timeout: 180_000,
      reuseExistingServer: !CI,
      stdout: 'ignore',
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
