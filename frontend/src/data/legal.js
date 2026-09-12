// Single source of truth for every public legal/contact page so the email,
// brand and dates can never drift between pages. Pages import from here
// rather than hard-coding strings -- a future email/date update is a
// one-line change instead of a six-file sweep.

export const SUPPORT_EMAIL = 'skventures1111@gmail.com';

/* Barbell, not SK OS. The product was renamed on main (see the rebrand
   commits) before this legal work merged, so these pages arrived naming
   the old product -- on the Terms and Privacy pages of all places, where
   the company's own name is the one thing that has to be right. This
   file already existed to stop exactly that kind of drift; the remaining
   hard-coded mentions now read from it. */
export const BRAND = 'Barbell';

export const TAGLINE = 'Your Fitness Business, Engineered.';

// The date these policies were first published. (Told to make up nothing:
// today's date is a fact, a legal-review date is not.)
export const EFFECTIVE_DATE = '9 September 2026';

// Footer link list — the exact routes the public reviewer must be able to
// reach without logging in. No Pricing entry: Barbell pricing is handled
// privately/custom and must not be publicly displayed.
export const FOOTER_LINKS = [
  { label: 'About Us', to: '/about' },
  { label: 'Contact Us', to: '/contact' },
  { label: 'Terms & Conditions', to: '/terms' },
  { label: 'Privacy Policy', to: '/privacy' },
  { label: 'Refund & Cancellation Policy', to: '/refund-policy' },
  { label: 'Shipping Policy', to: '/shipping-policy' },
];
