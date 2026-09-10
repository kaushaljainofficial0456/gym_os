/**
 * /design — live showcase for the SK OS design system.
 *
 * WHY A ROUTE AND NOT A STATIC DOC
 * A colour swatch in a markdown file is a screenshot of a decision. This
 * page renders the REAL components against the REAL theme, so switching
 * light/dark or shrinking the window shows what actually happens rather
 * than what was intended. It is also the fastest way to catch a token
 * regression: if `bg-panel` stops theming, this page shows it instantly.
 *
 * Deliberately unauthenticated and outside the app shell, so it can be
 * opened without a login and does not inherit layout chrome.
 *
 * Written for Manavi — every block is copy-pasteable.
 */
import { useState } from 'react';
import {
  cn, Reveal, Stagger, Tilt, Pressable, AnimatedNumber,
  AmbientBackdrop, easing, duration, spring, radius, brand, status, statusLight,
} from '../design/index.js';
import { Card, Kpi, Ring, Bar, StatusChip, Seg, Empty, Spinner, MacroPill } from '../components/UI.jsx';
import PaymentResult from '../components/PaymentResult.jsx';

/**
 * Sample data for the showcase below. This is the ONE place in the
 * codebase where receipt values are invented, and it is labelled as a
 * sample on screen — every real caller passes figures that came from a
 * payment_orders row. See ReceiptPrinterAnimation.jsx's header for why
 * that distinction is enforced rather than merely intended.
 */
const SAMPLE_RECEIPT = {
  gymName: 'Sample Gym',
  number: 'SAMPLE-0001',
  date: '01 Jan 2026',
  currency: 'INR',
  items: [{ label: 'Sample plan — 3 months', amount: 4500 }],
  method: 'Sample method',
  transactionId: 'sample_txn_0000',
  total: 4500,
};

const PAYMENT_STATES = ['processing', 'verifying', 'success', 'failed', 'cancelled', 'refund_pending', 'refunded'];
const RECEIPT_STATES = ['ready', 'generating', 'error', 'none'];

