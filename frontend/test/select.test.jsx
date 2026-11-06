import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Select from '../src/components/Select.jsx';

const OPTIONS = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
];

function Harness({ onChange = () => {}, initial = 'cash' }) {
  const [v, setV] = useState(initial);
  return <Select aria-label="Payment method" value={v} options={OPTIONS} onChange={(x) => { setV(x); onChange(x); }} />;
}

describe('Select: the workspace dropdown', () => {
  it('shows the chosen option and opens a listbox with every option, the current one marked', () => {
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Payment method' });
    expect(box.textContent).toContain('Cash');
    fireEvent.click(box);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Cash', 'UPI', 'Card']);
    expect(screen.getByRole('option', { name: 'Cash' }).getAttribute('aria-selected')).toBe('true');
  });

  it('picks by mouse and by keyboard, and reports the value (not an event)', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Payment method' });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('option', { name: 'Card' }));
    expect(onChange).toHaveBeenLastCalledWith('card');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(box, { key: 'ArrowDown' });          // opens on Card
    fireEvent.keyDown(box, { key: 'ArrowDown' });          // wraps to Cash
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('cash');
  });

  it('Escape closes only the list and marks the key handled, so a surrounding dialog stays open', () => {
    render(<Harness />);
    const box = screen.getByRole('combobox', { name: 'Payment method' });
    fireEvent.click(box);
    // fireEvent returns false when a handler called preventDefault.
    const notHandled = fireEvent.keyDown(box, { key: 'Escape' });
    expect(notHandled).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.getAttribute('aria-expanded')).toBe('false');
  });

  it('a placeholder stands in until something is chosen', () => {
    render(<Select aria-label="Member" value="" placeholder="Choose a member" options={OPTIONS} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Member' }).textContent).toContain('Choose a member');
  });
});
