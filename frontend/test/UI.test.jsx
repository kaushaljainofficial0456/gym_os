// Smoke tests for a few more of the shared UI kit's components, proving
// the test harness (see test/setup.js) generalizes beyond Modal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusChip, Spinner, PageHeader } from '../src/components/UI.jsx';

test.afterEach(() => cleanup());

test('StatusChip: known statuses render their label; an unknown one falls back to the raw value, never blank', () => {
  const { rerender } = render(<StatusChip status="ON_TRACK" />);
  assert.equal(screen.getByText('ON TRACK').textContent, 'ON TRACK');

  rerender(<StatusChip status="AT_RISK" />);
  assert.equal(screen.getByText('AT RISK').textContent, 'AT RISK');

  rerender(<StatusChip status="SOMETHING_NEW" />);
  assert.equal(screen.getByText('SOMETHING_NEW').textContent, 'SOMETHING_NEW');
});

test('Spinner: exposes role="status" so a screen reader announces the loading state', () => {
  render(<Spinner label="Loading clients…" />);
  const status = screen.getByRole('status');
  assert.match(status.textContent, /Loading clients/);
});

test('PageHeader: renders the title always, the subtitle only when given', () => {
  const { rerender } = render(<PageHeader title="Clients" />);
  assert.equal(screen.getByText('Clients').tagName, 'H1');
  assert.equal(screen.queryByText('12 active'), null, 'no subtitle text should exist when `sub` is not passed');

  rerender(<PageHeader title="Clients" sub="12 active" />);
  assert.ok(screen.getByText('12 active'));
});
