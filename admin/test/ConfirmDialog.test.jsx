// REMEDIATION: the first test for the admin console's frontend. Covers
// ConfirmDialog's own accessibility fix (the "type CONFIRMTEXT" field's
// <label> is now associated via htmlFor/id -- see this repo's a11y
// remediation commit) and its type-to-confirm gating, which guards every
// destructive admin action (suspend a gym, issue a refund).
import test from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '../src/components/ConfirmDialog.jsx';

test.afterEach(() => cleanup());

test('ConfirmDialog: the type-to-confirm input is reachable by its label (accessible name), not just visible text', async () => {
  render(
    <ConfirmDialog open title="Suspend this gym?" confirmText="SUSPEND" onConfirm={() => {}} onCancel={() => {}} />
  );
  // getByLabelText only succeeds if the <label> is actually PROGRAMMATICALLY
  // associated (htmlFor/id) -- this is the exact regression this test
  // guards against re-introducing.
  const input = screen.getByLabelText(/Type/i);
  assert.equal(input.tagName, 'INPUT');
});

test('ConfirmDialog: confirm stays disabled until the exact confirmText is typed, then calls onConfirm', async () => {
  const user = userEvent.setup();
  let confirmed = 0;
  render(
    <ConfirmDialog open title="Suspend this gym?" confirmText="SUSPEND" confirmLabel="Suspend"
      onConfirm={() => { confirmed += 1; }} onCancel={() => {}} />
  );
  const confirmBtn = screen.getByRole('button', { name: 'Suspend' });
  const input = screen.getByLabelText(/Type/i);

  assert.ok(confirmBtn.disabled, 'must start disabled -- nothing typed yet');

  await user.type(input, 'SUSP');
  assert.ok(confirmBtn.disabled, 'a partial match must not enable the button');

  await user.type(input, 'END');
  await waitFor(() => assert.equal(confirmBtn.disabled, false));

  await user.click(confirmBtn);
  assert.equal(confirmed, 1);
});

test('ConfirmDialog: without confirmText, it is a plain confirm/cancel with no typed-confirmation field', () => {
  let cancelled = 0;
  render(
    <ConfirmDialog open title="Reactivate this gym?" confirmLabel="Reactivate"
      onConfirm={() => {}} onCancel={() => { cancelled += 1; }} />
  );
  assert.equal(screen.queryByRole('textbox'), null, 'no typed-confirmation input when confirmText is not given');
  const confirmBtn = screen.getByRole('button', { name: 'Reactivate' });
  assert.equal(confirmBtn.disabled, false, 'nothing to type, so confirm is enabled immediately');
});

test('ConfirmDialog: exposes role="dialog" with an accessible name matching the title', () => {
  render(<ConfirmDialog open title="Refund this payment?" onConfirm={() => {}} onCancel={() => {}} />);
  const dialog = screen.getByRole('dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'confirm-dialog-title');
  assert.equal(screen.getByText('Refund this payment?').id, 'confirm-dialog-title');
});
