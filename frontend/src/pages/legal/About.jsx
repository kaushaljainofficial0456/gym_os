import LegalPage, { Section, LegalLink } from '../../components/LegalPage.jsx';

const FEATURES = [
  'Workout and training management',
  'Personalized training programs',
  'Nutrition and meal tracking',
  'Progress tracking',
  'Water tracking',
  'Sleep tracking',
  'Supplement tracking',
  'Trainer-client management',
  'Fitness insights and analytics',
  'Notifications and reminders',
];

export default function About() {
  return (
    <LegalPage title="About Us">
      <p>
        SK OS is a modern fitness management and coaching platform designed to help gyms, trainers,
        coaches, and clients manage fitness in one connected system.
      </p>

      <Section title="What SK OS brings together">
        <p>SK OS brings together:</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          {FEATURES.map((f) => <li key={f}>{f}</li>)}
        </ul>
      </Section>

      <Section title="Our goal">
        <p>
          The goal of SK OS is to make fitness management more organized, measurable, and easier to
          manage for fitness professionals and their clients.
        </p>
      </Section>

      <Section title="Get in touch">
        <p>
          Have questions about SK OS? Visit the <LegalLink to="/contact">Contact Us</LegalLink> page
          or read our <LegalLink to="/terms">Terms &amp; Conditions</LegalLink> and{' '}
          <LegalLink to="/privacy">Privacy Policy</LegalLink>.
        </p>
      </Section>
    </LegalPage>
  );
}
