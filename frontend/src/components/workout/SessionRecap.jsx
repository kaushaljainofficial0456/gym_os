/**
 * AFTER THE LAST SET — the intensity question, then the recap.
 *
 * WHAT THIS REPLACES: one screen that stacked nine text panels on top of
 * each other. Duration/volume/exercises, an intensity question, a calorie
 * range, the model's two-line caveats, a source line, a cardio panel, a
 * totals panel repeating the same two numbers, a PR list, and three
 * full-width buttons. Every one of those facts was true and worth showing.
 * Shown all at once, in prose, they read as a receipt -- and a receipt is
 * the wrong reward for finishing a workout.
 *
 * SO IT IS TWO SCREENS AND FIVE PICTURES.
 *
 * Screen one asks the ONE question the calorie model genuinely needs and
 * nothing else. It is not a blocking gate -- the celebration and the three
 * headline numbers are already on it, and Skip is right there -- but it is
 * the only thing being asked, so it gets answered in a tap instead of
 * being missed under a wall of panels.
 *
 * Screen two is the recap, and every block on it is a shape before it is a
 * sentence: a completion ring, a real object weighing what you moved, a
 * stacked bar of where the work went, a split bar of where the energy
 * went. The numbers are identical to what the old screen printed. The
 * words are not gone either -- they moved behind the (i) buttons, which is
 * where reference material belongs once it has been read once.
 *
 * WHAT IS *NOT* DRAWN, on purpose:
 *
 *   - No ring around volume, duration or calories. Ring.jsx's own header
 *     says it: a ring implies a ceiling, and none of those three have one.
 *     Only sets-completed does (the checklist is the denominator), so only
 *     sets-completed gets the ring.
 *   - No muscle split when the exercises carry no muscle data -- the block
 *     is simply absent rather than showing one grey "Other" bar that
 *     pretends to be a chart.
 *   - No calorie card when the model declined. A 422 means skos-cal-v1 was
 *     not willing to estimate this session, and inventing a figure to fill
 *     the space would be the worst thing on the page.
 */
import { useEffect, useMemo, useState } from 'react';
import { regionForMuscle } from '../MuscleMap.jsx';
import InfoDot from '../InfoDot.jsx';
import MassObject, { massEquivalent } from './massObjects.jsx';
import { exerciseLabel, PR_WEIGHT_TYPES } from '../../utils.js';

/* ── colour ────────────────────────────────────────────────────────────
   Six palette tokens, assigned by the muscle region's position in a fixed
   list. Fixed, so the same muscle is the same colour every session; spread
   across the list, so the regions that actually co-occur in one session
   (chest+shoulders+triceps, lats+traps+biceps, quads+hams+glutes+calves)
   land on different colours rather than two neighbours drawing the same
   swatch. --bad is deliberately excluded: red reads as an error in a
   legend, not as a body part. */
const REGION_ORDER = [
  'chest', 'shoulders', 'triceps', 'biceps', 'forearms', 'lats',
  'traps', 'lower_back', 'core', 'quads', 'hamstrings', 'glutes', 'calves',
];
const PALETTE = ['--accent', '--cyan', '--gold', '--violet', '--good', '--warn'];

function regionColor(region) {
  const i = REGION_ORDER.indexOf(region);
  if (i < 0) return 'var(--faint)';
  return `var(${PALETTE[i % PALETTE.length]})`;
}

const REGION_LABEL = {
  chest: 'Chest', shoulders: 'Shoulders', triceps: 'Triceps', biceps: 'Biceps',
  forearms: 'Forearms', lats: 'Lats', traps: 'Upper back', lower_back: 'Lower back',
  core: 'Core', quads: 'Quads', hamstrings: 'Hamstrings', glutes: 'Glutes', calves: 'Calves',
};

/* ── intensity ─────────────────────────────────────────────────────────
   Three tiers because skos-cal-v1 has three MET tiers; a 1-10 RPE slider
   would ask for a precision the model then throws away. The flames are the
   label -- one, two, three -- so the row is read as a ramp before any word
   is. Colours run good -> warn -> accent rather than green -> amber -> RED:
   training hard is not an error state. */
