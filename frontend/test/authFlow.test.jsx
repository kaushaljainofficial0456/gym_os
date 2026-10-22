import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterTerms, takeAfterTerms } from '../src/afterTerms.js';

vi.mock('../src/googleIdentity.js', () => ({ loadGoogleIdentity: () => Promise.resolve() }));
vi.mock('../src/themeContext.jsx', () => ({ useTheme: () => ({ resolved: 'light' }) }));
const { RoleSwitch } = await import('../src/components/auth/authKit.jsx');

describe('where the terms screen continues to', () => {
  beforeEach(() => sessionStorage.clear());

  it('goes where the person was headed, once', () => {
    afterTerms('/app/trainer/enterprise/onboarding');
    expect(takeAfterTerms()).toBe('/app/trainer/enterprise/onboarding');
    expect(takeAfterTerms()).toBe('/app');
  });

  it('falls back to /app with nothing recorded, and never leaves the app', () => {
    expect(takeAfterTerms()).toBe('/app');
    afterTerms('https://example.com/phish');
    expect(takeAfterTerms()).toBe('/app');
    afterTerms('/login');
    expect(takeAfterTerms()).toBe('/app');
  });
});

describe('RoleSwitch', () => {
  const ROLES = [{ id: 'CLIENT', label: 'Client' }, { id: 'TRAINER', label: 'Trainer' }, { id: 'GYM_OWNER', label: 'Owner' }];
  function Harness() {
    const [role, setRole] = useState('CLIENT');
    return <RoleSwitch label="I'm signing in as" options={ROLES} value={role} onChange={setRole} />;
  }

  it('is a radio group with one choice checked, chosen by click or arrow keys', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: "I'm signing in as" });
    expect(screen.getByRole('radio', { name: 'Client' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Owner' }));
    expect(screen.getByRole('radio', { name: 'Owner' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Client' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.keyDown(group, { key: 'ArrowRight' });       // wraps to the first
    expect(screen.getByRole('radio', { name: 'Client' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Owner' }).getAttribute('aria-checked')).toBe('true');
    // Only the checked option is in the tab order.
    expect(screen.getByRole('radio', { name: 'Owner' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'Trainer' }).getAttribute('tabindex')).toBe('-1');
  });
});
