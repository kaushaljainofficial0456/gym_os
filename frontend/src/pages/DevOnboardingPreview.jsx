/**
 * /dev/onboarding — development-only preview of the onboarding wizard.
 *
 * Renders the OnboardingWizard in always-open mode so the age/height/weight
 * scroll-wheel selectors can be tested without a fresh account.
 * Deliberately unauthenticated and outside the app shell.
 *
 * THIS PAGE MUST NOT BE DEPLOYED TO PRODUCTION.
 */
import OnboardingWizard from '../components/OnboardingWizard.jsx';

export default function DevOnboardingPreview() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* The wizard itself is a fixed fullscreen overlay, so we just
          mount it open. onComplete is a no-op — this is preview-only. */}
      <OnboardingWizard
        open
        onComplete={() => {
          // eslint-disable-next-line no-alert
          alert('Onboarding complete! (dev preview — no data saved)');
        }}
        initialName="Test User"
      />

      {/* Subtle corner badge so this page is obviously dev-only */}
      <div
        className="fixed top-3 right-3 z-[100] px-3 py-1.5 rounded-full font-grotesk text-[10px] font-bold uppercase tracking-wider"
        style={{
          background: 'rgb(var(--bad-rgb) / .15)',
          border: '1px solid rgb(var(--bad-rgb) / .3)',
          color: 'rgb(var(--bad-rgb))',
        }}
      >
        DEV ONLY — /dev/onboarding
      </div>
    </div>
  );
}
