import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';
import { SUPPORT_EMAIL, BRAND } from '../../data/legal.js';

// Written against what the platform ACTUALLY collects (see database/schema.sql,
// frontend auth/cookie code): no claims about data-residency country, no
// security certifications, no analytics trackers (none are loaded — the cookie
// banner marks Analytics/Marketing as "not currently loaded").
export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This Privacy Policy explains how {BRAND} ("we", "us") collects, uses, stores, and protects
        information when you use our fitness-management and coaching platform, including the website
        and applications (collectively, the "Service"). It applies to everyone who uses the Service —
        gym owners, trainers, and clients alike.
      </p>

      <Section num={1} title="Information We Collect">
        <p>Depending on how you use the Service, we may collect:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li><strong>Account information</strong> — name, email address, phone number (optional), role, and organisation/gym membership.</li>
          <li><strong>Authentication information</strong> — your password is stored only as a secure hash; we never store it in plain text.</li>
          <li><strong>Fitness profile information</strong> — age, sex, height, weight, goals, experience, equipment access, diet type, food exclusions, and any medical notes, injuries, or movements-to-avoid you or your trainer record.</li>
          <li><strong>Workout and training data</strong> — workouts, exercises, sets, reps, weights, personal records, and assigned training programs.</li>
          <li><strong>Nutrition and meal data</strong> — meals, food logs, calorie and macro tracking, meal plans, and nutrition preferences.</li>
          <li><strong>Progress data</strong> — weight logs, body measurements, and progress photos you upload.</li>
          <li><strong>Water, sleep, and supplement data</strong> — daily water and sleep logs and supplement entries.</li>
          <li><strong>Messages and notifications</strong> — messages between trainers and clients, plus notification preferences and delivery information.</li>
          <li><strong>Payment-related information</strong> — subscription/package records and payment references (such as order IDs) needed to keep accounts and entitlements in sync. Card numbers and similar payment credentials are handled by the payment processor, not stored by {BRAND}.</li>
          <li><strong>Usage information</strong> — how you interact with the Service (for example, feature usage and preferences).</li>
          <li><strong>Device and browser information</strong> — basic technical information your browser provides when you use the Service.</li>
          <li><strong>Cookies and similar technologies</strong> — essential cookies/local storage for sign-in and security, and preference storage (for example, theme and cookie-consent choices). See Section 8.</li>
        </ul>
      </Section>

      <Section num={2} title="Why We Collect It">
        <p>We collect this information to:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>Create and manage your account and authenticate you securely.</li>
          <li>Provide the core Service — training, nutrition, tracking, and progress features.</li>
          <li>Let trainers and gym owners manage and support the clients in their organisation.</li>
          <li>Show insights, analytics, reminders, and notifications.</li>
          <li>Process payments and subscriptions, and keep billing records accurate.</li>
          <li>Provide support and respond to your requests.</li>
          <li>Maintain the security, integrity, and availability of the Service.</li>
        </ul>
      </Section>

      <Section num={3} title="How We Use Information">
        <p>
          We use the information collected only for the purposes described in this policy. We do not
          use your fitness or health-related data to build advertising profiles. Where we use
          automated calculations (for example calorie or macro estimates), these are estimates to
          support your training — they are not medical advice and may be imprecise.
        </p>
      </Section>

      <Section num={4} title="Who Can See Your Data">
        <p>The Service is built around a gym/trainer/client structure:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li><strong>Your trainer</strong> can see the training, nutrition, and progress data of clients assigned to them.</li>
          <li><strong>Gym owners/administrators</strong> can see organisation-level management data for their gym.</li>
          <li><strong>Other members of the community features</strong> can see only what you choose to share there.</li>
        </ul>
        <p>
          Access controls within the Service enforce these boundaries — users can only access data
          belonging to their own organisation and role.
        </p>
      </Section>

      <Section num={5} title="How Information Is Stored and Protected">
        <p>
          Account data is stored in the Service's databases and associated storage. Your password is
          stored only as a salted hash, and authentication uses secure, HTTP-only session cookies.
          Access to data inside the Service is restricted by role- and organisation-level access
          controls.
        </p>
        <p>
          We take reasonable technical and organisational measures to protect personal information.
          No method of storage or transmission over the internet is completely secure, and we cannot
          guarantee absolute security.
        </p>
      </Section>

      <Section num={6} title="Payment Processing">
        <p>
          Payments are processed by third-party payment providers. Payment credentials (such as card
          numbers) are collected and handled by the payment provider's own checkout, not by {BRAND}.
          We retain only the records needed to link a payment to your account and plan — for example
          order references, amounts, and status — so that your subscription and access work correctly
          and support queries can be resolved.
        </p>
      </Section>

      <Section num={7} title="When We Share Information">
        <p>
          We do not sell your personal information. We share information only:
        </p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>With the trainer and gym organisation you belong to, as described in Section 4.</li>
          <li>With service providers who help us operate the Service (for example hosting, storage, email delivery, and payment processing), under obligations to process it on our behalf.</li>
          <li>Where required by law, regulation, or valid legal process.</li>
          <li>To protect the rights, property, or safety of {BRAND}, its users, or the public.</li>
        </ul>
      </Section>

      <Section num={8} title="Cookies and Similar Technologies">
        <p>
          The Service uses cookies and similar browser-storage technologies for:
        </p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li><strong>Essential</strong> — keeping you signed in and keeping the Service secure. These cannot be disabled.</li>
          <li><strong>Preferences</strong> — remembering choices such as theme and onboarding/tour state.</li>
        </ul>
        <p>
          You are shown a cookie consent banner on first use and can change your preferences at any
          time via the cookie settings in the app. No analytics or marketing trackers are currently
          loaded by the Service.
        </p>
      </Section>

      <Section num={9} title="Data Retention">
        <p>
          We keep personal information for as long as your account is active, or as long as needed to
          provide the Service, comply with legal obligations, resolve disputes, and maintain records
          (including billing records where required). Data you delete may persist in backups for a
          limited period before being fully removed.
        </p>
      </Section>

      <Section num={10} title="Account Deletion and Data Deletion Requests">
        <p>
          You can request deletion of your account and personal data by contacting us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>{' '}
          using your registered email address. We will action verified requests within a reasonable
          timeframe, subject to any legal retention requirements (for example billing records). Some
          data linked to your gym's records may be retained in anonymised or aggregated form.
        </p>
      </Section>

      <Section num={11} title="Your Privacy Rights">
        <p>
          Depending on applicable law, you may have rights to access, correct, update, or delete your
          personal data, object to or restrict certain processing, and withdraw consent (for example
          for optional cookies). To exercise these rights, contact us using the details below. We may
          need to verify your identity before acting on a request.
        </p>
      </Section>

      <Section num={12} title="Children">
        <p>
          The Service is not directed at children, and accounts are intended for use by adults. If
          you believe a minor has provided personal information through the Service, please contact
          us so we can remove it.
        </p>
      </Section>

      <Section num={13} title="Changes to This Policy">
        <p>
          We may update this Privacy Policy from time to time. The "Effective date" at the top of
          this page shows when the current version came into force. Material changes will be
          communicated through the Service where appropriate.
        </p>
      </Section>

      <Section num={14} title="Contact Us">
        <p>
          Questions about this Privacy Policy or your data? Contact us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[var(--accent)] underline underline-offset-2 break-all">
            {SUPPORT_EMAIL}
          </a>. See also our <LegalLink to="/terms">Terms &amp; Conditions</LegalLink>.
        </p>
      </Section>
    </LegalPage>
  );
}
