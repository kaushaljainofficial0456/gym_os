import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';
import { SUPPORT_EMAIL, BRAND } from '../../data/legal.js';

export default function ShippingPolicy() {
  return (
    <LegalPage title="Shipping Policy">
      <p>
        {BRAND} provides digital software and online fitness-management services. We do not sell or
        ship physical products. Therefore, physical shipping is not applicable to {BRAND} services.
      </p>
      <p>
        After successful payment, access to the applicable digital service is provided electronically
        according to the purchased plan and account terms.
      </p>

      <Section num={1} title="No Physical Products">
        <ul className="list-disc pl-5 space-y-1">
          <li>No physical products are shipped.</li>
          <li>No courier or delivery service is involved.</li>
          <li>Digital service access is provided electronically.</li>
        </ul>
      </Section>

      <Section num={2} title="Access Issues">
        <p>
          If you experience any issue accessing your digital service after payment, contact support
          at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>{' '}
          — please include your registered email address and payment/order reference where
          applicable. See also our <LegalLink to="/refund-policy">Refund &amp; Cancellation Policy</LegalLink>.
        </p>
      </Section>
    </LegalPage>
  );
}
