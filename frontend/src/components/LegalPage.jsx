import { useNavigate, Link } from 'react-router-dom';
import SiteFooter from './SiteFooter.jsx';
import { BRAND, EFFECTIVE_DATE } from '../data/legal.js';

/**
 * Shared shell for every public legal page: header with back button +
 * brand link home, readable max-width column, and the shared SiteFooter.
 * Exists so the six policy pages can't drift apart visually — each page
 * only supplies its title, effective date, and body sections.
 */
export default function LegalPage({ title, date = EFFECTIVE_DATE, children }) {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
      {/* Header — same back affordance + brand mark the existing public
          pages (PrivacyPolicy.jsx) already use, so navigation feels native. */}
      <header className="flex-shrink-0 px-4 pt-6 pb-4 sm:px-8">
        <div className="max-w-2xl mx-auto flex items-center gap-3 flex-wrap">
          <button
            onClick={() => navigate(-1)}
            className="text-[var(--mute)] hover:text-[var(--ink)] transition-colors text-sm font-grotesk"
          >
            ← Back
          </button>
          <span aria-hidden="true" style={{ color: 'var(--faint)' }}>·</span>
          <Link to="/" className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>
            {BRAND}
          </Link>
        </div>
      </header>

      {/* Document */}
      <main className="flex-1 px-4 sm:px-8 pb-10">
        <div
          className="max-w-2xl mx-auto space-y-7 text-sm leading-relaxed text-[var(--mute)] font-grotesk"
          style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}
        >
          <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
            {title}
          </h1>
          <p className="text-xs text-[var(--faint)] italic">
            Effective date: {date}
          </p>
          {children}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

/** Numbered section with the same H2 style the existing legal pages use. */
export function Section({ num, title, children }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-[var(--ink)] uppercase tracking-wider" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
        {num ? `${num}. ` : ''}{title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** Shared link styling — token-driven accent, readable in both themes. */
export function LegalLink({ to, children }) {
  return (
    <Link to={to} className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-deep)]">
      {children}
    </Link>
  );
}
