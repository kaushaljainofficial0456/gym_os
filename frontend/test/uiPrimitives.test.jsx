/**
 * The shared UI primitives in components/UI.jsx.
 *
 * These are consumed by most screens in the app, so a regression here is a
 * regression everywhere at once. Each test pins a contract a call site
 * already depends on -- not an implementation detail.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Modal, Sheet, Toast, ErrorState, Empty, Button, PasswordInput, Seg,
} from '../src/components/UI.jsx';

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(<Modal open={false} title="Hidden">content</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog named by its title, portalled out of the page tree', () => {
    const { container } = render(<Modal open title="Delete client?">Body</Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Delete client?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Portalled to <body>: a transformed page ancestor would otherwise
    // become the containing block for its position:fixed scrim.
    expect(container.contains(dialog)).toBe(false);
  });

  it('closes on the backdrop and the close button, but not on a click inside', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open title="Confirm" onClose={onClose}><p>Body content</p></Modal>);

    await user.click(screen.getByText('Body content'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open title="Confirm" onClose={onClose}>Body</Modal>);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet', () => {
  it('locks page scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = render(<Sheet open title="Log food">Body</Sheet>);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Sheet open={false} title="Log food">Body</Sheet>);
    expect(document.body.style.overflow).toBe('auto');
  });

  it('keeps the footer outside the scrolling body so the action stays reachable', () => {
    render(<Sheet open title="Log food" footer={<button>Save</button>}>Body</Sheet>);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.closest('.overflow-y-auto')).toBeNull();
  });

  it('honours dismissOnBackdrop={false} for sheets holding unsaved input', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Sheet open title="Edit" onClose={onClose} dismissOnBackdrop={false}>Body</Sheet>);
    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  it('announces politely and dismisses itself after its duration', () => {
    vi.useFakeTimers();
    try {
      const onDone = vi.fn();
      render(<Toast message="Saved" onDone={onDone} duration={1000} />);
      expect(screen.getByRole('status').textContent).toContain('Saved');
      act(() => { vi.advanceTimersByTime(999); });
      expect(onDone).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing without a message', () => {
    render(<Toast message="" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ErrorState', () => {
  it('shows a short human API message as the explanation', () => {
    render(<ErrorState error={new Error('That client no longer exists')} />);
    expect(screen.getByRole('alert').textContent).toContain('That client no longer exists');
    expect(screen.queryByText('Technical details')).toBeNull();
  });

  it('replaces a technical message with a sentence, keeping the raw text collapsed', () => {
    render(<ErrorState error={new Error('TypeError: Cannot read properties of undefined')} />);
    expect(screen.getByText("We couldn't load this just now. Please try again.")).toBeTruthy();
    expect(screen.getByText('Technical details')).toBeTruthy();
  });

  it('offers a retry only when the caller can retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState error={new Error('Offline')} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    rerender(<ErrorState error={new Error('Offline')} onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('Empty', () => {
  it('renders the title, the explanation and the next action', () => {
    render(<Empty title="No workouts yet" hint="Your coach has not assigned one." action={<button>Browse library</button>} />);
    expect(screen.getByText('No workouts yet')).toBeTruthy();
    expect(screen.getByText('Your coach has not assigned one.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Browse library' })).toBeTruthy();
  });
});

describe('Button', () => {
  it('is disabled and busy while loading, so a double tap cannot submit twice', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('maps variants onto the CSS button system', () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('btn-danger');
  });
});

describe('PasswordInput', () => {
  it('reveals and re-hides the password, announcing the state', async () => {
    const user = userEvent.setup();
    render(<><label htmlFor="pw">Password</label><PasswordInput id="pw" /></>);
    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('type')).toBe('password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.getAttribute('type')).toBe('password');
  });
});

describe('Seg', () => {
  it('marks the current option selected and reports a change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Seg value="week" onChange={onChange} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />);
    expect(screen.getByRole('tab', { name: 'Week' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Month' }).getAttribute('aria-selected')).toBe('false');
    await user.click(screen.getByRole('tab', { name: 'Month' }));
    expect(onChange).toHaveBeenCalledWith('month');
  });
});
