// ============================================================
// REMEDIATION: the first real frontend test in this repo. Covers the
// Modal focus-management fix (components/UI.jsx) -- previously
// role="dialog"/aria-modal="true" existed but nothing moved focus: an
// open modal left keyboard/screen-reader focus wherever it already was,
// and closing one never returned it. This proves both halves against the
// REAL component (no mock), not just by reading the source.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/components/UI.jsx';

test.afterEach(() => cleanup());

test('Modal: focus moves into the panel (onto its first focusable element) when it opens', async () => {
  const trigger = document.createElement('button');
  trigger.textContent = 'Open';
  document.body.appendChild(trigger);
  trigger.focus();
  assert.equal(document.activeElement, trigger, 'sanity check: the trigger has focus before the modal opens');

  render(
    <Modal open title="Confirm delete">
      <button>Yes, delete</button>
      <button>Cancel</button>
    </Modal>
  );

  // The focus-move is inside a setTimeout (see UI.jsx's own comment on
  // why -- letting the panel actually mount first), so wait for it
  // rather than asserting synchronously right after render(). The FIRST
  // focusable element in DOM order is the panel's own "Close" button
  // (rendered before {children}), not "Yes, delete" -- correct, expected
  // behavior (Tab from there reaches the real content next), not a bug.
  await waitFor(() => {
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close', 'focus must land on the first focusable element inside the dialog, not stay on the (now hidden-behind-overlay) trigger');
  });

  trigger.remove();
});

test('Modal: closing it returns focus to whatever was focused before it opened', async () => {
  const trigger = document.createElement('button');
  trigger.textContent = 'Open';
  document.body.appendChild(trigger);
  trigger.focus();

  const { rerender, unmount } = render(
    <Modal open title="Confirm delete">
      <button>Yes, delete</button>
    </Modal>
  );

  await waitFor(() => {
    assert.notEqual(document.activeElement, trigger, 'focus should have moved into the dialog first');
  });

  // Simulate closing: React-unmount the dialog (this Modal returns null
  // when `open` is false, and the cleanup effect that returns focus runs
  // on unmount/re-render exactly the same way -- see UI.jsx's useEffect
  // cleanup). rerender with open=false exercises the SAME effect-cleanup
  // path a real onClose -> setState(false) would.
  rerender(
    <Modal open={false} title="Confirm delete">
      <button>Yes, delete</button>
    </Modal>
  );

  await waitFor(() => {
    assert.equal(document.activeElement, trigger, 'focus must return to the element that opened the dialog');
  });

  unmount();
  trigger.remove();
});

test('Modal: renders nothing when closed', () => {
  const { container } = render(<Modal open={false} title="Hidden">content</Modal>);
  assert.equal(container.textContent, '');
});

test('Modal: exposes the dialog role, aria-modal and a label for assistive tech', () => {
  render(<Modal open title="Delete this client?">Body text</Modal>);
  const dialog = screen.getByRole('dialog', { name: 'Delete this client?' });
  assert.ok(dialog, 'a dialog with an accessible name matching the title must exist');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
});

test('Modal: clicking the overlay closes it; clicking inside the panel does not (event propagation is stopped)', async () => {
  const user = userEvent.setup();
  let closed = 0;
  render(
    <Modal open title="Confirm" onClose={() => { closed += 1; }}>
      <p>Body content</p>
    </Modal>
  );

  // Clicking real body text inside the panel must NOT bubble up to the
  // overlay's own onClose handler -- the panel's onClick calls
  // e.stopPropagation() specifically so a click on the dialog's own
  // content never dismisses it.
  await user.click(screen.getByText('Body content'));
  assert.equal(closed, 0, 'clicking inside the panel must not close the dialog');

  // The overlay is the outermost role="dialog" element itself -- clicking
  // it directly (not any of its children) must close.
  await user.click(screen.getByRole('dialog'));
  assert.equal(closed, 1, 'clicking the backdrop must close the dialog exactly once');
});