const TIERS = [
  { key: 'light',    label: 'Light',    flames: 1, color: 'var(--good)',   hint: 'Easy pace, plenty left' },
  { key: 'moderate', label: 'Moderate', flames: 2, color: 'var(--warn)',   hint: 'Working, but steady' },
  { key: 'hard',     label: 'Hard',     flames: 3, color: 'var(--accent)', hint: 'Near everything you had' },
];

function Flame({ on, color, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
         fill={on ? color : 'none'} stroke={on ? color : 'var(--line)'} strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5c2.5 3.2 1 5.2 0 6.5-1.3 1.7-2 2.7-2 4.2a4 4 0 0 0 8 0c0-2.3-1.2-3.6-1.2-3.6.6 3.3-1 4.2-1 4.2.8-3.9-3.8-6.4-3.8-11.3Z" />
      <path d="M8.5 9.5C6.2 11.6 5 14 5 16.3a7 7 0 0 0 14 0" />
    </svg>
  );
}

/* ── a sweeping arc ────────────────────────────────────────────────────
   Not UI.jsx's Ring and not components/Ring.jsx either: this one needs the
   number, the label and the check mark stacked inside it at hero size, and
   the two existing rings take conflicting `label` props (one renders it
   inside, one uses it as the accessible name -- a mix-up that once printed
   a whole sentence at 26px on the profile page). A third, local, unshared
   ring is cheaper than a fourth reading of that prop. */
function CompletionRing({ done, total }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  /* Mount at zero, then sweep on the next frame. The app-wide
     prefers-reduced-motion rule collapses every duration AND delay to
     0.01ms, so this lands instantly for anyone who asked for that --
     there is no second code path here to keep in sync with it. */
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(t);
  }, [pct]);

  const size = 132;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  return (
    <div className="relative grid place-items-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
           aria-label={`${done} of ${total} sets completed`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="var(--accent)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - shown)}
          style={{
            transform: 'rotate(-90deg)', transformOrigin: '50% 50%',
            transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,.61,.36,1)',
            filter: 'drop-shadow(0 0 8px rgb(var(--accent-rgb) / .35))',
          }}
        />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <div className="font-black tabular-nums leading-none"
             style={{ fontSize: 30, color: 'var(--ink)' }}>
          {done}<span style={{ color: 'var(--faint)', fontSize: 19 }}>/{total}</span>
        </div>
        <div className="text-[9px] uppercase tracking-[.18em] mt-1.5" style={{ color: 'var(--faint)' }}>
          Sets done
        </div>
      </div>
    </div>
  );
}

/** A tile of one headline number. Three of these, never a paragraph. */
function StatTile({ value, label }) {
  return (
    <div className="rounded-xl px-2 py-2.5 text-center"
         style={{ background: 'rgb(var(--panel-rgb) / .72)', border: '1px solid var(--line)' }}>
      <div className="font-black text-[15px] tabular-nums leading-none" style={{ color: 'var(--ink)' }}>{value}</div>
      <div className="text-[8px] uppercase tracking-[.14em] mt-1" style={{ color: 'var(--faint)' }}>{label}</div>
    </div>
  );
}

