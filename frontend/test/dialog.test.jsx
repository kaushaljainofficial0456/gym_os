/**
 * useDialog -- the shared focus, Escape and scroll-lock behaviour behind
 * Modal, Sheet and every hand-rolled dialog that adopts it.
 *
 * Each test is a WCAG 2.2 dialog requirement a keyboard or screen-reader
 * user hits on every open: focus must enter, stay, and come back; Escape
 * must close one layer, not all of them.
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, Sheet, useDialog } from '../src/components/UI.jsx';

function Harness({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit set">
        {children}
      </Modal>
    </>
  );
}

describe('useDialog focus', () => {
  it('moves focus into the dialog when it opens', async () => {
    const user = userEvent.setup();
    render(<Harness><input aria-label="Reps" /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit set' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness><input aria-label="Reps" /></Harness>);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal focus from a field that autofocused itself', () => {
    render(<Modal open title="Search"><input aria-label="Food" autoFocus /></Modal>);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Food' }));
  });

  it('wraps Tab and Shift+Tab inside the dialog instead of escaping to the page behind', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Behind the scrim</button>
        <Modal open title="Edit set" onClose={() => {}}>
          <input aria-label="Reps" />
          <button>Save</button>
        </Modal>
      </>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(document.activeElement).toBe(close);

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(save);
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
  });

  it('focuses the panel itself when it holds nothing focusable', () => {
    function Bare() {
      const ref = useDialog(true, () => {});
      return <div ref={ref} data-testid="panel">Read-only notice</div>;
    }
    render(<Bare />);
    expect(document.activeElement).toBe(screen.getByTestId('panel'));
  });
});

describe('useDialog stacking', () => {
  it('closes only the topmost dialog on Escape', async () => {
    const user = userEvent.setup();
    const closeSheet = vi.fn();
    const closeConfirm = vi.fn();
    render(
      <>
        <Sheet open title="Log food" onClose={closeSheet}>Body</Sheet>
        <Modal open title="Discard changes?" onClose={closeConfirm}>Sure?</Modal>
      </>,
    );
    await user.keyboard('{Escape}');
    expect(closeConfirm).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it('leaves Escape to a dialog that passes onClose as null', async () => {
    const user = userEvent.setup();
    const closeSheet = vi.fn();
    function OwnEscape() {
      const ref = useDialog(true, null);
      return <div ref={ref}><button>Step back</button></div>;
    }
    render(
      <>
        <Sheet open title="Under" onClose={closeSheet}>Body</Sheet>
        <OwnEscape />
      </>,
    );
    await user.keyboard('{Escape}');
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it('keeps the page locked until the LAST open dialog closes', () => {
    document.body.style.overflow = 'scroll';
    const { rerender } = render(
      <>
        <Sheet open title="Under">Body</Sheet>
        <Modal open title="Over">Body</Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <>
        <Sheet open title="Under">Body</Sheet>
        <Modal open={false} title="Over">Body</Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <>
        <Sheet open={false} title="Under">Body</Sheet>
        <Modal open={false} title="Over">Body</Modal>
      </>,
    );
    expect(document.body.style.overflow).toBe('scroll');
  });
});
