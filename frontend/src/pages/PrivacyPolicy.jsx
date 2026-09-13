import Privacy from './legal/Privacy.jsx';

// The original placeholder version of this page (sections full of
// "[PLACEHOLDER — requires legal review]") has been superseded by the full
// policy in pages/legal/Privacy.jsx. This file stays as a thin re-export so
// every existing link to /privacy-policy — LegalConsent.jsx opens it in new
// tabs, App.jsx's route, the catch-all exemption comments — keeps working
// unchanged, and /privacy-policy and /privacy always show the same policy.
export default function PrivacyPolicy() {
  return <Privacy />;
}
