import { Link } from 'react-router-dom';
import { SUPPORT_EMAIL, BRAND, TAGLINE, FOOTER_LINKS } from '../data/legal.js';

/**
 * Public footer — the one shared footer for the public-facing surface
 * (login/welcome page + legal pages). Reads every string from data/legal.js
 * so the email and link list can never drift between pages.
 *
 * Kept deliberately quiet: hairline separators and token-driven colors only,
 * so it reads as part of the page rather than a slab bolted onto it.
 * No fixed/absolute positioning anywhere — it sits in normal flow and can
 * never overlap or cover existing content (login form, cookie banner, etc).
 */
export default function SiteFooter({ className = '' }) {
  return (
    <footer className={`w-full border-t border-[var(--line)] ${className}`} style={{ background: 'var(--bg2)' }}>
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-7 text-center space-y-3">
        {/* Brand + tagline */}
        <div>
          <div className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>{BRAND}</div>
          <div className="text-[10px] uppercase tracking-[.2em] font-grotesk mt-0.5" style={{ color: 'var(--faint)' }}>
            {TAGLINE}
          </div>
        </div>

        {/* Policy links — inline-wrapped so they flow naturally on mobile */}
        <nav aria-label="Legal and company" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-xs font-grotesk">
          {FOOTER_LINKS.map((link, i) => (
            <span key={link.to} className="inline-flex items-center gap-x-2">
              {i > 0 && <span aria-hidden="true" style={{ color: 'var(--faint)' }}>·</span>}
              <Link
                to={link.to}
                className="hover:underline underline-offset-2 transition-colors"
                style={{ color: 'var(--mute)' }}
              >
                {link.label}
              </Link>
            </span>
          ))}
        </nav>

        {/* Contact + copyright */}
        <div className="text-[11px] font-grotesk space-y-1">
          <p>
            Support:{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: 'var(--accent)' }}>
              {SUPPORT_EMAIL}
            </a>
          </p>
          <p style={{ color: 'var(--faint)' }}>© 2026 {BRAND}. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
