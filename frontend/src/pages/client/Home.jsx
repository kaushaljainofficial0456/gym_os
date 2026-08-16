import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';
import GymCrowdDetail from '../../components/GymCrowdDetail.jsx';

const CROWD_STYLE = {
  LOW: { label: 'QUIET', color: '#34D399' },
  MODERATE: { label: 'MODERATE', color: '#14C4BC' },
  HIGH: { label: 'BUSY', color: '#0A8A85' },
  VERY_HIGH: { label: 'PACKED', color: '#F87171' }
};

export default function Home() {
  const home = useFetch(() => api('/tracking/me/home'));
  const crowdFetch = useFetch(() => api('/me/crowd'));
  const [crowdDetailOpen, setCrowdDetailOpen] = useState(false);

  const data = home.data;
  const mealState = data?.nutrition?.meals || [];
  const eaten = mealState.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  if (home.loading) return <Spinner label="Loading your day…" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const c = data.client;
  const plan = data.nutrition.plan;
  const today = data.todayWorkout;
  const doneEx = today ? today.exercises.filter((e) => e.done).length : 0;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const total = c.startWeight - c.targetWeight;
  const goalPct = total > 0 ? Math.min(100, Math.max(0, ((c.startWeight - c.currentWeight) / total) * 100)) : 0;
  const crowd = crowdFetch.data;

  return (
    <div className="space-y-6">

      {/* ── SECTION 1: Greeting ── */}
      <div>
        <div className="font-grotesk text-[11px] uppercase tracking-[.16em] font-medium" style={{ color: 'var(--mute)' }}>{greet}, {c.name.split(' ')[0]}</div>
        <h1 className="font-display font-bold text-[26px] leading-tight tracking-tight" style={{ color: 'var(--ink)' }}>Here's your day</h1>
        <div className="text-xs mt-1" style={{ color: 'var(--faint)' }}>{c.goal.replace(/_/g, ' ')} · {c.currentWeight} kg → {c.targetWeight} kg</div>
      </div>

      {/* ── SECTION 2: Today's Session ── */}
      <div className="card p-5 relative overflow-hidden">
        <div className="relative">
          <div className="flex items-center justify-between mb-1">
            <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Today's session</div>
            <span className="chip border-gold/30 text-gold">{today?.meta?.estMinutes || '—'} min</span>
          </div>
          {today ? (
            <>
              <div className="font-display font-bold text-xl tracking-tight" style={{ color: 'var(--ink)' }}>{today.name}</div>
              {!!today.focus?.length && <div className="text-xs mt-1" style={{ color: 'var(--mute)' }}>{today.focus.map((f) => f.muscle).join(' · ')}</div>}
              <div className="flex items-center gap-3 mt-3">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                  <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-500" style={{ width: `${today.exercises.length ? (doneEx / today.exercises.length) * 100 : 0}%` }} />
                </div>
                <span className="text-[11px] font-grotesk whitespace-nowrap" style={{ color: 'var(--mute)' }}>{doneEx}/{today.exercises.length} done</span>
              </div>
              <Link to="/app/client/workout" className="btn-primary w-full !py-3.5 mt-4 text-sm text-center block">
                🔥 {doneEx === today.exercises.length ? 'REVIEW SESSION' : 'START WORKOUT'}
              </Link>
              <div className="text-center text-[10px] mt-2 font-grotesk" style={{ color: 'var(--faint)' }}>{today.meta?.exerciseCount || today.exercises.length} exercises · {today.meta?.totalSets || '—'} sets</div>
            </>
          ) : (
            <>
              <div className="font-display font-bold text-xl tracking-tight" style={{ color: 'var(--ink)' }}>Rest day 🛌</div>
              <div className="text-xs mt-1" style={{ color: 'var(--mute)' }}>Recovery is training too. Fuel well and sleep 8 hours.</div>
              <Link to="/app/client/workout" className="btn w-full !py-3 mt-4 text-sm text-center block">View training week</Link>
            </>
          )}
        </div>
      </div>

      {/* ── SECTION 3: My Progress ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>My progress</div>
          {plan && <span className="text-[10px] font-grotesk" style={{ color: 'var(--faint)' }}>{plan.calories} kcal target</span>}
        </div>
        <div className="flex items-center gap-5">
          <Ring value={eaten.calories} max={plan?.calories || 1} size={120} stroke={10}
            label={<span className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>{eaten.calories}</span>}
            sub={<span className="text-[9px]" style={{ color: 'var(--mute)' }}>of {plan?.calories || 0} kcal</span>} />
          <div className="flex-1 space-y-3">
            <Bar label="Protein" value={eaten.protein} max={plan?.protein || 1} right={`${eaten.protein}/${plan?.protein || 0} g`} />
            <Bar label="Carbs" value={eaten.carbs} max={plan?.carbs || 1} right={`${eaten.carbs}/${plan?.carbs || 0} g`} />
            <Bar label="Fat" value={eaten.fat} max={plan?.fat || 1} right={`${eaten.fat}/${plan?.fat || 0} g`} />
          </div>
        </div>
      </div>

      {/* ── SECTION 4: Goal Progress ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>My goal</div>
          <div className="font-grotesk text-xs font-bold text-gold">{Math.round(goalPct)}%</div>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: 'var(--line)' }}>
          <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-700" style={{ width: `${goalPct}%` }} />
        </div>
        <div className="flex justify-between text-[11px] font-grotesk" style={{ color: 'var(--mute)' }}>
          <span>{c.startWeight} kg</span><span>now {c.currentWeight} kg</span><span>{c.targetWeight} kg · {c.goalDate?.slice(0, 10) || '—'}</span>
        </div>
      </div>

      {/* ── SECTION 5: Gym Crowd ── */}
      {crowd?.enabled && (
        <button
          onClick={() => setCrowdDetailOpen(true)}
          className="card p-4 w-full text-left hover:border-gold/40 transition-colors group"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="font-grotesk text-[10.5px] uppercase tracking-[.14em] font-medium" style={{ color: 'var(--mute)' }}>Gym crowd</div>
            <span className="text-[9px] font-grotesk group-hover:text-gold transition-colors" style={{ color: 'var(--faint)' }}>Tap for details →</span>
          </div>
          <div className="flex items-end justify-between">
            <div>
              <span className="font-display font-bold text-2xl" style={{ color: CROWD_STYLE[crowd.status]?.color || '#14C4BC' }}>{crowd.current}</span>
              <span className="text-xs" style={{ color: 'var(--mute)' }}> / {crowd.capacity} now</span>
            </div>
            <span className="chip" style={{ borderColor: `${CROWD_STYLE[crowd.status]?.color}55`, color: CROWD_STYLE[crowd.status]?.color }}>
              {CROWD_STYLE[crowd.status]?.label || crowd.status}
            </span>
          </div>
          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${crowd.pct}%`, background: CROWD_STYLE[crowd.status]?.color || '#14C4BC' }} />
          </div>
          <div className="text-[10px] mt-1.5 font-grotesk" style={{ color: 'var(--faint)' }}>Live from the gym access system · {crowd.pct}% of capacity</div>
        </button>
      )}

      <GymCrowdDetail open={crowdDetailOpen} onClose={() => setCrowdDetailOpen(false)} crowd={crowd} />
    </div>
  );
}
