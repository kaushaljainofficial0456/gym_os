import { test, expect } from '@playwright/test';
import { markFirstRunSeen, signIn, storageFor } from './fixtures.js';

/**
 * Authentication journeys. The success path is exercised by auth.setup.js
 * for every role on every run; these cover the ways it can go wrong and the
 * routing guards around it.
 */
test.describe('signed out', () => {
  test.beforeEach(async ({ page }) => { await page.addInitScript(markFirstRunSeen); });

  // These routes are public on purpose (App.jsx): signing up, the legal
  // pages a payment reviewer must read without an account, and the links
  // people share. A provider fetching a private endpoint on every route
  // once turned its 401 into a redirect that bounced all of them to /login.
  for (const path of ['/signup', '/signup/trainer', '/privacy', '/terms', '/contact', '/about', '/refund-policy', '/shipping-policy']) {
    test(`${path} stays readable without signing in`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    });
  }

  test('a private screen sends the visitor to sign in', async ({ page }) => {
    await page.goto('/app/client/nutrition');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password is explained on the form and the fields are marked invalid', async ({ page }) => {
    await signIn(page, 'client', 'definitely-not-the-password');
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toHaveText('');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#password')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#email')).toHaveValue('client1@ironforge.in');
  });

  // Every signed-out page load probes /auth/me, gets a 401, and api()'s 401
  // branch used to answer that with POST /auth/logout. That endpoint allows
  // 30 requests a minute per IP. Signed-out browsing behind one shared
  // address -- a gym's Wi-Fi -- therefore spends the budget a real sign-out
  // needs, and a refused logout is invisible: the client clears its own
  // state and navigates anyway, then the surviving cookie signs the person
  // straight back in on the next load.
  test('browsing signed out does not spend the logout rate limit', async ({ page }) => {
    const logoutCalls = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/auth/logout')) logoutCalls.push(r.url());
    });
    for (const path of ['/login', '/signup', '/privacy', '/terms']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    expect(logoutCalls).toHaveLength(0);
  });

  test('password recovery is reachable from the sign-in form', async ({ page }) => {
    await page.goto('/login');
    await page.getByText('Gym ecosystem', { exact: true }).click();
    await page.getByText('Client', { exact: true }).click();
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe('signed in', () => {
  test.use({ storageState: storageFor('owner') });

  test('opening the login screen returns a signed-in user to their workspace', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/app\/trainer$/);
  });

  test('a trainer-workspace user is not shown the client app', async ({ page }) => {
    await page.goto('/app/client');
    await expect(page).toHaveURL(/\/app\/trainer$/);
  });

  // Logout clears this browser's cookie only (routes/auth.js), so ending
  // this context's session leaves the saved one other specs reuse intact.
  test('signing out ends the session, and the workspace is closed afterwards', async ({ page }) => {
    await page.goto('/app/trainer');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const logout = page.waitForResponse((r) => r.url().endsWith('/api/auth/logout'));
    await page.getByRole('dialog', { name: 'Trainer navigation' }).getByRole('button', { name: /Sign out/ }).click();
    // The server must actually accept the logout: the client clears its own
    // state regardless, so a refused request looks like a working button
    // right up until the next page load signs the user straight back in.
    expect((await logout).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/app/trainer');
    await expect(page).toHaveURL(/\/login$/);
  });
});
