// Adding exercises mid-session: several in one go, in the order picked,
// any of them dropped again with a second tap, and an exercise already in
// the workout never offered twice.
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExerciseSearchList from '../src/components/workout/ExerciseSearchList.jsx';

const LIB = [
  { id: 'e1', name: 'Bench Press', primary_muscle: 'CHEST', equipment: 'BARBELL' },
  { id: 'e2', name: 'Cable Fly', primary_muscle: 'CHEST', equipment: 'CABLE' },
  { id: 'e3', name: 'Lateral Raise', primary_muscle: 'SIDE_DELTS', equipment: 'DUMBBELL' },
  { id: 'e4', name: 'Hammer Curl', primary_muscle: 'BICEPS', equipment: 'DUMBBELL' },
];

function Harness({ onInfo }) {
  const [picks, setPicks] = useState([]);
  const toggle = (x) => setPicks((p) => (p.some((y) => y.id === x.id) ? p.filter((y) => y.id !== x.id) : [...p, x]));
  return (
    <>
      <ExerciseSearchList fallback={LIB} addedIds={new Set(['e4'])} selected={picks.map((x) => x.id)} onToggle={toggle} onPick={onInfo} />
      <output data-testid="picks">{picks.map((x) => x.id).join(',')}</output>
    </>
  );
}

describe('exercise multi-select', () => {
  it('selects several, numbers them in order, and deselects on a second tap', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Select Cable Fly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Bench Press' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Lateral Raise' }));
    expect(screen.getByTestId('picks').textContent).toBe('e2,e1,e3');
    expect(screen.getByRole('button', { name: /Bench Press, selected 2/ }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Bench Press, selected 2/ }));
    expect(screen.getByTestId('picks').textContent).toBe('e2,e3');
    // The rest renumber: Lateral Raise is now second.
    expect(screen.getByRole('button', { name: /Lateral Raise, selected 2/ })).toBeTruthy();
  });

  it('never offers an exercise that is already in the workout', () => {
    render(<Harness />);
    const done = screen.getByRole('button', { name: /Hammer Curl, already in your workout/ });
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(screen.getByTestId('picks').textContent).toBe('');
  });

  it('opens an exercise\'s detail from its info button without selecting it', () => {
    const onInfo = vi.fn();
    render(<Harness onInfo={onInfo} />);
    fireEvent.click(screen.getByRole('button', { name: 'About Cable Fly' }));
    expect(onInfo).toHaveBeenCalledWith(LIB[1]);
    expect(screen.getByTestId('picks').textContent).toBe('');
  });
});
