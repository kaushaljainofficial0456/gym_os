// Google refuses to sign in inside embedded WebViews, so the Google button
// is hidden there. The Barbell Android app is the case that matters: its
// WebView appends "GymOS-Android" to the user agent (mobile/capacitor.config.js).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/googleIdentity.js', () => ({ loadGoogleIdentity: () => Promise.resolve() }));
vi.mock('../src/themeContext.jsx', () => ({ useTheme: () => ({ resolved: 'light' }) }));

const { isEmbeddedWebView } = await import('../src/components/auth/authKit.jsx');

describe('isEmbeddedWebView', () => {
  it('spots the Barbell Android app', () => {
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 GymOS-Android')).toBe(true);
  });

  it('spots other Android WebViews and in-app browsers', () => {
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 13; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36')).toBe(true);
    expect(isEmbeddedWebView('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0')).toBe(true);
    expect(isEmbeddedWebView('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]')).toBe(true);
  });

  it('leaves real browsers alone, where Google sign-in works', () => {
    expect(isEmbeddedWebView('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36')).toBe(false);
    expect(isEmbeddedWebView('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe(false);
    expect(isEmbeddedWebView('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe(false);
    expect(isEmbeddedWebView('')).toBe(false);
  });
});
