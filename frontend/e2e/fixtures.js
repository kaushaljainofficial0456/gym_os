import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

/** Seeded by backend/scripts/seed.js on every run (see playwright.config.js). */
export const PASSWORD = 'demo1234';
export const ACCOUNTS = {
  client: { email: 'client1@ironforge.in', card: 'Client', home: '/app/client' },
  owner: { email: 'owner@ironforge.in', card: 'Gym Owner', home: '/app/trainer' },
  trainer: { email: 'trainer1@ironforge.in', card: 'Trainer', home: '/app/trainer' },
  // Left un-onboarded on purpose: onboarding.spec.js is its first sign-in.
  newClient: { email: 'client2@ironforge.in', card: 'Client', home: '/app/client' },
};
/** Roles auth.setup.js signs in and saves a session for. */
export const SAVED_SESSIONS = ['client', 'owner', 'trainer'];

export const storageFor = (who) => fileURLToPath(new URL(`./.auth/${who}.json`, import.meta.url));

/**
 * Marks the first-run overlays (cookie banner, per-tab feature popups, the
 * notification prompt) as already seen. Runs as an init script, so it is in
 * place before the app reads storage. Specs about first-run behaviour start
 * from a fresh context without it.
 */
export function markFirstRunSeen() {
  try {
    localStorage.setItem('sk_cookie_consent', JSON.stringify({
      version: '1.0',
      categories: { essential: true, preferences: true, analytics: false, marketing: false },
      acceptedAt: new Date().toISOString(),
    }));
    localStorage.setItem('sk-os-seen-features', JSON.stringify({ home: true, workout: true, nutrition: true, progress: true }));
    localStorage.setItem('notif_prompt_seen', String(Date.now()));
  } catch { /* storage unavailable */ }
}

/** Signs in through the real login screen: path card, role card, form. */
export async function signIn(page, who, password = PASSWORD) {
  const account = ACCOUNTS[who];
  await page.goto('/login');
  await page.getByText('Gym ecosystem', { exact: true }).click();
  await page.getByText(account.card, { exact: true }).click();
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(password);
  await page.locator('#password').press('Enter');
}

/**
 * Signs in and ends on the role's home screen. A seeded account has not
 * accepted the current terms, and the app correctly routes it through
 * /legal first -- so this completes that step the way a person would,
 * through the real checkbox and button. Acceptance is stored server-side,
 * so it happens once per seeded run.
 */
export async function signInAndLand(page, who) {
  const home = new RegExp(`${ACCOUNTS[who].home}$`);
  await signIn(page, who);
  await expect(page).toHaveURL(/\/(legal|app\/(client|trainer))$/);
  if (page.url().endsWith('/legal')) {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'I Agree & Continue' }).click();
  }
  await expect(page).toHaveURL(home);
}

/**
 * Walks the "Set up your profile" wizard a new client sees on first sign-in,
 * through its real controls. Only sex and goal lack a default; the wheels
 * start at plausible values and experience defaults to Intermediate.
 *
 * The guided tour auto-starts when this finishes for a brand-new user.
 * `skipTour` marks it done first, for sessions whose specs are about
 * something else; onboarding.spec.js leaves it on and asserts it.
 */
export async function completeOnboarding(page, { sex = 'Male', goal = 'Fat Loss', skipTour = true } = {}) {
  const wizard = page.getByRole('dialog', { name: 'Set up your profile' });
  const next = wizard.getByRole('button', { name: 'Continue' });
  await wizard.getByRole('button', { name: 'Get started' }).click();
  await next.click(); // name, prefilled from the account
  await wizard.getByRole('button', { name: sex, exact: true }).click();
  await next.click();
  await next.click(); // height
  await next.click(); // weight
  await next.click(); // age
  await wizard.getByRole('button', { name: new RegExp(`^${goal}`) }).click();
  await next.click();
  await next.click(); // experience
  if (skipTour) {
    await page.evaluate(() => {
      const user = JSON.parse(localStorage.getItem('pos_user') || 'null');
      const done = JSON.parse(localStorage.getItem('sk-os-app-tour-done') || '{}');
      if (user?.id) done[String(user.id)] = true;
      localStorage.setItem('sk-os-app-tour-done', JSON.stringify(done));
    });
  }
  await wizard.getByRole('button', { name: 'Looks right — finish' }).click();
  await expect(wizard).toBeHidden();
}

/** Collects uncaught page errors so a spec can assert a screen rendered cleanly. */
export function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
