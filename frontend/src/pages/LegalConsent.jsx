import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, HeartPulse, Calculator, ShieldCheck, LockKeyhole } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import AuthShell from '../components/auth/AuthShell.jsx';
import '../components/auth/auth-flow.css';
import { AuthTitle, Cta } from '../components/auth/authKit.jsx';
import { takeAfterTerms } from '../afterTerms.js';

const TERMS_VERSION = '1.0';
const HEADLINE = [{ text: 'Train hard.' }, { text: 'Train safe.', accent: true }];

/* The four things the terms actually ask of someone, in plain words, ahead
   of the full text -- which stays one tap away and is what they agree to. */
const POINTS = [
  [HeartPulse, 'Not medical advice', 'Check with a professional before changing your training or diet.'],
  [Calculator, 'Numbers are estimates', 'Calories, macros and targets are close, never exact.'],
  [ShieldCheck, 'Train safely', 'Know your limits, and stop if anything hurts.'],
  [LockKeyhole, 'Your data stays yours', 'How it is handled is in the Privacy Policy.'],
];

export default function LegalConsent() {
  const { acceptTerms } = useAuth();
  const navigate = useNavigate();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [full, setFull] = useState(false);

  const handleAccept = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    try {
      await acceptTerms();
      navigate(takeAfterTerms(), { replace: true });
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell variant="compact" headline={HEADLINE}>
      <AuthTitle eyebrow="Before you start" title="One last thing" sub={`Barbell's terms, in short (version ${TERMS_VERSION}).`} />

      <ul className="auth-points">
        {POINTS.map(([I, title, line]) => (
          <li key={title}>
            <I size={18} strokeWidth={1.5} aria-hidden="true" />
            <div><strong>{title}</strong><span>{line}</span></div>
          </li>
        ))}
      </ul>

      <button type="button" className="auth-disclose" aria-expanded={full} onClick={() => setFull((v) => !v)}>
        Read the full terms
        <ChevronDown size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {full && (
        <div className="auth-terms" tabIndex={0} aria-label="Terms and Conditions">
          <div className="space-y-6 text-sm leading-relaxed text-[var(--mute)]">
    {/* 1 ─ Acceptance of Terms */}
    <Section num={1} title="Acceptance of Terms">
      <p>By creating an account, using Barbell, or selecting &quot;I Agree,&quot; you confirm that you have read, understood, and accepted these Terms &amp; Conditions along with our <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-deep)]">Privacy Policy</a>. If you do not agree, please do not use Barbell.</p>
    </Section>

    {/* 2 ─ Account Responsibility */}
    <Section num={2} title="Account Responsibility">
      <p>You are responsible for:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1">
        <li>Providing accurate and up-to-date information when creating your account.</li>
        <li>Keeping your login credentials secure and confidential.</li>
        <li>All activity that occurs under your account.</li>
      </ul>
      <p className="mt-2">If you suspect unauthorized access to your account, notify us promptly. Inaccurate information you provide may lead to inaccurate recommendations or tracking.</p>
    </Section>

    {/* 3 ─ Fitness & Exercise Disclaimer */}
    <Section num={3} title="Fitness &amp; Exercise Disclaimer">
      <div className="rounded-lg border border-[var(--line)] bg-[var(--bg2)] px-4 py-3 mb-2">
        <p className="font-semibold text-[var(--ink)]">Barbell is a fitness information tool — it is not a medical professional.</p>
      </div>
      <p>Workouts, exercises, programs, and training information provided through Barbell are for general informational and educational purposes. This information is <strong>not</strong> a substitute for advice from:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1">
        <li>A doctor or healthcare professional</li>
        <li>A physiotherapist or physical therapist</li>
        <li>A certified fitness professional or personal trainer</li>
        <li>A nutritionist, dietitian, or other qualified specialist</li>
      </ul>
      <p className="mt-2">Always consult an appropriately qualified professional before beginning or changing your exercise, nutrition, or health routine — especially if you have a medical condition, injury, pregnancy, or are taking medication.</p>
    </Section>

    {/* 4 ─ Nutrition, Calories & Other Estimates */}
    <Section num={4} title="Nutrition, Calories &amp; Other Estimates">
      <div className="rounded-lg border border-[var(--line)] bg-[var(--bg2)] px-4 py-3 mb-2">
        <p className="font-semibold text-[var(--ink)]">Many values in Barbell are estimates, not exact measurements.</p>
      </div>
      <p>Nutrition information, calorie estimates, macronutrient breakdowns, food recognition, portion estimates, AI-generated food data, workout recommendations, progress calculations, measurements, targets, and similar outputs may be approximate and may contain errors.</p>
      <p className="mt-2">Actual values can vary based on brand, recipe, preparation method, serving size, ingredient variation, database source, regional differences, and incomplete user input. Never treat Barbell calculations as medically precise or guaranteed.</p>
      <p className="mt-2">Verify important nutritional or health information from reliable sources, product labels, or qualified professionals where appropriate.</p>
    </Section>

    {/* 5 ─ Exercise & Safety */}
    <Section num={5} title="Exercise &amp; Safety">
      <p>You are responsible for exercising safely. This includes:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1">
        <li>Using equipment correctly and following proper form.</li>
        <li>Understanding your own physical limitations and fitness level.</li>
        <li>Starting at an appropriate intensity and progressing gradually.</li>
        <li><strong>Stopping immediately</strong> if you experience pain, dizziness, chest discomfort, shortness of breath, or any other concerning symptoms — and seeking professional help.</li>
      </ul>
      <p className="mt-2">Barbell does not monitor your physical condition in real time. You exercise at your own risk.</p>
    </Section>

    {/* 6 ─ No Guarantee of Results */}
    <Section num={6} title="No Guarantee of Results">
      <p>Barbell does not guarantee any specific fitness, weight-loss, muscle-gain, health, performance, or other results. Individual results vary widely based on genetics, consistency, effort, nutrition, sleep, stress, and many other factors beyond the app&apos;s control.</p>
      <p className="mt-2">Any examples, testimonials, or general information shown in the app should not be interpreted as a promise or guarantee of results.</p>
    </Section>

    {/* 7 ─ App Information & Accuracy */}
    <Section num={7} title="App Information &amp; Accuracy">
      <p>While reasonable efforts are made to provide useful and accurate information, Barbell may contain errors, outdated information, omissions, technical limitations, or estimates. We do not promise that every piece of information will always be completely accurate, complete, or available.</p>
      <p className="mt-2">Exercise and nutrition information in the app should be independently verified where accuracy is important to you.</p>
    </Section>

    {/* 8 ─ App Availability */}
    <Section num={8} title="App Availability">
      <p>Features may occasionally be unavailable, interrupted, changed, or discontinued due to maintenance, technical issues, updates, third-party service changes, or other circumstances. We make reasonable efforts to minimize disruptions but do not guarantee uninterrupted access to the platform.</p>
    </Section>

    {/* 9 ─ User Conduct */}
    <Section num={9} title="User Conduct">
      <p>You agree not to:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1">
        <li>Use Barbell for any unlawful or fraudulent purpose.</li>
        <li>Attempt unauthorized access to the platform, other users&apos; accounts, or related systems.</li>
        <li>Abuse, harass, or harm other users.</li>
        <li>Interfere with or disrupt the platform&apos;s functionality or security.</li>
        <li>Scrape, extract, or redistribute data from the platform where prohibited.</li>
        <li>Impersonate another person or misrepresent your identity.</li>
      </ul>
      <p className="mt-2">We reserve the right to suspend or terminate accounts that violate these terms.</p>
    </Section>

    {/* 10 ─ Intellectual Property */}
    <Section num={10} title="Intellectual Property">
      <p>Barbell, including its original content, branding, interface design, software, features, and materials, is owned by Barbell or its applicable rights holders and is protected by intellectual property laws.</p>
      <p className="mt-2">You may not copy, reproduce, redistribute, modify, create derivative works from, or misuse any part of the platform without prior written permission.</p>
    </Section>

    {/* 11 ─ Privacy &amp; Cookies */}
    <Section num={11} title="Privacy &amp; Cookies">
      <p>Your use of Barbell is also governed by our <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-deep)]">Privacy Policy</a>, which explains how personal data is collected, used, stored, and protected.</p>
      <p className="mt-2">Cookie preferences are managed separately and can be adjusted at any time through the app&apos;s cookie settings.</p>
    </Section>

    {/* 12 ─ Limitation of Liability */}
    <Section num={12} title="Limitation of Liability">
      <p>To the maximum extent permitted by applicable law, Barbell is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, and non-infringement.</p>
      <p className="mt-2">In no event shall Barbell, its operators, or contributors be liable for any indirect, incidental, special, consequential, or punitive damages arising from or related to your use of the platform, including but not limited to loss of data, loss of profits, or personal injury.</p>
      <p className="mt-2">You remain solely responsible for your own decisions regarding exercise, nutrition, and health. Nothing in these terms is intended to limit any rights that cannot legally be waived under applicable law.</p>
    </Section>

    {/* 13 ─ Changes to Terms */}
    <Section num={13} title="Changes to Terms">
      <p>We may update these Terms &amp; Conditions from time to time. When terms are materially changed, you may be required to review and accept the updated version before continuing to use the platform.</p>
      <p className="mt-2">Your continued use after changes are posted — or after re-accepting updated terms — constitutes acceptance of the revised Terms &amp; Conditions.</p>
    </Section>

    {/* 14 ─ Contact */}
    <Section num={14} title="Contact">
      <p>If you have questions about these Terms &amp; Conditions, please reach out to us:</p>
      <p>
        Email us at{' '}
        <a href="mailto:skventures1111@gmail.com" className="text-[var(--accent)] underline underline-offset-2 break-all">
          skventures1111@gmail.com
        </a>
      </p>
    </Section>
          </div>
        </div>
      )}

      <label className="auth-check">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          aria-label="I have read and agree to the Terms &amp; Conditions"
        />
        <span>
          I have read and agree to the Terms &amp; Conditions and acknowledge the{' '}
          <a href="/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
        </span>
      </label>

      <Cta onClick={handleAccept} busy={submitting} disabled={!agreed}>I Agree &amp; Continue</Cta>
    </AuthShell>
  );
}

function Section({ num, title, children }) {
  return (
    <div className="space-y-2">
      <h2
        className="text-sm font-bold text-[var(--ink)] uppercase tracking-wider"
      >
        {num}. {title}
      </h2>
      <div className="text-[var(--mute)]">
        {children}
      </div>
    </div>
  );
}
