/**
 * UnitsProvider decides whether to ASK for a unit preference at all.
 *
 * Only a CLIENT has a client_profiles row. Asking on behalf of a trainer
 * or owner guaranteed a 404 on every session -- absorbed by a catch, so
 * the units were right, but it put a failing request and a console error
 * on every non-client page load. These tests pin the decision, because
 * the symptom of a regression is invisible in the UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const apiMock = vi.fn();
let currentUser = null;

vi.mock('../src/api.js', () => ({
  api: (...args) => apiMock(...args),
  getStoredUser: () => currentUser,
  setStoredUser: () => {},
  clearStoredUser: () => {},
}));
vi.mock('../src/auth.jsx', () => ({ useAuth: () => ({ user: currentUser }) }));

const { UnitsProvider, useUnits } = await import('../src/unitsContext.jsx');

function Probe() {
  const { system, ready } = useUnits();
  return <div data-testid="out">{ready ? system : 'loading'}</div>;
}

const renderAs = (user) => {
  currentUser = user;
  return render(<UnitsProvider><Probe /></UnitsProvider>);
};

describe('UnitsProvider', () => {
  beforeEach(() => { apiMock.mockReset(); apiMock.mockResolvedValue({ profile: { unit_system: 'imperial' } }); });

  it('does not ask for a profile that cannot exist (trainer)', async () => {
    const { getByTestId } = renderAs({ id: 'u1', role: 'TRAINER' });
    await waitFor(() => expect(getByTestId('out').textContent).toBe('metric'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('does not ask for an owner either', async () => {
    const { getByTestId } = renderAs({ id: 'u2', role: 'GYM_OWNER' });
    await waitFor(() => expect(getByTestId('out').textContent).toBe('metric'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('does ask for a client, and uses what comes back', async () => {
    const { getByTestId } = renderAs({ id: 'u3', role: 'CLIENT' });
    await waitFor(() => expect(getByTestId('out').textContent).toBe('imperial'));
    // Asserted on the PATH only: the call also carries options (probe:
    // true, so a 401 on a public page does not sign the visitor out) and
    // pinning the whole argument list would fail on an unrelated change
    // to those, which is not what this test is about.
    expect(apiMock.mock.calls[0][0]).toBe('/me/profile');
  });

  it('asks nothing when signed out', async () => {
    const { getByTestId } = renderAs(null);
    await waitFor(() => expect(getByTestId('out').textContent).toBe('metric'));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('falls back to metric when a client profile request fails', async () => {
    apiMock.mockRejectedValue(new Error('offline'));
    const { getByTestId } = renderAs({ id: 'u4', role: 'CLIENT' });
    await waitFor(() => expect(getByTestId('out').textContent).toBe('metric'));
  });
});