function Card({ children, className = '', delay = 0 }) {
  return (
    <div className={`card p-4 anim-fadeUp ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

const SectionTitle = ({ children, info, infoTitle, infoLabel }) => (
  <div className="flex items-center gap-1 mb-2.5">
    <div className="text-[10px] uppercase tracking-[.16em] font-grotesk" style={{ color: 'var(--faint)' }}>
      {children}
    </div>
    {info && <InfoDot label={infoLabel || String(children)} title={infoTitle}>{info}</InfoDot>}
  </div>
);

/* ══════════════════════════════════════════════════════════════════════ */

export default function SessionRecap({
  result,
  askIntensity = false,
  onPickIntensity,
  onSkipIntensity,
  intensity,
  burn,
  burnLoading = false,
  burnSource,
  cardioResult,
  cardioName = (x) => x,
  u,
  onShareWorkout,
  onShareCommunities,
  onDone,
  backdrop = null,
}) {
  const breakdown = result?.breakdown || [];
  const setsDone = Number(result?.setsDone) || 0;
  const setsPlanned = Number(result?.setsPlanned) || 0;

  /* Volume per muscle REGION, largest first. Built from the sets actually
     logged, so an exercise skipped mid-session contributes nothing rather
     than contributing its prescription. */
  const muscleSplit = useMemo(() => {
    const byRegion = new Map();
    let total = 0;
    for (const b of breakdown) {
      const region = regionForMuscle(b.muscle);
      if (!region) continue;               // unknown muscle: excluded, not bucketed as "Other"
      const v = Number(b.volume) || 0;
      if (v <= 0) continue;
      byRegion.set(region, (byRegion.get(region) || 0) + v);
      total += v;
    }
    if (!total) return null;
    return {
      total,
      parts: [...byRegion.entries()]
        .map(([region, volume]) => ({
          region,
          volume,
          pct: volume / total,
          color: regionColor(region),
          label: REGION_LABEL[region] || region,
        }))
        .sort((a, b) => b.volume - a.volume),
    };
  }, [breakdown]);

  const topVolume = useMemo(
    () => breakdown.reduce((m, b) => Math.max(m, Number(b.volume) || 0), 0),
    [breakdown],
  );

  const equiv = useMemo(() => massEquivalent(result?.volume), [result?.volume]);

  const strengthKcal = Number(burn?.kcal) || 0;
  const cardioKcal = Number(cardioResult?.totalCalories) || 0;
  const totalKcal = strengthKcal + cardioKcal;

  const fmtVol = (kg) => `${Math.round(u.weightNum(kg, { decimals: 0 })).toLocaleString()}`;

  /* ── header, shared by both steps ── */
  const header = (
    <div className="relative p-5 text-center">
      <div className="w-12 h-12 mx-auto rounded-full grid place-items-center anim-pop"
           style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
             strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h1 className="font-grotesk font-bold text-2xl mt-3" style={{ color: 'var(--ink)' }}>Workout complete</h1>
      <div className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>{result?.name}</div>
    </div>
  );

  /* ═══ STEP 1 — one question, asked once ═══ */
  if (askIntensity) {
    return (
      <div className="space-y-4">
        <div className="card relative overflow-hidden anim-pop">
          {backdrop}
          <Scrim />
          {header}
          <div className="relative px-5 pb-5">
            <div className="grid grid-cols-3 gap-2">
              <StatTile value={result?.durationMin != null ? `${result.durationMin} min` : '—'} label="Duration" />
              <StatTile value={result?.volume ? `${fmtVol(result.volume)} ${u.weightUnit}` : '—'} label="Volume" />
              <StatTile value={setsPlanned ? `${setsDone}/${setsPlanned}` : (result?.exercises ?? '—')}
                        label={setsPlanned ? 'Sets' : 'Exercises'} />
            </div>
          </div>
        </div>

        <Card delay={90}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="font-grotesk font-bold text-[15px]" style={{ color: 'var(--ink)' }}>
              How hard was that?
            </div>
            <InfoDot label="the intensity question" title="Why we ask">
              Your calorie estimate is built from how hard you worked, not just how long.
              One tap is the whole answer — we never guess it for you, and you can skip it.
            </InfoDot>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onPickIntensity?.(t.key)}
                className="rounded-2xl px-2 py-3 flex flex-col items-center gap-2 transition-transform active:scale-[.97]"
                style={{
                  minHeight: 104,
                  border: `1px solid ${t.color}`,
                  // A tint of the tier's own colour, so the row is a ramp
                  // at a glance rather than three identical grey boxes.
                  background: `color-mix(in srgb, ${t.color} 12%, transparent)`,
                }}
              >
                <span className="flex items-center gap-0.5" aria-hidden="true">
                  {[0, 1, 2].map((i) => <Flame key={i} on={i < t.flames} color={t.color} />)}
                </span>
                <span className="font-grotesk font-bold text-[13px]" style={{ color: 'var(--ink)' }}>{t.label}</span>
                <span className="text-[9px] leading-tight text-center" style={{ color: 'var(--mute)' }}>{t.hint}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onSkipIntensity}
            className="w-full mt-3 text-[11px] font-grotesk rounded-lg"
            style={{ minHeight: 36, color: 'var(--faint)' }}
          >
            Skip — don&rsquo;t estimate calories
          </button>
        </Card>
      </div>
    );
  }

  /* ═══ STEP 2 — the recap ═══ */
  return (
    <div className="space-y-3">
      {/* ── the moment ── */}
      <div className="card relative overflow-hidden anim-pop">
        {backdrop}
        <Scrim />
        {header}
        <div className="relative px-5 pb-5">
          {setsPlanned > 0 && (
            <div className="flex justify-center mb-4">
              <CompletionRing done={setsDone} total={setsPlanned} />
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <StatTile value={result?.durationMin != null ? `${result.durationMin} min` : '—'} label="Duration" />
            <StatTile value={result?.volume ? `${fmtVol(result.volume)} ${u.weightUnit}` : '—'} label="Volume" />
            <StatTile value={result?.exercises || breakdown.length || '—'} label="Exercises" />
          </div>
        </div>
      </div>

      {/* ── what that weight actually is ── */}
      {equiv && (
        <Card delay={60}>
          <SectionTitle
            infoLabel="total weight moved"
            infoTitle="Total weight moved"
            info={<>Every set added up: reps &times; weight, across the whole session.
              It is not what you lifted in one go — it is the total mass that went
              through your hands today, which is why it reaches car territory so fast.</>}
          >
            Total weight moved
          </SectionTitle>
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-black text-[27px] tabular-nums tracking-[-.02em] leading-none"
                      style={{ color: 'var(--ink)' }}>
                  {fmtVol(result.volume)}
                </span>
                <span className="text-[12px]" style={{ color: 'var(--mute)' }}>{u.weightUnit}</span>
              </div>
              <div className="text-[12px] mt-1.5 leading-snug" style={{ color: 'var(--mute)' }}>
                About{' '}
                <span className="font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
                  {equiv.countLabel}&times;
                </span>{' '}
                {equiv.label}.
              </div>
            </div>
            <div
              className="shrink-0 grid place-items-center rounded-2xl anim-massIn"
              style={{
                width: 84, height: 72, color: 'var(--accent)',
                background: 'var(--accent-soft)', border: '1px solid rgb(var(--accent-rgb) / .28)',
              }}
            >
              <MassObject shape={equiv.key} size={46} />
            </div>
          </div>
        </Card>
      )}

      {/* ── where the work went ── */}
      {muscleSplit && (
        <Card delay={120}>
          <SectionTitle
            infoLabel="the muscle split"
            infoTitle="How this is split"
            info={<>Each exercise&rsquo;s volume is credited to its primary muscle, then grouped
              into body regions. Assisting muscles are not counted twice, so the bar always
              adds up to 100% of what you lifted.</>}
          >
            Where the work went
          </SectionTitle>

          {/* One stacked bar — a pie at phone width turns three of these
              slices into unreadable slivers. */}
          <div className="flex h-3 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            {muscleSplit.parts.map((p, i) => (
              <div
                key={p.region}
                style={{
                  width: `${p.pct * 100}%`,
                  background: p.color,
                  transition: 'width .9s cubic-bezier(.22,.61,.36,1)',
                  transitionDelay: `${i * 70}ms`,
                }}
                title={`${p.label} ${Math.round(p.pct * 100)}%`}
              />
            ))}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2.5">
            {muscleSplit.parts.map((p) => (
              <div key={p.region} className="flex items-center gap-1.5">
                <span className="rounded-full shrink-0" style={{ width: 8, height: 8, background: p.color }} />
                <span className="text-[11px] font-grotesk" style={{ color: 'var(--ink)' }}>{p.label}</span>
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--faint)' }}>
                  {Math.round(p.pct * 100)}%
                </span>
              </div>
            ))}
          </div>

          {/* Per exercise, bars relative to the biggest one — not to the
              session total, which would flatten every bar on a four-
              exercise day into something unreadable. */}
          {breakdown.length > 0 && (
            <div className="mt-4 space-y-2">
              {breakdown.map((b, i) => {
                const color = regionColor(regionForMuscle(b.muscle));
                const w = topVolume > 0 ? Math.max(0.04, (Number(b.volume) || 0) / topVolume) : 0;
                return (
                  <div key={b.id || i}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11.5px] font-grotesk font-semibold truncate"
                            style={{ color: 'var(--ink)' }}>
                        {exerciseLabel(b.name)}
                      </span>
                      <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--faint)' }}>
                        {b.sets} sets &middot; {b.reps} reps &middot; {fmtVol(b.volume)} {u.weightUnit}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full mt-1 overflow-hidden" style={{ background: 'var(--line)' }}>
                      <div style={{
                        width: `${w * 100}%`, height: '100%', background: color, borderRadius: 999,
                        transition: 'width .8s cubic-bezier(.22,.61,.36,1)',
                        transitionDelay: `${150 + i * 60}ms`,
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ── energy ──
          One card, one headline number. The old screen printed the strength
          figure, the cardio figure and the total in three separate panels,
          so the same session appeared to report three different calorie
          numbers within one scroll. */}
      {burnLoading && (
        <Card delay={150}>
          <div className="text-[11px] text-center" style={{ color: 'var(--mute)' }}>Estimating calories burned…</div>
        </Card>
      )}

      {!burnLoading && totalKcal > 0 && (
        <Card delay={180}>
          <SectionTitle
            infoLabel="the calorie estimate"
            infoTitle="About this estimate"
            info={(
              <div className="space-y-2">
                {burn && (
                  <p>
                    Best estimate <strong>{burn.kcal} kcal</strong>, and the honest range is{' '}
                    <strong>{burn.lower_kcal}–{burn.upper_kcal} kcal</strong>. Burn models are
                    genuinely this imprecise; a single clean-looking number would be a
                    made-up one.
                  </p>
                )}
                {!!burn?.notes?.length && (
                  <ul className="space-y-1 list-disc pl-4">
                    {burn.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
                )}
                <p style={{ color: 'var(--faint)' }}>
                  Source: {burnSource || 'Estimated by Barbell'}
                  {burn?.model_version ? ` · ${burn.model_version}` : ''}
                </p>
              </div>
            )}
          >
            Energy burned
          </SectionTitle>

          <div className="flex items-baseline gap-2">
            <span className="font-black text-[30px] tabular-nums tracking-[-.02em] leading-none"
                  style={{ color: 'var(--accent)' }}>
              {totalKcal}
            </span>
            <span className="text-[12px]" style={{ color: 'var(--mute)' }}>kcal</span>
            {burn && (
              <span className="text-[11px] tabular-nums ml-auto" style={{ color: 'var(--faint)' }}>
                range {burn.lower_kcal}–{burn.upper_kcal}
              </span>
            )}
          </div>

          {/* The split only appears when there genuinely are two parts. */}
          {strengthKcal > 0 && cardioKcal > 0 && (
            <>
              <div className="flex h-2.5 rounded-full overflow-hidden mt-3" style={{ background: 'var(--line)' }}>
                <div style={{ width: `${(strengthKcal / totalKcal) * 100}%`, background: 'var(--accent)' }} />
                <div style={{ width: `${(cardioKcal / totalKcal) * 100}%`, background: 'var(--cyan)' }} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--mute)' }}>
                  <span className="rounded-full" style={{ width: 8, height: 8, background: 'var(--accent)' }} />
                  Strength <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{strengthKcal}</span>
                </span>
                <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--mute)' }}>
                  <span className="rounded-full" style={{ width: 8, height: 8, background: 'var(--cyan)' }} />
                  Cardio <span className="tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>{cardioKcal}</span>
                </span>
              </div>
            </>
          )}

          {/* Cardio detail stays, but as one line per activity rather than a
              nested panel of segment rows. */}
          {cardioKcal > 0 && (cardioResult?.items || []).length > 0 && (
            <div className="mt-3 space-y-1">
              {cardioResult.items.map((item, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate font-grotesk" style={{ color: 'var(--ink)' }}>{cardioName(item.id)}</span>
                  <span className="tabular-nums shrink-0" style={{ color: 'var(--faint)' }}>
                    {Math.round((item.segments || []).reduce((a, s) => a + (s.durationSec || 0), 0) / 60)} min
                    {' · '}{item.calories} kcal
                  </span>
                </div>
              ))}
            </div>
          )}

          {intensity && (
            <div className="mt-3 flex items-center gap-1.5">
              {(() => {
                const t = TIERS.find((x) => x.key === intensity);
                if (!t) return null;
                return (
                  <>
                    <span className="flex items-center gap-0.5" aria-hidden="true">
                      {[0, 1, 2].map((i) => <Flame key={i} on={i < t.flames} color={t.color} size={12} />)}
                    </span>
                    <span className="text-[10px] uppercase tracking-[.14em]" style={{ color: 'var(--faint)' }}>
                      Rated {t.label}
                    </span>
                  </>
                );
              })()}
            </div>
          )}
        </Card>
      )}

      {/* ── records ── */}
      {!!result?.prs?.length && (
        <Card delay={210}>
          <SectionTitle>New personal records</SectionTitle>
          {/* Chips, not paragraphs -- but the NUMBER stays. A record that
              says only "Heaviest weight" is a notification, not a record;
              what a member wants to see is the figure they just beat and
              what it beat. Weight-typed records follow the unit preference,
              rep counts do not. */}
          <div className="flex flex-wrap gap-1.5">
            {result.prs.flatMap((p) => (p.records || []).map((r) => {
              const isWeight = PR_WEIGHT_TYPES.has(r.type);
              const value = isWeight
                ? `${u.weightNum(r.value, { decimals: 1 })} ${u.weightUnit}`
                : r.value;
              return (
                <span key={`${p.name}-${r.type}`}
                      className="inline-flex flex-col gap-0.5 rounded-xl px-2.5 py-1.5"
                      style={{
                        background: 'rgb(var(--gold-rgb) / .12)',
                        border: '1px solid rgb(var(--gold-rgb) / .35)',
                      }}>
                  <span className="text-[11px] font-grotesk font-bold leading-tight" style={{ color: 'var(--ink)' }}>
                    {exerciseLabel(p.name)}
                  </span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--mute)' }}>
                    {r.label}{' '}
                    <span className="tabular-nums font-bold" style={{ color: 'var(--gold)' }}>{value}</span>
                    {r.previous !== null && r.previous !== undefined && (
                      <span style={{ color: 'var(--faint)' }}>
                        {' '}(was {isWeight ? u.weightNum(r.previous, { decimals: 1 }) : r.previous})
                      </span>
                    )}
                  </span>
                </span>
              );
            }))}
          </div>
        </Card>
      )}

      {/* ── actions ──
          Done is the primary and sits first because it is what almost
          everyone taps. Sharing is two compact buttons on one row instead
          of two full-width bars, which is what made the old screen read as
          three equally-weighted decisions. */}
      <div className="space-y-2 anim-fadeUp" style={{ animationDelay: '250ms' }}>
        <button className="btn btn-primary w-full" onClick={onDone}>Done</button>
        {result?.workoutId && (
          <div className="grid grid-cols-2 gap-2">
            <button className="btn flex items-center justify-center gap-2" onClick={onShareWorkout}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
              <span className="text-[12px]">Share</span>
            </button>
            <button className="btn flex items-center justify-center gap-2" onClick={onShareCommunities}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98" />
              </svg>
              <span className="text-[12px]">Communities</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* Radial and centred, densest behind the content: a vertical fade put its
   weakest point exactly where the heading sits. `--bg-rgb` so one rule
   veils toward peach in light and charcoal in dark rather than always
   darkening. The blur does real work — softening high-frequency detail
   behind text is what makes it legible without a heavier, duller veil. */
function Scrim() {
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden="true"
         style={{
           background:
             'radial-gradient(130% 95% at 50% 42%, rgb(var(--bg-rgb) / .93) 0%, rgb(var(--bg-rgb) / .82) 42%, rgb(var(--bg-rgb) / .55) 100%)',
           backdropFilter: 'blur(3px)',
           WebkitBackdropFilter: 'blur(3px)',
         }} />
  );
}
