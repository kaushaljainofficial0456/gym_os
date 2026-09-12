/**
 * ROSTER PULSE — the numbers each role's own endpoint already returns.
 *
 * WHAT THIS FIXES. Both dashboard endpoints return considerably more than
 * the screen rendered. /dashboard/trainer returns today's session counts,
 * a 14-day workout completion rate and a 7-day weight trend; none of the
 * three reached the page. /dashboard/overview returns monthly revenue and
 * renewals due; neither reached it either, so a gym OWNER opened their
 * dashboard and saw a trainer's view of client adherence with no business
 * numbers on it at all.
 *
 * So this is not decoration added to a finished screen -- it is the data
 * the API was already paying to compute, finally shown, and shown
 * differently per role because the two roles do not have the same job.
 *
 * ON COLOUR. Every ring and bar takes a metric hue (--m-training,
 * --m-body, ...), which is the same hue that metric carries everywhere
 * else in the product. Colour here is an index, not ornament: a trainer
 * learns "periwinkle is training volume" once and it holds on the client
 * app, the progress page and here.
 *
 * ON MISSING DATA. A rate with no sessions behind it is not 0% -- it is
 * unknown, and a 0% ring would read as catastrophic failure rather than
 * "nothing scheduled yet". Those render as a dash with the reason.
 */
import { Card, Kicker, Ring } from '../UI.jsx';

const pct = (v) => (v == null ? null : Math.max(0, Math.min(100, Math.round(v))));

/** One labelled ring with an honest empty state. */
function StatRing({ value, max, hue, big, caption, note, empty }) {
  if (empty) {
    return (
      <div className="flex flex-col items-center gap-2 min-w-0">
        <Ring value={0} max={1} size={104} stroke={9} color="var(--line)" label="—" />
        <div className="text-center min-w-0">
          <div className="text-[11px] font-semibold" style={{ color: 'var(--ink)' }}>{caption}</div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>{empty}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 min-w-0">
      <Ring value={value} max={max} size={104} stroke={9} color={hue} label={big} />
      <div className="text-center min-w-0">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--ink)' }}>{caption}</div>
        {note && <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>{note}</div>}
      </div>
    </div>
  );
}

/**
 * The roster as a single proportional bar.
 *
 * Four counts in four boxes make you do the division yourself. One bar
 * shows the SHAPE of the roster at a glance -- whether "8 at risk" is a
 * crisis or a rounding error depends entirely on whether the roster is
 * 20 people or 400, and that is exactly what a proportional bar says and
 * a grid of numbers does not.
 */
