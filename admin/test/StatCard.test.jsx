import test from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup } from '@testing-library/react';
import StatCard from '../src/components/StatCard.jsx';
import PriorityBadge from '../src/components/PriorityBadge.jsx';

test.afterEach(() => cleanup());

test('StatCard: a numeric value renders (reduced-motion is forced on in test/setup.js, so no animation wait is needed)', () => {
  render(<StatCard label="Active gyms" value={42} />);
  assert.ok(screen.getByText('Active gyms'));
  assert.ok(screen.getByText('42'));
});

test('StatCard: a non-numeric value ("No data yet") renders as-is, never coerced into 0', () => {
  render(<StatCard label="Churn rate" value="No data yet" />);
  const value = screen.getByText('No data yet');
  assert.match(value.className, /\bna\b/, 'a non-numeric value must carry the "na" class, not render as a fake number');
});

test('StatCard: a format function transforms a numeric value for display', () => {
  render(<StatCard label="Revenue" value={150000} format={(v) => `₹${v.toLocaleString('en-IN')}`} />);
  assert.ok(screen.getByText('₹1,50,000'));
});

test('PriorityBadge: known priorities get their tone class; an unknown/missing one falls back to "mute", never a blank badge', () => {
  const { rerender } = render(<PriorityBadge priority="URGENT" />);
  assert.match(screen.getByText('URGENT').className, /priority-urgent/);

  rerender(<PriorityBadge priority={undefined} />);
  assert.ok(screen.getByText('UNKNOWN'));
  assert.match(screen.getByText('UNKNOWN').className, /\bmute\b/);
});
