import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';
import { SUPPORT_EMAIL, BRAND, TAGLINE } from '../../data/legal.js';

export default function Contact() {
  return (
    <LegalPage title="Contact Us">
      <p className="text-base text-[var(--ink)] font-semibold" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
        We're here to help.
      </p>

      <p>
        For questions regarding {BRAND}, account access, subscriptions, payments, technical issues,
        or general support, please contact us.
      </p>

      <Section title="Email">
        <p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>
        </p>
      </Section>

      <Section title="Business / Support Hours">
        <p>
          Monday – Friday
          <br />
          10:00 AM – 6:00 PM IST
        </p>
      </Section>

      <Section title="Payment & billing queries">
        <p>
          For payment or billing-related queries, customers should include their registered email
          address and payment/order reference where applicable.
        </p>
      </Section>

      <Section title="Response time">
        <p>We aim to respond to support requests within 1–2 business days.</p>
      </Section>

      <p className="pt-2">
        <span className="font-brand font-bold text-sm" style={{ color: 'var(--ink)' }}>{BRAND}</span>
        <br />
        <span className="text-[10px] uppercase tracking-[.2em] font-grotesk" style={{ color: 'var(--faint)' }}>
          {TAGLINE}
        </span>
      </p>

      <Section title="Related policies">
        <p>
          <LegalLink to="/terms">Terms &amp; Conditions</LegalLink> · <LegalLink to="/privacy">Privacy Policy</LegalLink> ·{' '}
          <LegalLink to="/refund-policy">Refund &amp; Cancellation Policy</LegalLink> ·{' '}
          <LegalLink to="/shipping-policy">Shipping Policy</LegalLink>
        </p>
      </Section>
    </LegalPage>
  );
}