export function RosterBar({ onTrack = 0, needsAttention = 0, atRisk = 0, inactive = 0 }) {
  const segments = [
    ['On track', onTrack, 'var(--m-body)'],
    ['Needs attention', needsAttention, 'var(--m-strength)'],
    ['At risk', atRisk, 'var(--m-energy)'],
    ['Inactive', inactive, 'var(--line)'],
  ];
  const total = segments.reduce((n, s) => n + (s[1] || 0), 0);
  if (!total) {
    return <div className="text-[11.5px]" style={{ color: 'var(--mute)' }}>No clients on the roster yet.</div>;
  }

  return (
    <div>
      <div className="flex rounded-full overflow-hidden" style={{ height: 10, background: 'var(--line)' }}>
        {segments.map(([label, n, hue]) => (n > 0 ? (
          <div
            key={label}
            style={{ width: `${(n / total) * 100}%`, background: hue, transition: 'width .7s var(--ease-out)' }}
            title={`${label}: ${n}`}
          />
        ) : null))}
      </div>
      {/* The legend carries the count as well as the colour: colour alone
          is not a label, and these numbers are the thing being read. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5">
        {segments.map(([label, n, hue]) => (n > 0 ? (
          <div key={label} className="flex items-center gap-1.5">
            <span className="rounded-full shrink-0" style={{ width: 8, height: 8, background: hue }} />
            <span className="text-[11px]" style={{ color: 'var(--mute)' }}>
              {label} <strong className="tabular-nums" style={{ color: 'var(--ink)' }}>{n}</strong>
            </span>
          </div>
        ) : null))}
      </div>
    </div>
  );
}

/** TRAINER: how today is going, and whether the roster is holding. */
export function TrainerPulse({ k }) {
  const doneToday = k.todayWorkoutsCompleted ?? 0;
  const totalToday = k.todayWorkoutsTotal ?? 0;
  const completion = pct(k.recentWorkoutCompletion);
  const adherence = pct(k.avgAdherence);
  const weight = k.avgWeightChange7d;

  return (
    <Card className="self-start">
      <Kicker>Your roster today</Kicker>

      <div className="grid grid-cols-3 gap-3 mt-1">
        <StatRing
          value={doneToday} max={totalToday || 1} hue="var(--m-training)"
          big={totalToday ? `${doneToday}/${totalToday}` : '0'}
          caption="Sessions done"
          note={totalToday ? 'scheduled today' : null}
          empty={totalToday ? null : 'nothing scheduled'}
        />
        <StatRing
          value={completion ?? 0} max={100} hue="var(--m-body)"
          big={completion == null ? '—' : `${completion}%`}
          caption="Completion"
          note="last 14 days"
          empty={completion == null ? 'no sessions yet' : null}
        />
        <StatRing
          value={adherence ?? 0} max={100} hue="var(--m-nutrition)"
          big={adherence == null ? '—' : `${adherence}%`}
          caption="Adherence"
          note="roster average"
          empty={adherence == null ? 'not enough data' : null}
        />
      </div>

      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="t-micro mb-2">Roster health</div>
        <RosterBar
          onTrack={k.onTrack} needsAttention={k.needsAttention}
          atRisk={k.atRisk} inactive={k.inactive}
        />
      </div>

      {weight != null && (
        <div className="mt-3 text-[11px]" style={{ color: 'var(--mute)' }}>
          Average weight change this week{' '}
          <strong className="tabular-nums" style={{ color: 'var(--ink)' }}>
            {weight > 0 ? '+' : ''}{weight}%
          </strong>
        </div>
      )}
    </Card>
  );
}

/**
 * OWNER: the business, which is a different question from adherence.
 *
 * Revenue is shown as a plain number rather than a ring, because a ring
 * needs a meaningful maximum and this app stores no revenue target. A
 * ring against a made-up denominator would imply the gym is 64% of the
 * way to a goal nobody set.
 */
export function OwnerPulse({ k, currency = '₹' }) {
  const workout = pct(k.workoutCompletion);
  const nutrition = pct(k.nutritionAdherence);
  const revenue = Number(k.monthlyRevenue || 0);

  return (
    <Card className="self-start">
      <Kicker>This month</Kicker>

      <div className="grid grid-cols-2 gap-3 mt-1">
        <div className="rounded-xl px-3 py-3" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div className="t-micro">Revenue collected</div>
          <div
            className="font-grotesk font-black tabular-nums mt-1"
            style={{ fontSize: 26, letterSpacing: '-.03em', color: 'var(--m-body)' }}
          >
            {currency}{revenue.toLocaleString('en-IN')}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>
            payments received since the 1st
          </div>
        </div>

        <div className="rounded-xl px-3 py-3" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div className="t-micro">Renewals due</div>
          <div
            className="font-grotesk font-black tabular-nums mt-1"
            style={{ fontSize: 26, letterSpacing: '-.03em', color: k.renewalsDue > 0 ? 'var(--m-energy)' : 'var(--ink)' }}
          >
            {k.renewalsDue ?? 0}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>
            within the next 30 days
          </div>
        </div>
      </div>

      {/* Workout vs nutrition, side by side, because they fail
          independently: a gym can have excellent attendance and no
          nutrition compliance at all, and the single blended "adherence"
          number hides exactly that. */}
      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="t-micro mb-2.5">Where adherence is coming from</div>
        <div className="grid grid-cols-2 gap-3">
          <StatRing
            value={workout ?? 0} max={100} hue="var(--m-training)"
            big={workout == null ? '—' : `${workout}%`}
            caption="Workouts"
            empty={workout == null ? 'no sessions logged' : null}
          />
          <StatRing
            value={nutrition ?? 0} max={100} hue="var(--m-nutrition)"
            big={nutrition == null ? '—' : `${nutrition}%`}
            caption="Nutrition"
            empty={nutrition == null ? 'no meals logged' : null}
          />
        </div>
      </div>

      <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="t-micro mb-2">Member health</div>
        <RosterBar
          onTrack={k.onTrack} needsAttention={k.needsAttention}
          atRisk={k.atRisk} inactive={k.inactive}
        />
      </div>
    </Card>
  );
}
