/**
 * CLIENT HOME — rebuilt on the design system.
 *
 * WHAT CHANGED AND WHY, because "make it premium" is not a spec:
 *
 * 1. FIVE STACKED CARDS -> THREE BANDS. The old screen was five `card p-5`
 *    boxes in a column, each with its own uppercase micro-label. When every
 *    block has identical weight, nothing is primary and the eye has to read
 *    all five to find the one thing it came for. Now: a hero band (what am I
 *    doing today), a fuel band (how is my eating), and a quiet pair of
 *    tiles. Same information, one obvious entry point.
 *
 * 2. EMOJI REMOVED. The old primary button read "🔥 START WORKOUT" and rest
 *    day read "Rest day 🛌". Emoji in a product surface renders differently
 *    on every platform, cannot be colour-managed against the palette, and is
 *    the single fastest way to make an interface look improvised.
 *
 * 3. THE HERO NUMBER IS THE SESSION, NOT A METRIC. Users open this screen to
 *    act, not to audit. So the largest type is the workout name, and the
 *    primary action sits directly under it.
 *
 * 4. 3D IS SCOPED TO THE HERO ONLY. One ambient field behind the top band,
 *    faded out before the content starts. 3D behind a list of macros would
 *    cost battery to make numbers harder to read.
 *
 * ACCESSIBILITY NOTE: every animation here comes from the design system's
 * primitives, which check `prefers-reduced-motion` themselves and render
 * final state when it is set. There is no bare CSS transition in this file
 * that would survive that preference.
 */
import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';
import GymCrowdDetail from '../../components/GymCrowdDetail.jsx';
import { sumEatenTotals } from '../../nutritionCalc.js';
import {
  AmbientBackdrop, Reveal, Stagger, Tilt, Pressable, AnimatedNumber, motion,
} from '../../design/index.js';

