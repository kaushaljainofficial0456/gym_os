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
  AmbientBackdrop, easing, duration, spring, radius, brand, status,
} from '../design/index.js';
import { Card, Kpi, Ring, Bar, StatusChip, Seg, Empty, Spinner, MacroPill } from '../components/UI.jsx';

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
            <Swatch name="good" cssVar="rgb(var(--good-rgb))" hex={status.good} />
            <Swatch name="warn" cssVar="rgb(var(--warn-rgb))" hex={status.warn} />
            <Swatch name="bad" cssVar="rgb(var(--bad-rgb))" hex={status.bad} />
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

        {/* ── Type ── */}
        <Section title="Typography" note="DM Sans for display, Plus Jakarta Sans for UI and body.">
          <div className="space-y-2">
            <div className="font-display font-bold text-3xl" style={{ color: 'var(--ink)' }}>
              Display / DM Sans Bold
            </div>
            <div className="font-grotesk font-semibold text-base" style={{ color: 'var(--ink)' }}>
              UI / Plus Jakarta Semibold
            </div>
            <div className="text-sm" style={{ color: 'var(--mute)' }}>
              Body / Plus Jakarta Regular — used for descriptions and secondary copy.
            </div>
            <div className="kicker">Kicker / uppercase tracked label</div>
          </div>
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

        <p className="text-[11px] pb-10" style={{ color: 'var(--faint)' }}>
          Full documentation: <code>frontend/DESIGN_SYSTEM.md</code>
        </p>
      </div>
    </div>
  );
}
