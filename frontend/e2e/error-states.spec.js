import { test, expect } from '@playwright/test';
import { storageFor } from './fixtures.js';

/**
 * A request that fails must say so. Each of these screens used to render its
 * EMPTY state when its data failed to load -- "No receipts yet", "No messages
 * yet", "anything with a number and a date belongs here" -- which is a false
 * statement about the person's data, not an error.
 *
 * Each test fails one request at the network layer, checks the screen shows
 * the server's reason with a way to retry and does NOT claim the data is
 * empty, then lets the retry through and checks the screen recovers.
 */
const REASON = 'The server could not load this right now';
const FAILURE = { status: 500, contentType: 'application/json', body: JSON.stringify({ error: REASON }) };

async function expectErrorThenRecovery(page, matcher, emptyClaim) {
  const alert = page.getByRole('alert').filter({ hasText: REASON });
  await expect(alert).toBeVisible();
  await expect(page.getByText(emptyClaim)).toHaveCount(0);
  await page.unroute(matcher);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(alert).toHaveCount(0);
}

test.describe('client', () => {
  test.use({ storageState: storageFor('client') });

  test('custom metrics that fail to load say so instead of claiming there are none', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/me/metrics';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/client/progress');
    await expectErrorThenRecovery(page, matcher, /anything with a\s+number and a date/);
  });

  test('personal metrics on Profile that fail to load are not "No personal metrics yet"', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/me/metrics';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/client/profile?section=metrics');
    await expectErrorThenRecovery(page, matcher, 'No personal metrics yet');
  });
});

test.describe('owner, dashboard and roster', () => {
  test.use({ storageState: storageFor('owner') });

  test('an attention queue that fails to load does not say "Everyone is on track"', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/dashboard/attention';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer');
    await expectErrorThenRecovery(page, matcher, 'Everyone is on track');
  });

  test('an adherence trend that fails to load does not say nothing was logged', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/dashboard/adherence-trend';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer');
    await expectErrorThenRecovery(page, matcher, /No adherence logged/);
  });

  test('a member roster that fails to load is not "No members yet"', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/admin/members';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer/business');
    await expectErrorThenRecovery(page, matcher, 'No members yet');
  });

  test('membership plans that fail to load are not an empty plan picker', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/admin/packages';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer/enterprise/qr');
    await expect(page.getByRole('alert').filter({ hasText: REASON })).toBeVisible();
    // No picker that could only ever be empty, and no Generate that could never enable.
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expectErrorThenRecovery(page, matcher, /haven't added any membership plans/);
    await expect(page.getByRole('combobox')).toHaveCount(1);
  });
});

test.describe('owner', () => {
  test.use({ storageState: storageFor('owner') });

  test('a message thread that fails to load is not shown as an empty conversation', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/messages' && url.searchParams.has('client_id');
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer/messages');
    await page.getByRole('combobox', { name: 'Choose a client thread' }).selectOption({ index: 1 });
    await expectErrorThenRecovery(page, matcher, 'No messages yet');
  });

  test('receipts that fail to load are not shown as "No receipts yet"', async ({ page }) => {
    const matcher = (url) => url.pathname === '/api/enterprise/invoices';
    await page.route(matcher, (route) => route.fulfill(FAILURE));
    await page.goto('/app/trainer/enterprise/billing');
    await expectErrorThenRecovery(page, matcher, 'No receipts yet');
  });
});