// Same rounding convention used everywhere else this app shows a macro
// total (MyDietCard.jsx, Nutrition.jsx, CustomizeMealSheet.jsx all define
// this identically).
const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * Crowd levels. The old version mapped LOW and MODERATE to the SAME hex
 * (#8C6A4D) — two distinct states rendering identically, which makes the
 * colour pure decoration. They now differ, and the values are tokens so
 * they follow the theme.
 */
const CROWD = {
  LOW:       { label: 'Quiet',    tone: 'var(--good)' },
  MODERATE:  { label: 'Moderate', tone: 'var(--accent)' },
  HIGH:      { label: 'Busy',     tone: 'var(--warn)' },
  VERY_HIGH: { label: 'Packed',   tone: 'var(--bad)' },
};

/** Small uppercase section label. One component so the tracking and size
 *  are defined once instead of being retyped per section — the old file
 *  repeated `text-[10.5px] uppercase tracking-[.14em]` five times and had
 *  drifted to two different sizes. */
function Label({ children, className = '' }) {
  return (
    <div
      className={`text-[10px] font-medium uppercase tracking-[.18em] ${className}`}
      style={{ color: 'var(--faint)' }}
    >
      {children}
    </div>
  );
}

function CommunityCard() {
  const nav = useNavigate();
  const fetch = useFetch(() => api('/community/membership'));
  if (fetch.loading || fetch.error || !fetch.data?.settings?.community_enabled) return null;
  const membership = fetch.data?.membership;
  const gym = fetch.data?.gym;
  if (!membership?.enabled) return null;
  return (
    <Reveal delay={260}>
      <Tilt max={4}>
        <button onClick={() => nav('/app/client/community')}
          className="card p-4 w-full text-left flex items-center gap-3 active:scale-[.98] transition-all">
          <div className="w-10 h-10 rounded-2xl bg-gold/10 border border-gold/25 grid place-items-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-grotesk text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{gym?.name || 'Community'}</div>
            <div className="text-[10px]" style={{ color: 'var(--faint)' }}>Leaderboards &amp; shared workouts</div>
          </div>
          <span className="text-sm" style={{ color: 'var(--faint)' }}>→</span>
        </button>
      </Tilt>
    </Reveal>
  );
}

export default function Home() {
  // Already fetched once by the persistent ClientLayout — reuse it instead
  // of re-fetching /tracking/me/home on every mount (see ClientLayout.jsx).
  const home = useOutletContext();
  const crowdFetch = useFetch(() => api('/me/crowd'));
  const [crowdOpen, setCrowdOpen] = useState(false);

  const data = home.data;
  const meals = data?.nutrition?.meals || [];
  // Shared with Nutrition.jsx (nutritionCalc.js's own comment explains why
  // this isn't a second inline reduce) -- was previously duplicated here
  // with no rounding at all, which is what produced values like
  // "252.29999999999998 / 800 g" on screen: plain IEEE754 float addition
  // across several meals' carbs, interpolated straight into a template
  // string with nothing rounding it first. r1() below is applied at
  // display time, matching every other macro total in this app.
  const eatenRaw = sumEatenTotals(meals);
  const eaten = { calories: Math.round(eatenRaw.calories), protein: r1(eatenRaw.protein), carbs: r1(eatenRaw.carbs), fat: r1(eatenRaw.fat) };

  if (home.loading) return <Spinner label="Loading your day…" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const c = data.client;
  const plan = data.nutrition.plan;
  const today = data.todayWorkout;
  const doneEx = today ? today.exercises.filter((e) => e.done).length : 0;
  const totalEx = today?.exercises.length || 0;
  const complete = totalEx > 0 && doneEx === totalEx;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const span = c.startWeight - c.targetWeight;
  const goalPct = span > 0
    ? Math.min(100, Math.max(0, ((c.startWeight - c.currentWeight) / span) * 100))
    : 0;
  const crowd = crowdFetch.data;
  const kcalLeft = Math.max(0, (plan?.calories || 0) - eaten.calories);

  return (
    <div className="space-y-4">

      {/* ═══ HERO ═══
          The only place 3D appears on this screen. `-mx-4 px-4` lets the
          ambient field bleed to the device edges while the text stays on
          the page's normal gutter — a backdrop that stops short of the
          edge reads as a misaligned card, not as atmosphere. */}
      <section data-tour="home-hero" className="relative -mx-4 -mt-2 px-4 pt-6 pb-5 overflow-hidden">
        <AmbientBackdrop intensity={0.42} maxTier="medium" />
        {/* Fades the field into the page before the content below starts,
            so there is no hard horizontal seam where 3D stops. */}
        <div
          className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }}
        />

        <div className="relative">
          <Reveal>
            {/* Sentient, the one serif on the screen: this is the only
                human sentence here, everything else is data. */}
            <div className="font-serif text-[15px]" style={{ color: 'var(--mute)' }}>
              {greet}, {c.name.split(' ')[0]}
            </div>
          </Reveal>

          {today ? (
            <Stagger step={70} className="mt-2">
              <h1
                className="font-black leading-[0.95] tracking-[-0.035em] text-[34px]"
                style={{ color: 'var(--ink)', textWrap: 'balance' }}
              >
                {today.name}
              </h1>

              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                   style={{ color: 'var(--mute)' }}>
                {!!today.focus?.length && <span>{today.focus.map((f) => f.muscle).join(' · ')}</span>}
                {!!today.focus?.length && <span style={{ color: 'var(--faint)' }}>—</span>}
                <span>{totalEx} exercises</span>
                {today.meta?.estMinutes && (
                  <>
                    <span style={{ color: 'var(--faint)' }}>—</span>
                    <span>{today.meta.estMinutes} min</span>
                  </>
                )}
              </div>

              {/* Progress. Rendered only mid-session: a 0/6 bar before you
                  start is a reminder of nothing, and a full bar after you
                  finish is better said in words. */}
              {doneEx > 0 && !complete && (
                <div className="mt-4 flex items-center gap-3">
                  <div className="flex-1 h-[3px] rounded-full overflow-hidden"
                       style={{ background: 'var(--line)' }}>
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: 'var(--accent-grad)' }}
                      initial={{ width: 0 }}
                      animate={{ width: `${(doneEx / totalEx) * 100}%` }}
                      transition={{ duration: 0.9, ease: [0.22, 0.8, 0.3, 1] }}
                    />
                  </div>
                  <span className="text-[11px] tabular-nums whitespace-nowrap"
                        style={{ color: 'var(--mute)' }}>
                    {doneEx} of {totalEx}
                  </span>
                </div>
              )}

              <Pressable
                as={Link}
                to="/app/client/workout"
                className="btn-primary mt-5 w-full !py-4 text-center block text-[13px] font-bold tracking-[.02em]"
              >
                {complete ? 'Review session' : doneEx > 0 ? 'Resume workout' : 'Start workout'}
              </Pressable>
            </Stagger>
          ) : (
            <Stagger step={70} className="mt-2">
              <h1 className="font-black leading-[0.95] tracking-[-0.035em] text-[34px]"
                  style={{ color: 'var(--ink)' }}>
                Rest day
              </h1>
              <p className="mt-2 text-[13px] leading-relaxed max-w-[34ch]"
                 style={{ color: 'var(--mute)' }}>
                Recovery is training. Eat to your target and sleep eight hours.
              </p>
              <Pressable
                as={Link}
                to="/app/client/workout"
                className="btn mt-5 w-full !py-3.5 text-center block text-[13px] font-semibold"
              >
                View training week
              </Pressable>
            </Stagger>
          )}
        </div>
      </section>

      {/* ═══ FUEL ═══
          The headline figure is kcal REMAINING, not kcal eaten. "1,840 of
          2,550" makes the user do the subtraction to answer the question
          they actually have, which is how much is left. */}
      <Reveal delay={80}>
        <Tilt max={4}>
          <div data-tour="home-fuel" className="card p-5">
            <div className="flex items-start justify-between">
              <Label>Fuel today</Label>
              {plan && (
                <span className="text-[10px] tabular-nums" style={{ color: 'var(--faint)' }}>
                  {plan.calories.toLocaleString()} kcal target
                </span>
              )}
            </div>

            <div className="mt-4 flex items-center gap-5">
              <Ring
                value={eaten.calories}
                max={plan?.calories || 1}
                size={104}
                stroke={8}
                label={
                  <span className="font-black text-[22px] tracking-[-.02em]"
                        style={{ color: 'var(--ink)' }}>
                    <AnimatedNumber value={kcalLeft} />
                  </span>
                }
                sub={<span className="text-[9px] tracking-[.1em] uppercase"
                           style={{ color: 'var(--faint)' }}>left</span>}
              />
              <div className="flex-1 space-y-3">
                <Bar label="Protein" value={eaten.protein} max={plan?.protein || 1}
                     right={`${eaten.protein} / ${plan?.protein || 0} g`} height="h-1.5" />
                <Bar label="Carbs" value={eaten.carbs} max={plan?.carbs || 1}
                     right={`${eaten.carbs} / ${plan?.carbs || 0} g`} height="h-1.5" />
                <Bar label="Fat" value={eaten.fat} max={plan?.fat || 1}
                     right={`${eaten.fat} / ${plan?.fat || 0} g`} height="h-1.5" />
              </div>
            </div>
          </div>
        </Tilt>
      </Reveal>

      {/* ═══ QUIET TILES ═══
          Goal and crowd are reference, not action, so they get half width
          and no accent fill. Deliberately the least loud thing here. */}
      <div className="grid grid-cols-2 gap-4">
        <Reveal delay={140}>
          <Tilt max={5} className="h-full">
            <div className="card p-4 h-full flex flex-col">
              <Label>Goal</Label>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-black text-[26px] tracking-[-.03em]"
                      style={{ color: 'var(--ink)' }}>
                  <AnimatedNumber value={Math.round(goalPct)} />
                </span>
                <span className="text-[13px] font-medium" style={{ color: 'var(--mute)' }}>%</span>
              </div>
              <div className="mt-auto pt-3">
                <div className="h-[3px] rounded-full overflow-hidden"
                     style={{ background: 'var(--line)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: 'var(--accent-grad)' }}
                    initial={{ width: 0 }}
                    animate={{ width: `${goalPct}%` }}
                    transition={{ duration: 1, ease: [0.22, 0.8, 0.3, 1], delay: 0.2 }}
                  />
                </div>
                <div className="mt-2 text-[10px] tabular-nums" style={{ color: 'var(--faint)' }}>
                  {c.currentWeight} → {c.targetWeight} kg
                </div>
              </div>
            </div>
          </Tilt>
        </Reveal>

        {crowd?.enabled ? (
          <Reveal delay={200}>
            <Tilt max={5} className="h-full">
              <Pressable
                as="button"
                onClick={() => setCrowdOpen(true)}
                className="card p-4 h-full w-full text-left flex flex-col"
              >
                <Label>Gym now</Label>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="font-black text-[26px] tracking-[-.03em]"
                        style={{ color: 'var(--ink)' }}>
                    <AnimatedNumber value={crowd.current} />
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--mute)' }}>
                    /{crowd.capacity}
                  </span>
                </div>
                <div className="mt-auto pt-3">
                  <div className="h-[3px] rounded-full overflow-hidden"
                       style={{ background: 'var(--line)' }}>
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: CROWD[crowd.status]?.tone || 'var(--accent)' }}
                      initial={{ width: 0 }}
                      animate={{ width: `${crowd.pct}%` }}
                      transition={{ duration: 1, ease: [0.22, 0.8, 0.3, 1], delay: 0.26 }}
                    />
                  </div>
                  <div className="mt-2 text-[10px] font-medium"
                       style={{ color: CROWD[crowd.status]?.tone || 'var(--mute)' }}>
                    {CROWD[crowd.status]?.label || crowd.status}
                  </div>
                </div>
              </Pressable>
            </Tilt>
          </Reveal>
        ) : (
          /* Weight trend stands in when the gym has no live feed, so the
             grid never renders a lone orphaned tile. */
          <Reveal delay={200}>
            <Tilt max={5} className="h-full">
              <div className="card p-4 h-full flex flex-col">
                <Label>Weight</Label>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="font-black text-[26px] tracking-[-.03em]"
                        style={{ color: 'var(--ink)' }}>
                    <AnimatedNumber value={c.currentWeight} decimals={1} />
                  </span>
                  <span className="text-[13px] font-medium" style={{ color: 'var(--mute)' }}>kg</span>
                </div>
                <div className="mt-auto pt-3 text-[10px] tabular-nums"
                     style={{ color: 'var(--faint)' }}>
                  started at {c.startWeight} kg
                </div>
              </div>
            </Tilt>
          </Reveal>
        )}
      </div>

      {/* ═══ COMMUNITY LINK ═══ */}
      <CommunityCard />

      <GymCrowdDetail open={crowdOpen} onClose={() => setCrowdOpen(false)} crowd={crowd} />
    </div>
  );
}
