// Single source of truth for every public legal/contact page so the email,
// brand and dates can never drift between pages. Pages import from here
// rather than hard-coding strings -- a future email/date update is a
// one-line change instead of a six-file sweep.

export const SUPPORT_EMAIL = 'skventures1111@gmail.com';

export const BRAND = 'SK OS';

export const TAGLINE = 'Your Fitness Business, Engineered.';

// The date these policies were first published. (Told to make up nothing:
// today's date is a fact, a legal-review date is not.)
export const EFFECTIVE_DATE = '9 September 2026';

// Footer link list — the exact routes the public reviewer must be able to
// reach without logging in. No Pricing entry: SK OS pricing is handled
// privately/custom and must not be publicly displayed.
export const FOOTER_LINKS = [
  { label: 'About Us', to: '/about' },
  { label: 'Contact Us', to: '/contact' },
  { label: 'Terms & Conditions', to: '/terms' },
  { label: 'Privacy Policy', to: '/privacy' },
  { label: 'Refund & Cancellation Policy', to: '/refund-policy' },
  { label: 'Shipping Policy', to: '/shipping-policy' },
];
