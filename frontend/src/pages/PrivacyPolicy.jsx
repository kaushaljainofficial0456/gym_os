import { useNavigate } from 'react-router-dom';

export default function PrivacyPolicy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-6 pb-4 sm:px-8">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="text-[var(--mute)] hover:text-[var(--ink)] transition-colors text-sm"
            style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}
          >
            ← Back
          </button>
          <h1 className="text-xl font-bold text-[var(--ink)]" style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}>
            Privacy Policy
          </h1>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 pb-8">
        <div className="max-w-2xl mx-auto space-y-6 text-sm leading-relaxed text-[var(--mute)]" style={{ fontFamily: 'DM Sans, system-ui, sans-serif' }}>
          <p className="text-xs text-[var(--faint)] italic">
            Last updated: [PLACEHOLDER DATE — requires legal review]
          </p>

          <Section title="1. Introduction">
            <p>This Privacy Policy describes how SK OS collects, uses, stores, and protects your personal information when you use our fitness, workout, nutrition, and gym-management platform.</p>
            <p className="mt-2"><em>[PLACEHOLDER — This Privacy Policy requires review by qualified legal counsel before publication. The actual data practices of SK OS should be accurately described here based on the platform&apos;s implementation.]</em></p>
          </Section>

          <Section title="2. Information We Collect">
            <p>SK OS may collect the following types of information:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li><strong>Account information</strong> — name, email address, phone number</li>
              <li><strong>Profile information</strong> — age, sex, height, weight, fitness goals</li>
              <li><strong>Fitness data</strong> — workouts, exercises, sets, reps, weights, personal records</li>
              <li><strong>Nutrition data</strong> — meals, food logs, calorie and macro tracking</li>
              <li><strong>Progress data</strong> — body measurements, progress photos, weight logs</li>
              <li><strong>Usage data</strong> — how you interact with the platform</li>
            </ul>
          </Section>

          <Section title="3. How We Use Your Information">
            <p>Your information is used to provide and improve the SK OS platform, including personalized fitness recommendations, nutrition tracking, and gym-management features.</p>
          </Section>

          <Section title="4. Data Storage and Security">
            <p>SK OS takes reasonable measures to protect your personal information. Data is stored using industry-standard security practices.</p>
            <p className="mt-2"><em>[PLACEHOLDER — Actual storage details (cloud provider, encryption, retention periods) require accurate disclosure based on the platform&apos;s implementation.]</em></p>
          </Section>

          <Section title="5. Data Sharing">
            <p>SK OS does not sell your personal information. Data may be shared with:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Your assigned trainer (for client accounts within a gym)</li>
              <li>Gym owners/administrators (for organization management)</li>
              <li>Service providers that help operate the platform</li>
            </ul>
          </Section>

          <Section title="6. Your Rights">
            <p>Depending on applicable law, you may have rights to access, correct, delete, or export your personal data. Contact us to exercise these rights.</p>
          </Section>

          <Section title="7. Contact">
            <p><em>[PLACEHOLDER — Contact email/address for privacy inquiries requires accurate information.]</em></p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-2">
      <h2
        className="text-sm font-bold text-[var(--ink)] uppercase tracking-wider"
        style={{ fontFamily: 'Satoshi, system-ui, sans-serif' }}
      >
        {title}
      </h2>
      <div className="text-[var(--mute)]">
        {children}
      </div>
    </div>
  );
}
