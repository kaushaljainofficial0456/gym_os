import { useState, useEffect, createContext, useContext, useCallback } from 'react';

// Cookie categories that the app actually uses:
//   Essential  — auth tokens (pos_token, sk_token, pos_user). Cannot reject.
//   Preferences — FeaturePopup tracking, App Tour completion (localStorage UX state).
//   Analytics   — None currently loaded. Reserved for future.
//   Marketing   — None currently loaded. Reserved for future.
const COOKIE_POLICY_VERSION = '1.0';
const STORAGE_KEY = 'sk_cookie_consent';

const CookieCtx = createContext(null);

export function useCookieConsent() {
  return useContext(CookieCtx);
}

/**
 * CookieConsentProvider wraps the app and provides:
 *  - consent state (which categories are accepted)
 *  - Banner (renders itself when consent hasn't been given)
 *  - openPreferences() to re-open the preferences modal
 */
export function CookieConsentProvider({ children }) {
  const [consent, setConsent] = useState(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);

  // Load stored consent on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        if (stored.version === COOKIE_POLICY_VERSION) {
          setConsent(stored);
          setShowBanner(false);
          return;
        }
      }
    } catch { /* ignore */ }
    // No valid consent found — show banner
    setShowBanner(true);
  }, []);

  const save = useCallback((categories) => {
    const data = { version: COOKIE_POLICY_VERSION, categories, acceptedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    setConsent(data);
    setShowBanner(false);
    setShowPrefs(false);
  }, []);

  const acceptAll = useCallback(() => {
    save({ essential: true, preferences: true, analytics: true, marketing: true });
  }, [save]);

  const rejectOptional = useCallback(() => {
    save({ essential: true, preferences: false, analytics: false, marketing: false });
  }, [save]);

  const openPreferences = useCallback(() => setShowPrefs(true), []);

  const value = {
    consent,
    categories: consent?.categories || { essential: true, preferences: false, analytics: false, marketing: false },
    hasDecided: !!consent,
    acceptAll,
    rejectOptional,
    openPreferences,
    save,
  };

  return (
    <CookieCtx.Provider value={value}>
      {children}
      {showBanner && <CookieBanner onAcceptAll={acceptAll} onRejectOptional={rejectOptional} onManage={openPreferences} />}
      {showPrefs && <CookiePreferencesModal onClose={() => setShowPrefs(false)} onSave={save} current={consent?.categories} />}
    </CookieCtx.Provider>
  );
}

/**
 * The banner used to be a tall block of legal prose pinned over the bottom
 * of the screen — it covered the entire tab bar, so the first thing a new
 * user saw was an app they couldn't navigate. It is now a compact bar with
 * the two decisions side by side, sitting ABOVE the tab bar rather than on
 * top of it, and it says what it does in one line instead of five.
 */
function CookieBanner({ onAcceptAll, onRejectOptional, onManage }) {
  return (
    <div
      className="fixed inset-x-0 z-50 px-3 anim-fadeUp"
      role="region"
      aria-label="Cookie choices"
      /* Clears the tab bar (64px) plus the phone's home indicator, so the
         banner never sits on top of navigation. */
      style={{ animationDuration: '0.35s', bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="max-w-2xl mx-auto p-4"
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--e-3)' }}>
        <p className="t-sub" style={{ color: 'var(--ink)' }}>
          We use cookies to keep you signed in and remember your preferences. Analytics and
          marketing cookies are optional.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3.5">
          <button onClick={onAcceptAll} className="btn-primary btn-sm flex-1">Accept all</button>
          <button onClick={onRejectOptional} className="btn btn-sm flex-1">Reject optional</button>
          <button onClick={onManage} className="btn-ghost btn-sm">Manage</button>
        </div>
      </div>
    </div>
  );
}

function CookiePreferencesModal({ onClose, onSave, current }) {
  const [prefs, setPrefs] = useState({
    essential: true,
    preferences: current?.preferences ?? false,
    analytics: current?.analytics ?? false,
    marketing: current?.marketing ?? false,
  });

  const toggle = (key) => {
    if (key === 'essential') return; // cannot toggle
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="cookie-prefs-title">
      <div className="scrim !z-0 anim-fadeIn" />

      <div
        className="relative w-full sm:max-w-lg max-h-[85vh] flex flex-col sheet anim-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle sm:hidden" />
        <div className="sheet-header">
          <h2 id="cookie-prefs-title" className="t-card">Cookie preferences</h2>
          {/* Was '✕' — a text glyph that inherits the body font's weight,
              so it never optically matched the SVG icons elsewhere. */}
          <button onClick={onClose} className="chrome-btn btn-icon justify-center" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Categories */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <CategoryCard
            title="Essential"
            required
            description="Required for the service to function. These include authentication tokens and session data. Cannot be disabled."
            enabled
            locked
          />
          <CategoryCard
            title="Preferences"
            description="Remember your choices such as feature popups seen, app tour completion, and other UX state. Disabling may cause repeated prompts."
            enabled={prefs.preferences}
            onToggle={() => toggle('preferences')}
          />
          <CategoryCard
            title="Analytics"
            description="Help us understand how the platform is used to improve the experience. No analytics technologies are currently loaded."
            enabled={prefs.analytics}
            onToggle={() => toggle('analytics')}
          />
          <CategoryCard
            title="Marketing"
            description="Used for advertising and marketing communications. No marketing technologies are currently loaded."
            enabled={prefs.marketing}
            onToggle={() => toggle('marketing')}
          />
        </div>

        {/* Footer */}
        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '1px solid var(--line)', paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}>
          <button onClick={onClose} className="btn flex-1">Cancel</button>
          <button onClick={() => onSave(prefs)} className="btn-primary flex-1">Save preferences</button>
        </div>
      </div>
    </div>
  );
}

function CategoryCard({ title, description, enabled, onToggle, required, locked }) {
  return (
    <div className="p-4 space-y-2"
      style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--line)', background: 'var(--bg2)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="font-grotesk text-[13px] font-bold" style={{ color: 'var(--ink)' }}>{title}</h3>
          {required && <span className="badge badge-plain">Required</span>}
        </div>
        {!locked && (
          <button
            onClick={onToggle}
            className="relative inline-flex h-[22px] w-10 items-center shrink-0 transition-colors"
            style={{
              borderRadius: 'var(--r-pill)',
              background: enabled ? 'var(--accent)' : 'rgb(var(--tint-rgb) / .18)',
              transitionDuration: 'var(--dur-base)',
            }}
            role="switch"
            aria-checked={enabled}
            aria-label={`${title} cookies`}
          >
            <span
              className="inline-block h-4 w-4 rounded-full"
              style={{
                background: enabled ? 'var(--accent-contrast)' : 'var(--panel)',
                boxShadow: '0 1px 2px rgba(0,0,0,.25)',
                transform: enabled ? 'translateX(21px)' : 'translateX(3px)',
                transition: 'transform var(--dur-base) var(--ease-out), background-color var(--dur-base) ease',
              }}
            />
          </button>
        )}
      </div>
      <p className="t-sub" style={{ fontSize: '.75rem' }}>{description}</p>
    </div>
  );
}
