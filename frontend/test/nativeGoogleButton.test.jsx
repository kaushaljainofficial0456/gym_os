// The Barbell Android app (from the APK that added it) signs in with Google
// natively: mobile/src/shell.js puts googleSignIn on window.__gymosShell. The
// page then shows its own Google button that asks the app for an ID token,
// instead of Google's web button, which Google refuses inside a WebView.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/googleIdentity.js', () => ({ loadGoogleIdentity: () => Promise.resolve() }));
vi.mock('../src/themeContext.jsx', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const APP_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36 GymOS-Android';

// authKit reads the environment once, at import -- as it does in the app,
// where the shell is installed before any of the page's scripts run.
async function loadAuthKit({ shell, ua = APP_UA, clientId = CLIENT_ID }) {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
  if (shell) window.__gymosShell = shell; else delete window.__gymosShell;
  return import('../src/components/auth/authKit.jsx');
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete window.__gymosShell;
});

describe('Google sign-in inside the Barbell app', () => {
  it('an app with native sign-in gets a working Google button that posts the native ID token', async () => {
    const googleSignIn = vi.fn(async () => ({ idToken: 'native.id.token' }));
    const kit = await loadAuthKit({ shell: { back: () => {}, googleSignIn } });
    expect(kit.googleNative).toBe(true);
    expect(kit.googleAvailable).toBe(true);
    expect(kit.googleBlockedHere).toBe(false);

    const onCredential = vi.fn();
    render(<kit.GoogleButton onCredential={onCredential} onError={() => {}} text="signin_with" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(onCredential).toHaveBeenCalledWith('native.id.token'));
    expect(googleSignIn).toHaveBeenCalledWith({ serverClientId: CLIENT_ID });
  });

  it('closing Google\'s sheet shows no error; a real failure shows its message', async () => {
    const googleSignIn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Google sign-in was closed.'), { code: 'CANCELED' }))
      .mockRejectedValueOnce(Object.assign(new Error('No Google account is available on this phone.'), { code: 'NO_ACCOUNT' }));
    const kit = await loadAuthKit({ shell: { googleSignIn } });
    const onError = vi.fn();
    const onCredential = vi.fn();
    render(<kit.GoogleButton onCredential={onCredential} onError={onError} />);
    const button = screen.getByRole('button', { name: 'Continue with Google' });

    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(onError).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('No Google account is available on this phone.'));
    expect(onCredential).not.toHaveBeenCalled();
  });

  it('an older app without native sign-in keeps the button hidden and shows the password hint', async () => {
    const kit = await loadAuthKit({ shell: { back: () => {} } });
    expect(kit.googleNative).toBe(false);
    expect(kit.googleAvailable).toBe(false);
    expect(kit.googleBlockedHere).toBe(true);
    const { container } = render(<kit.GoogleButton onCredential={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('a normal browser still gets Google\'s own web button', async () => {
    const kit = await loadAuthKit({ shell: null, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36' });
    expect(kit.googleNative).toBe(false);
    expect(kit.googleAvailable).toBe(true);
    render(<kit.GoogleButton onCredential={() => {}} />);
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
  });
});
