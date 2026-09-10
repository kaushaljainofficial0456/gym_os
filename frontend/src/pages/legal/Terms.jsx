import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';
import { SUPPORT_EMAIL, BRAND } from '../../data/legal.js';

export default function Terms() {
  return (
    <LegalPage title="Terms & Conditions">
      <p>
        These Terms &amp; Conditions ("Terms") govern your access to and use of {BRAND}, a digital
        fitness-management and coaching platform, including its website and applications (collectively,
        the "Service"). By creating an account or using the Service, you agree to these Terms.
      </p>

      <Section num={1} title="Acceptance of Terms">
        <p>
          By accessing or using {BRAND}, creating an account, or clicking "I Agree" where presented,
          you confirm that you have read, understood, and accepted these Terms, along with our{' '}
          <LegalLink to="/privacy">Privacy Policy</LegalLink>. If you do not agree with any part of
          these Terms, you must not use the Service.
        </p>
        <p>
          If you are using the Service on behalf of a gym or organisation, you confirm that you have
          the authority to bind that organisation to these Terms.
        </p>
      </Section>

      <Section num={2} title="Description of Services">
        <p>
          {BRAND} is a software platform for fitness management. It provides tools for workout and
          training management, personalized training programs, nutrition and meal tracking, progress,
          water, sleep, and supplement tracking, trainer-client management, fitness insights and
          analytics, and notifications and reminders. The Service is provided through the{' '}
          {BRAND} website and applications.
        </p>
      </Section>

      <Section num={3} title="Account Registration and Responsibilities">
        <p>You are responsible for:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>Providing accurate, current, and complete information when creating your account, and keeping it up to date.</li>
          <li>Keeping your login credentials secure and confidential.</li>
          <li>All activity that occurs under your account.</li>
          <li>Notifying us promptly if you suspect unauthorized access to your account.</li>
        </ul>
        <p>
          Inaccurate account or profile information may lead to inaccurate tracking, estimates, or
          recommendations within the Service.
        </p>
      </Section>

      <Section num={4} title="Acceptable Use">
        <p>You agree to use the Service only for lawful purposes and in accordance with these Terms.</p>
      </Section>

      <Section num={5} title="Prohibited Activities">
        <p>You must not:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>Use the Service for any unlawful, fraudulent, or harmful purpose.</li>
          <li>Attempt to gain unauthorized access to the Service, other users' accounts, or related systems.</li>
          <li>Interfere with, disrupt, or attempt to circumvent the platform's security or operation.</li>
          <li>Upload or transmit malicious code, viruses, or other harmful content.</li>
          <li>Misuse, copy, reverse engineer, decompile, or create derivative works from the platform or any part of it.</li>
          <li>Scrape, extract, or redistribute data from the Service except as expressly permitted.</li>
          <li>Harass, abuse, or harm other users, or impersonate another person.</li>
        </ul>
      </Section>

      <Section num={6} title="Payments and Subscriptions">
        <p>
          Where a plan or service requires payment, the applicable prices and payment terms are
          displayed before payment, where applicable. By completing a purchase, you agree to pay the
          applicable fees for the plan you selected.
        </p>
        <p>
          Where a subscription renews automatically, cancellation prevents future renewal charges
          where applicable. See the <LegalLink to="/refund-policy">Refund &amp; Cancellation Policy</LegalLink>{' '}
          for details.
        </p>
      </Section>

      <Section num={7} title="Refund and Cancellation Policy">
        <p>
          Our <LegalLink to="/refund-policy">Refund &amp; Cancellation Policy</LegalLink>, which forms
          part of these Terms, explains how refunds and cancellations are handled. Please review it
          before completing any payment.
        </p>
      </Section>

      <Section num={8} title="Fitness and Health Disclaimer">
        <div className="rounded-lg border border-[var(--line)] bg-[var(--bg2)] px-4 py-3">
          <p className="font-semibold text-[var(--ink)]" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
            {BRAND} provides fitness-management tools and informational features. It does not replace
            professional medical advice, diagnosis, or treatment.
          </p>
        </div>
        <p>
          Content provided through the Service — including workouts, programs, nutrition information,
          calorie and macro estimates, and progress calculations — is for general informational and
          educational purposes only. Always consult an appropriately qualified professional before
          beginning or changing your exercise, nutrition, or health routine, especially if you have a
          medical condition, injury, or are taking medication. Stop exercising and seek professional
          help if you experience pain, dizziness, chest discomfort, or shortness of breath.
        </p>
      </Section>

      <Section num={9} title="User Data and Privacy">
        <p>
          Your use of the Service is also governed by our <LegalLink to="/privacy">Privacy Policy</LegalLink>,
          which explains what information is collected, why, and how it is used, stored, and protected.
          Cookie preferences can be managed through the cookie banner or cookie settings in the app.
        </p>
      </Section>

      <Section num={10} title="Intellectual Property">
        <p>
          The {BRAND} software, branding, design, content, and related intellectual property belong to{' '}
          {BRAND} or its respective licensors and are protected by intellectual property laws. You may
          not copy, reproduce, redistribute, modify, reverse engineer, or misuse any part of the
          platform without prior written permission.
        </p>
      </Section>

      <Section num={11} title="Service Availability">
        <p>
          {BRAND} aims to provide a reliable service, but we cannot guarantee uninterrupted or
          completely error-free availability. Features may occasionally be unavailable, interrupted,
          changed, or discontinued due to maintenance, technical issues, updates, third-party service
          changes, or other circumstances.
        </p>
      </Section>

      <Section num={12} title="Account Suspension and Termination">
        <p>
          We may suspend or terminate an account for misuse, security reasons, violations of these
          Terms, legal requirements, or legitimate operational reasons. Where practical and permitted,
          we will inform you of the reason. You may stop using the Service and request account
          deletion at any time (see the <LegalLink to="/privacy">Privacy Policy</LegalLink>).
        </p>
      </Section>

      <Section num={13} title="Changes to the Service">
        <p>
          We may add, change, or remove features of the Service over time. Where a change materially
          reduces functionality of a paid plan, we will communicate this through the Service or by
          email where appropriate.
        </p>
      </Section>

      <Section num={14} title="Changes to These Terms">
        <p>
          We may update these Terms from time to time. The "Effective date" at the top of this page
          shows when the current version came into force. Material changes may be communicated through
          the Service. Your continued use of the Service after changes are posted constitutes
          acceptance of the revised Terms.
        </p>
      </Section>

      <Section num={15} title="Limitation of Liability">
        <p>
          To the maximum extent permitted by applicable law, the Service is provided "as is" and "as
          available" without warranties of any kind, whether express or implied. In no event shall{' '}
          {BRAND} be liable for any indirect, incidental, special, consequential, or punitive damages
          arising from or related to your use of the Service, including loss of data, loss of profits,
          or personal injury. You remain solely responsible for your own decisions regarding exercise,
          nutrition, and health. Nothing in these Terms is intended to limit any rights that cannot
          legally be waived under applicable law.
        </p>
      </Section>

      <Section num={16} title="Governing Law">
        <p>
          These Terms are governed by the laws of India. Any disputes arising from or relating to
          these Terms or the Service will be subject to the jurisdiction of the competent courts of
          India.
        </p>
      </Section>

      <Section num={17} title="Contact Information">
        <p>
          Questions about these Terms? Contact us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>.
        </p>
      </Section>
    </LegalPage>
  );
}
