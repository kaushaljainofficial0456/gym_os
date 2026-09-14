/**
 * useConfirm -- the app's confirmation dialog in place of window.confirm.
 * A destructive action waits on this promise, so each answer path must
 * resolve exactly once and the dialog must close behind it.
 */
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfirm } from '../src/components/UI.jsx';

function DeleteButton({ onAnswer, options }) {
  const [confirm, confirmDialog] = useConfirm();
  return (
    <>
      <button onClick={async () => onAnswer(await confirm(options))}>Delete workout</button>
      {confirmDialog}
    </>
  );
}

const OPTIONS = { title: 'Delete this workout?', body: 'Its logged sets go too.\nThis cannot be undone.', confirmLabel: 'Delete' };

function setup() {
  const answers = [];
  const user = userEvent.setup();
  render(<DeleteButton options={OPTIONS} onAnswer={(a) => answers.push(a)} />);
  return { user, answers };
}

describe('useConfirm', () => {
  it('asks with the given title, consequences and action label', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete workout' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this workout?' });
    expect(dialog.textContent).toContain('Its logged sets go too.');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('btn-danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('resolves true on confirm and closes', async () => {
    const { user, answers } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete workout' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(answers).toEqual([true]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolves false on Cancel, on Escape and on the close button', async () => {
    const { user, answers } = setup();
    const ask = () => user.click(screen.getByRole('button', { name: 'Delete workout' }));

    await ask();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await ask();
    await user.keyboard('{Escape}');
    await ask();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(answers).toEqual([false, false, false]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('answers no to a question that is replaced before it is answered', async () => {
    const answers = [];
    function TwoQuestions() {
      const [confirm, confirmDialog] = useConfirm();
      const [, force] = useState(0);
      return (
        <>
          <button onClick={() => { confirm({ title: 'First?' }).then((a) => answers.push(['first', a])); force((n) => n + 1); }}>One</button>
          <button onClick={() => { confirm({ title: 'Second?' }).then((a) => answers.push(['second', a])); }}>Two</button>
          {confirmDialog}
        </>
      );
    }
    const user = userEvent.setup();
    render(<TwoQuestions />);
    await user.click(screen.getByRole('button', { name: 'One' }));
    // Fired programmatically: the open dialog's scrim covers the page.
    screen.getByRole('button', { name: 'Two', hidden: true }).click();
    await screen.findByRole('dialog', { name: 'Second?' });
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(answers).toEqual([['first', false], ['second', true]]);
  });

  it('with cancelLabel null is a one-button notice', async () => {
    const answers = [];
    const user = userEvent.setup();
    render(
      <DeleteButton
        options={{ title: 'Could not delete that workout', body: 'You are offline.', confirmLabel: 'OK', cancelLabel: null, danger: false }}
        onAnswer={(a) => answers.push(a)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete workout' }));
    const dialog = screen.getByRole('dialog', { name: 'Could not delete that workout' });
    expect(dialog.textContent).toContain('You are offline.');
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'OK' }).className).toContain('btn-primary');
    await user.click(screen.getByRole('button', { name: 'OK' }));
    expect(answers).toEqual([true]);
  });
});
