import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';
import { SUPPORT_EMAIL, BRAND } from '../../data/legal.js';

export default function RefundPolicy() {
  return (
    <LegalPage title="Refund & Cancellation Policy">
      {/* The single most important rule, stated first and visually loud so no
          customer can miss it — this is the whole point of the page. */}
      <div className="rounded-xl border border-[var(--accent)] px-4 py-4" style={{ background: 'var(--accent-soft)' }}>
        <p className="font-bold text-[var(--ink)] text-base" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
          Payments made for {BRAND} subscriptions or services are NON-REFUNDABLE after successful payment.
        </p>
      </div>

      <Section num={1} title="Payments Are Final">
        <ul className="list-disc pl-5 space-y-1">
          <li>Payments are final after successful payment.</li>
          <li>No refund will be provided for unused subscription time.</li>
          <li>No refund will be provided if you stop using {BRAND} after payment.</li>
          <li>No refund will be provided simply because you do not use some or all available features.</li>
        </ul>
      </Section>

      <Section num={2} title="Subscriptions and Cancellation">
        <p>
          Where a recurring subscription exists, cancellation prevents future renewal charges where
          applicable — but it does not automatically refund the already-paid billing period. You keep
          access for the remainder of the period you have already paid for, according to the plan and
          account terms.
        </p>
      </Section>

      <Section num={3} title="Before You Pay">
        <p>
          Please review the applicable service/plan and these terms carefully before completing
          payment, including our <LegalLink to="/terms">Terms &amp; Conditions</LegalLink>. If you
          have questions about what a plan includes, contact us before paying — we're happy to help
          you choose correctly.
        </p>
      </Section>

      <Section num={4} title="Exceptions">
        <p>
          Any refund required by applicable law, or necessary to correct an erroneous or duplicate
          transaction, will be handled in accordance with applicable law and the applicable
          business/payment-provider procedures.
        </p>
        <p>
          If you believe a payment was made in error or was duplicated, contact us as soon as
          possible with your registered email address and payment/order reference.
        </p>
      </Section>

      <Section num={5} title="Contact for Refunds & Cancellations">
        <p>
          For any refund or cancellation request, contact us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>{' '}
          — please include your registered email address and, for payment queries, your payment/order
          reference where applicable.
        </p>
      </Section>
    </LegalPage>
  );
}
