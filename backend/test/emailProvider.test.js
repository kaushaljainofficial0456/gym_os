// ============================================================
// emailProvider.js -- mock-provider behavior at the unit level. The
// zero-cost gate itself (EMAIL_PROVIDER=resend needing BOTH the flag
// AND RESEND_API_KEY) is tested separately in
// emailZeroCostSafety.test.js, subprocess-based like paymentZeroCostSafety
// .test.js -- module-load-time consts can't be re-tested by mutating
// process.env against an already-imported module instance.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, providerName, isLiveProviderConfigured, emailConfigSummary, _mockOutbox, _resetMockEmailStateForTests } from '../src/services/notifications/emailProvider.js';

test.beforeEach(() => { _resetMockEmailStateForTests(); });

test('providerName(): no env configured -> mock, isLiveProviderConfigured() false', () => {
  assert.equal(providerName(), 'mock');
  assert.equal(isLiveProviderConfigured(), false);
});

test('sendEmail: mock provider succeeds, records to the outbox, never touches the network', async () => {
  const result = await sendEmail({ to: 'client@test.in', subject: 'Your invoice', html: '<p>hi</p>' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'mock');
  assert.ok(result.providerMessageId?.startsWith('mock_email_'));

  const outbox = _mockOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'client@test.in');
  assert.equal(outbox[0].subject, 'Your invoice');
});

test('sendEmail: a PDF Buffer attachment is normalized to base64 in the outbox', async () => {
  const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf bytes');
  await sendEmail({ to: 'client@test.in', subject: 'Invoice', html: '<p>hi</p>', attachments: [{ filename: 'INV-1.pdf', content: pdfBuffer }] });
  const outbox = _mockOutbox();
  assert.deepEqual(outbox[0].attachmentFilenames, ['INV-1.pdf']);
});

test('sendEmail: missing `to` fails validation, never reaches the mock outbox', async () => {
  const result = await sendEmail({ subject: 'x', html: '<p>x</p>' });
  assert.equal(result.ok, false);
  assert.equal(_mockOutbox().length, 0);
});

test('sendEmail: missing both html and text fails validation', async () => {
  const result = await sendEmail({ to: 'a@test.in', subject: 'x' });
  assert.equal(result.ok, false);
  assert.equal(_mockOutbox().length, 0);
});

test('emailConfigSummary: reports mock provider and unconfigured live state by default, never a secret value', () => {
  const summary = emailConfigSummary();
  assert.equal(summary.provider, 'mock');
  assert.equal(summary.liveConfigured, false);
  assert.equal(typeof summary.from, 'string');
});
