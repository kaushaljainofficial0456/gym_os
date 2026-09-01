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

function CookieBanner({ onAcceptAll, onRejectOptional, onManage }) {
  return (
    <div
      className="fixed bottom-0 inset-x-0 z-50 p-3 sm:p-4 anim-fadeUp"
      style={{ animationDuration: '0.35s' }}
    >
      <div
        className="max-w-2xl mx-auto rounded-2xl border border-[var(--line)] px-4 py-4 sm:px-6 sm:py-5 space-y-3"
        style={{
          background: 'var(--panel)',
          boxShadow: '0 -8px 32px rgba(0,0,0,.35), 0 0 0 1px rgba(255,223,221,.04)',
        }}
      >
        <p className="text-sm text-[var(--ink)] leading-relaxed" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
          SK OS uses cookies and similar technologies to operate the service, remember preferences, understand usage, and where applicable, support optional analytics or marketing.
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={onAcceptAll} className="btn-primary text-xs px-4 py-2 rounded-full">
            Accept all
          </button>
          <button onClick={onRejectOptional} className="btn text-xs px-4 py-2 rounded-full">
            Reject optional
          </button>
          <button onClick={onManage} className="btn-ghost text-xs px-3 py-2 rounded-full">
            Manage preferences
          </button>
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 anim-fadeIn" />

      {/* Modal */}
      <div
        className="relative w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-[var(--line)] anim-scaleIn"
        style={{ background: 'var(--panel)', boxShadow: '0 24px 48px -24px rgba(0,0,0,.6)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--line)]">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-[var(--ink)]" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
              Cookie Preferences
            </h2>
            <button onClick={onClose} className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-lg leading-none px-1" aria-label="Close">✕</button>
          </div>
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
        <div className="px-5 py-4 border-t border-[var(--line)] flex gap-2">
          <button onClick={onClose} className="btn flex-1 text-xs py-2.5 rounded-full">
            Cancel
          </button>
          <button
            onClick={() => onSave(prefs)}
            className="btn-primary flex-1 text-xs py-2.5 rounded-full"
          >
            Save preferences
          </button>
        </div>
      </div>
    </div>
  );
}

function CategoryCard({ title, description, enabled, onToggle, required, locked }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--bg2)] p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[var(--ink)]" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
            {title}
          </h3>
          {required && (
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)]" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
              Required
            </span>
          )}
        </div>
        {!locked && (
          <button
            onClick={onToggle}
            className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200"
            style={{
              background: enabled ? 'var(--accent)' : 'rgb(var(--tint-rgb) / .15)',
            }}
            role="switch"
            aria-checked={enabled}
            aria-label={`${title} cookies`}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200"
              style={{ transform: enabled ? 'translateX(18px)' : 'translateX(3px)' }}
            />
          </button>
        )}
      </div>
      <p className="text-xs text-[var(--mute)] leading-relaxed" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
        {description}
      </p>
    </div>
  );
}