function PaymentResultDemo() {
  const [payment, setPayment] = useState('success');
  const [receipt, setReceipt] = useState('ready');
  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-5 items-start">
      <div className="space-y-4">
        <div>
          <div className="t-micro mb-2">Payment state</div>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_STATES.map((s) => (
              <button key={s} onClick={() => setPayment(s)}
                className={`badge ${payment === s ? 'badge-accent' : 'badge-plain'}`}
                style={{ cursor: 'pointer' }}>{s}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="t-micro mb-2">Receipt state</div>
          <div className="flex flex-wrap gap-1.5">
            {RECEIPT_STATES.map((s) => (
              <button key={s} onClick={() => setReceipt(s)}
                className={`badge ${receipt === s ? 'badge-accent' : 'badge-plain'}`}
                style={{ cursor: 'pointer' }}>{s}</button>
            ))}
          </div>
        </div>
        <p className="t-sub" style={{ fontSize: '.6875rem' }}>
          Set payment to <code>success</code> and receipt to <code>error</code> — the headline
          stays &ldquo;Payment successful&rdquo;.
        </p>
      </div>
      <Card className="p-6">
        <PaymentResult
          key={`${payment}-${receipt}`}
          payment={payment}
          receipt={receipt === 'none' ? undefined : receipt}
          amountLabel="₹4,500"
          purchase="Sample plan — 3 months"
          method="Sample method"
          transactionId="sample_txn_0000"
          receiptData={receipt === 'none' ? undefined : SAMPLE_RECEIPT}
          onViewReceipt={() => {}}
          onDownloadReceipt={() => {}}
          onRetryPayment={() => {}}
          onRetryReceipt={() => {}}
          onDone={() => {}}
        />
      </Card>
    </div>
  );
}

function Section({ title, note, children }) {
  return (
    <section className="mb-14">
      <h2 className="font-display font-bold text-lg mb-1" style={{ color: 'var(--ink)' }}>
        {title}
      </h2>
      {note && (
        <p className="text-xs mb-4 max-w-2xl leading-relaxed" style={{ color: 'var(--mute)' }}>
          {note}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Swatch({ name, cssVar, hex }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-11 h-11 rounded-xl border shrink-0"
        style={{ background: cssVar, borderColor: 'var(--line)' }}
      />
      <div className="min-w-0">
        <div className="font-grotesk text-xs font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {name}
        </div>
        <div className="text-[10px] font-mono truncate" style={{ color: 'var(--faint)' }}>
          {hex}
        </div>
      </div>
    </div>
  );
}

export default function DesignSystem() {
  const [tab, setTab] = useState('all');
  const [count, setCount] = useState(1840);
  const isLight =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('light');
  const palette = isLight ? brand.light : brand.dark;
  // The status swatches label themselves with the theme's ACTUAL values —
  // light mode darkens good/warn/bad to clear AA as text (see tokens.js).
  const st = isLight ? statusLight : status;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* ── Hero: the one place on this page 3D is allowed ── */}
      <div className="relative overflow-hidden border-b" style={{ borderColor: 'var(--line)' }}>
        <AmbientBackdrop intensity={0.55} />
        <div className="relative max-w-5xl mx-auto px-6 py-16">
          <div className="kicker">SK OS</div>
          <h1
            className="font-display font-bold text-4xl sm:text-5xl tracking-tight"
            style={{ color: 'var(--ink)' }}
          >
            Design System
          </h1>
          <p className="mt-3 text-sm max-w-xl leading-relaxed" style={{ color: 'var(--mute)' }}>
            Tokens, motion and 3D for the SK OS interface. Everything on this page is the
            real component — toggle the app theme and watch it re-derive.
          </p>
          <div className="mt-6 flex gap-2 flex-wrap">
            <button className="btn-primary">Primary action</button>
            <button className="btn">Secondary</button>
            <button className="btn-ghost">Ghost</button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* ── Colour ── */}
        <Section
          title="Colour tokens"
          note="Defined once as CSS variables in theme.css and consumed through Tailwind as rgb(var(--x-rgb) / <alpha-value>). Light mode redefines the variables — it does not override the classes. The three alpha-baked tokens (line, mute, faint) are a documented exception."
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Swatch name="accent" cssVar="var(--accent)" hex={palette.accent} />
            <Swatch name="accent-deep" cssVar="rgb(var(--accent-deep-rgb))" hex={palette.accentDeep} />
            <Swatch name="bg" cssVar="var(--bg)" hex={palette.bg} />
            <Swatch name="panel" cssVar="var(--panel)" hex={palette.panel} />
            <Swatch name="ink" cssVar="var(--ink)" hex={palette.ink} />
            <Swatch name="good" cssVar="rgb(var(--good-rgb))" hex={st.good} />
            <Swatch name="warn" cssVar="rgb(var(--warn-rgb))" hex={st.warn} />
            <Swatch name="bad" cssVar="rgb(var(--bad-rgb))" hex={st.bad} />
          </div>

          <div className="mt-5">
            <div className="text-[11px] mb-2 font-grotesk" style={{ color: 'var(--mute)' }}>
              Opacity modifiers (this is why channel tokens exist):
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {[5, 10, 20, 30, 40, 50, 60, 80, 100].map((o) => (
                <div
                  key={o}
                  className="w-12 h-9 rounded-lg grid place-items-center font-mono text-[9px]"
                  style={{ background: `rgb(var(--accent-rgb) / ${o / 100})`, color: 'var(--ink)' }}
                >
                  {o}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── Type ──
            This section described "Plus Jakarta Sans for UI and body" — a
            typeface the app has never loaded. The design system page
            misdescribing the design system is the worst possible place for
            stale documentation, so it now renders the real scale: every row
            below IS the class it names, so if a token regresses this page
            shows it rather than asserting otherwise. */}
        <Section
          title="Typography"
          note="One typeface: DM Sans, variable 400–1000, carrying display, UI, numbers and body. Sentient (serif) appears in exactly one place — the greeting line at the top of a screen — and never on data. The rows below are the live type-scale classes from theme.css."
        >
          <div className="space-y-3">
            <div className="t-display">Display / .t-display</div>
            <div className="t-title">Title / .t-title</div>
            <div className="t-section">Section / .t-section</div>
            <div className="t-card">Card / .t-card</div>
            <div className="t-body">Body / .t-body — descriptions and secondary copy.</div>
            <div className="t-sub">Sub / .t-sub — the quieter supporting line.</div>
            <div className="t-micro">Micro / .t-micro — the one uppercase label</div>
            <div className="t-metric">1,248</div>
            <div className="font-serif text-[15px]" style={{ color: 'var(--mute)' }}>
              Serif / Sentient — “Good morning, Rahul”
            </div>
            <div className="kicker">Kicker / uppercase tracked label</div>
          </div>
          <p className="t-sub mt-4" style={{ fontSize: '.6875rem' }}>
            The weights above are real cuts. The three static DM Sans files this replaced were
            byte-identical, so every “bold” label in the product was browser-synthesised faux bold.
          </p>
        </Section>

        {/* ── Motion ── */}
        <Section
          title="Motion"
          note={`One house easing curve — cubic-bezier(${easing.standard.join(', ')}) — shared by the CSS keyframes and framer-motion so both engines feel identical. Every primitive renders its final state directly under prefers-reduced-motion.`}
        >
          <div className="grid sm:grid-cols-3 gap-4">
            <Card>
              <div className="kicker">Pressable</div>
              <Pressable className="btn-primary w-full">Tap me</Pressable>
              <p className="mt-3 text-[11px]" style={{ color: 'var(--mute)' }}>
                Scale-down on press. Renders a real &lt;button&gt;, so it stays keyboard
                and screen-reader accessible.
              </p>
            </Card>

            <Tilt className="h-full">
              <Card className="h-full">
                <div className="kicker">Tilt</div>
                <div className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>
                  Hover me
                </div>
                <p className="mt-2 text-[11px]" style={{ color: 'var(--mute)' }}>
                  Pointer-tracked 3D tilt using a CSS transform — no WebGL. Auto-disabled
                  on touch, where there is no hovering cursor to track.
                </p>
              </Card>
            </Tilt>

            <Card>
              <div className="kicker">AnimatedNumber</div>
              <div className="font-grotesk font-bold text-3xl" style={{ color: 'var(--ink)' }}>
                <AnimatedNumber value={count} />
              </div>
              <button
                className="btn mt-3 w-full"
                onClick={() => setCount((c) => (c > 3000 ? 1840 : c + 640))}
              >
                Change value
              </button>
              <p className="mt-2 text-[11px]" style={{ color: 'var(--mute)' }}>
                Springs to the target and retargets mid-flight. Near-critically damped —
                overshoot on a number reads as the value wobbling.
              </p>
            </Card>
          </div>

          <div className="mt-4">
            <div className="text-[11px] mb-2 font-grotesk" style={{ color: 'var(--mute)' }}>
              Stagger — scroll this into view:
            </div>
            <Stagger className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {['Volume', 'Protein', 'Streak', 'Sleep'].map((l) => (
                <Card key={l}>
                  <div className="font-grotesk text-xs" style={{ color: 'var(--mute)' }}>{l}</div>
                  <div className="font-grotesk font-bold text-xl" style={{ color: 'var(--ink)' }}>
                    {Math.round(20 + Math.random() * 80)}
                  </div>
                </Card>
              ))}
            </Stagger>
          </div>
        </Section>

        {/* ── Existing primitives ── */}
        <Section
          title="Components"
          note="The existing primitives from components/UI.jsx. These were already good — the design system tokenised their colours rather than replacing them."
        >
          <Reveal>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Kpi label="Volume" value={12480} suffix=" kg" />
              <Kpi label="Protein" value={148} suffix=" g" />
              <Kpi label="Sessions" value={18} />
              <Kpi label="Adherence" value={92} suffix="%" />
            </div>
          </Reveal>

          <div className="grid sm:grid-cols-3 gap-4 mt-4">
            <Card className="flex items-center justify-center">
              <Ring value={1840} max={2400} label="1840" sub="of 2400 kcal" />
            </Card>
            <Card>
              <div className="kicker">Macros</div>
              <div className="space-y-3">
                <Bar value={148} max={180} label="Protein" right="148 / 180 g" />
                <Bar value={210} max={260} label="Carbs" right="210 / 260 g" />
                <Bar value={52} max={70} label="Fat" right="52 / 70 g" />
              </div>
              <div className="mt-3"><MacroPill p={148} c={210} f={52} /></div>
            </Card>
            <Card>
              <div className="kicker">States</div>
              <div className="flex flex-wrap gap-2">
                <StatusChip status="ON_TRACK" />
                <StatusChip status="NEEDS_ATTENTION" />
                <StatusChip status="AT_RISK" />
                <StatusChip status="INACTIVE" />
              </div>
              <div className="mt-4">
                <Seg
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'week', label: 'Week' },
                    { value: 'month', label: 'Month' },
                  ]}
                />
              </div>
            </Card>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <Card><Empty title="No meals logged" hint="Scan a barcode or search to add one." /></Card>
            <Card className="grid place-items-center"><Spinner /></Card>
          </div>
        </Section>

        {/* ── Inputs ── */}
        <Section title="Inputs">
          <div className="grid sm:grid-cols-2 gap-4 max-w-xl">
            <input className="input" placeholder="Search a food…" />
            <select className="input">
              <option>Moderate oil</option>
              <option>Low oil</option>
            </select>
          </div>
        </Section>

        {/* ── 3D rules ── */}
        <Section
          title="3D — and when NOT to use it"
          note="three.js is 508 kB (129 kB gzipped). It is lazily code-split, gated on visibility, and tiered to the device — but it is never free."
        >
          <div className="grid sm:grid-cols-2 gap-4">
            <Card>
              <div className="kicker">Use 3D for</div>
              <ul className="text-xs space-y-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
                <li>• Ambient backdrops behind a hero or empty state</li>
                <li>• One standout moment (workout complete, streak milestone)</li>
                <li>• Anything genuinely spatial, like a muscle map</li>
              </ul>
            </Card>
            <Card>
              <div className="kicker">Do NOT use 3D for</div>
              <ul className="text-xs space-y-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
                <li>• Anything behind a number the user reads — motion hurts legibility</li>
                <li>• More than one Stage on screen at a time</li>
                <li>• Decoration a CSS gradient or <code>Tilt</code> would achieve</li>
                <li>• Lists, tables, or anything that scrolls</li>
              </ul>
            </Card>
          </div>
        </Section>

        {/* ── Payment & receipt ── */}
        <Section
          title="Payment result & receipt printer"
          note="Payment state and receipt state are separate props on purpose: a receipt that fails to generate must never turn a successful payment into 'Payment failed'. Switch the payment state below and watch the headline and the receipt behave independently. The receipt renders only the fields it is handed — remove one from the data and its line disappears rather than being filled in."
        >
          <PaymentResultDemo />
        </Section>

        <p className="text-[11px] pb-10" style={{ color: 'var(--faint)' }}>
          Full documentation: <code>frontend/DESIGN_SYSTEM.md</code>
        </p>
      </div>
    </div>
  );
}
