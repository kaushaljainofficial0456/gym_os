import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Spinner, ErrorState, Ring, Bar } from '../../components/UI.jsx';
import AskSK from '../../components/AskSK.jsx';

const CROWD_STYLE = {
  LOW: { label: 'QUIET', color: '#4ADE80' },
  MODERATE: { label: 'MODERATE', color: '#12B8B0' },
  HIGH: { label: 'BUSY', color: '#087F7B' },
  VERY_HIGH: { label: 'PACKED', color: '#FF5C5C' }
};

export default function Home() {
  const home = useFetch(() => api('/tracking/me/home'));
  const prefsFetch = useFetch(() => api('/me/dashboard'));
  const crowdFetch = useFetch(() => api('/me/crowd'));
  const briefFetch = useFetch(() => api('/intel/coach/brief'));
  const weeklyFetch = useFetch(() => api('/intel/coach/weekly'));
  const [meals, setMeals] = useState(null);
  const [water, setWater] = useState(null);
  const [sleepForm, setSleepForm] = useState({ duration_h: '', bed_time: '', wake_time: '' });
  const [savingSleep, setSavingSleep] = useState(false);

  const data = home.data;
  const mealState = meals || data?.nutrition?.meals || [];
  const waterState = water ?? (data ? data.water.litres : 0);
  const eaten = mealState.filter((m) => m.eaten).reduce((s, m) => ({
    calories: s.calories + m.calories, protein: s.protein + m.protein,
    carbs: s.carbs + m.carbs, fat: s.fat + m.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  // dashboard preferences: hidden cards + order
  const [hidden, setHidden] = useState([]);
  const [order, setOrder] = useState([]);
  useEffect(() => {
    if (!prefsFetch.data?.prefs) return;
    try { setOrder(JSON.parse(prefsFetch.data.prefs.order_list || '[]')); } catch { setOrder([]); }
    try { setHidden(JSON.parse(prefsFetch.data.prefs.hidden || '[]')); } catch { setHidden([]); }
  }, [prefsFetch.data]);

  if (home.loading) return <Spinner label="Loading your day…" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;

  const c = data.client;
  const plan = data.nutrition.plan;
  const today = data.todayWorkout;
  const doneEx = today ? today.exercises.filter((e) => e.done).length : 0;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const show = (k) => !hidden.includes(k);

  const toggleMeal = async (m) => {
    const next = !m.eaten;
    setMeals(mealState.map((x) => (x.id === m.id ? { ...x, eaten: next } : x)));
    try {
      await api(`/nutrition/clients/${c.id}/meals/toggle`, { method: 'POST', body: JSON.stringify({ meal_id: m.id, eaten: next }) });
    } catch { home.reload(); }
  };

  const addWater = async (litres = 0.25) => {
    const next = Math.min(data.water.target, Math.round((waterState + litres) * 100) / 100);
    setWater(next);
    await api(`/tracking/clients/${c.id}/water`, { method: 'POST', body: JSON.stringify({ litres: next }) }).catch(() => home.reload());
  };

  const total = c.startWeight - c.targetWeight;
  const goalPct = total > 0 ? Math.min(100, Math.max(0, ((c.startWeight - c.currentWeight) / total) * 100)) : 0;
  const crowd = crowdFetch.data;

  const cards = {
    workout: (
      <div className={`card p-5 relative overflow-hidden ${today ? 'border-gold/30' : ''}`}>
        {today && <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-ember/15 blur-3xl pointer-events-none" />}
        <div className="relative">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">Today's session</div>
            <span className="chip border-gold/30 text-gold">{today?.meta?.estMinutes || '—'} min</span>
          </div>
          {today ? (
            <>
              <div className="font-grotesk font-bold text-2xl">{today.name}</div>
              {!!today.focus?.length && <div className="text-xs text-mute mt-1">{today.focus.map((f) => f.muscle).join(' · ')}</div>}
              <div className="flex items-center gap-3 mt-3">
                <div className="flex-1 h-2 rounded-full bg-white/8 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-500" style={{ width: `${today.exercises.length ? (doneEx / today.exercises.length) * 100 : 0}%` }} />
                </div>
                <span className="text-[11px] text-mute font-grotesk whitespace-nowrap">{doneEx}/{today.exercises.length} done</span>
              </div>
              <Link to="/app/client/workout" className="btn-primary w-full !py-4 mt-4 text-sm text-center block">
                🔥 {doneEx === today.exercises.length ? 'REVIEW SESSION' : 'START WORKOUT'}
              </Link>
              <div className="text-center text-[10px] text-mute mt-2 font-grotesk">{today.meta?.exerciseCount || today.exercises.length} exercises · {today.meta?.totalSets || '—'} sets</div>
            </>
          ) : (
            <>
              <div className="font-grotesk font-bold text-xl">Rest day 🛌</div>
              <div className="text-xs text-mute mt-1">Recovery is training too. Fuel well and sleep 8 hours.</div>
              <Link to="/app/client/workout" className="btn w-full !py-3.5 mt-4 text-sm text-center block">View training week</Link>
            </>
          )}
        </div>
      </div>
    ),
    goal: (
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">My goal</div>
          <div className="font-grotesk text-xs font-bold text-gold">{Math.round(goalPct)}%</div>
        </div>
        <div className="h-2 rounded-full bg-white/8 overflow-hidden mb-2">
          <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-700" style={{ width: `${goalPct}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-mute font-grotesk">
          <span>{c.startWeight} kg</span><span>now {c.currentWeight} kg</span><span>{c.targetWeight} kg · {c.goalDate?.slice(0, 10) || '—'}</span>
        </div>
      </div>
    ),
    adherence: (
      <div className="card p-5 flex items-center gap-4">
        <div className="relative">
          <Ring value={data.adherence} max={100} size={96} stroke={9} label={<span className="font-grotesk font-bold text-xl">{data.adherence}%</span>} sub={<span className="text-[8px]">adherence</span>} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-grotesk font-bold text-sm">SK Coach</div>
          <div className="mt-1 text-[13px] leading-snug text-ink/90 border-l-2 border-gold pl-2.5 italic">{data.coachMessage}</div>
        </div>
      </div>
    ),
    fuel: (
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk">Fuel today</div>
          {plan && <span className="text-[10px] text-faint font-grotesk">{plan.calories} kcal target</span>}
        </div>
        <div className="flex items-center gap-5">
          <Ring value={eaten.calories} max={plan?.calories || 1} size={132} stroke={11}
            label={<span className="font-grotesk font-bold text-lg">{eaten.calories}</span>}
            sub={<span className="text-[8px] text-mute">of {plan?.calories || 0} kcal</span>} />
          <div className="flex-1 space-y-3">
            <Bar label="Protein" value={eaten.protein} max={plan?.protein || 1} color="linear-gradient(92deg,#087F7B,#12B8B0)" right={`${eaten.protein}/${plan?.protein || 0} g`} />
            <Bar label="Carbs" value={eaten.carbs} max={plan?.carbs || 1} color="linear-gradient(92deg,#12B8B0,#DDF7F2)" right={`${eaten.carbs}/${plan?.carbs || 0} g`} />
            <Bar label="Fat" value={eaten.fat} max={plan?.fat || 1} color="linear-gradient(92deg,#35E0D8,#7BE8FF)" right={`${eaten.fat}/${plan?.fat || 0} g`} />
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          {mealState.map((m) => (
            <button key={m.id} onClick={() => toggleMeal(m)}
              className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${m.eaten ? 'border-gold/40 bg-gold/10' : 'border-line bg-white/[.02]'}`}>
              <span className={`w-5 h-5 rounded-md border grid place-items-center text-[10px] shrink-0 ${m.eaten ? 'bg-gradient-to-br from-ember to-gold text-bg border-transparent anim-pop' : 'border-line'}`}>{m.eaten ? '✓' : ''}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-grotesk font-semibold truncate">{m.name}</span>
                <span className="text-[10px] text-mute">{m.slot} · {m.calories} kcal</span>
              </span>
            </button>
          ))}
          {!mealState.length && <div className="text-xs text-mute text-center py-2">No meals assigned yet.</div>}
        </div>
      </div>
    ),
    water: (
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Water</div>
        <div className="font-grotesk font-bold text-xl text-cyanx">{waterState.toFixed(1)}<span className="text-xs text-mute"> / {data.water.target} L</span></div>
        <div className="mt-2 h-1.5 rounded-full bg-white/8 overflow-hidden">
          <div className="h-full rounded-full bg-cyanx transition-all duration-500" style={{ width: `${(waterState / data.water.target) * 100}%` }} />
        </div>
        <button className="btn w-full mt-3 !py-2 !text-[11px]" onClick={() => addWater(0.25)}>+ 250 ml</button>
      </div>
    ),
    sleep: (
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Sleep</div>
        {data.sleep ? (
          <>
            <div className="font-grotesk font-bold text-xl text-violetx">{data.sleep.duration_h}<span className="text-xs text-mute"> h</span></div>
            <div className="text-[11px] text-mute mt-1">{data.sleep.bed_time || '—'} → {data.sleep.wake_time || '—'}</div>
            <div className="text-[10px] text-faint mt-1 font-grotesk">{data.sleep.duration_h >= 8 ? 'Goal met ✓' : `${Math.round((8 - data.sleep.duration_h) * 60)}m short of 8h`}</div>
          </>
        ) : (
          <div className="text-xs text-mute">No sleep logged yet.</div>
        )}
        <div className="mt-2.5 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <input className="input !py-1.5 !text-[11px]" type="number" step="0.5" min="0" max="24" placeholder="Hours" value={sleepForm.duration_h} onChange={(e) => setSleepForm((f) => ({ ...f, duration_h: e.target.value }))} />
            <input className="input !py-1.5 !text-[11px]" type="time" placeholder="Bed" value={sleepForm.bed_time} onChange={(e) => setSleepForm((f) => ({ ...f, bed_time: e.target.value }))} />
            <input className="input !py-1.5 !text-[11px]" type="time" placeholder="Wake" value={sleepForm.wake_time} onChange={(e) => setSleepForm((f) => ({ ...f, wake_time: e.target.value }))} />
          </div>
          <button className="btn-primary w-full !py-2 !text-[11px]" disabled={savingSleep || !sleepForm.duration_h} onClick={async () => {
            setSavingSleep(true);
            try {
              await api(`/tracking/clients/${c.id}/sleep`, { method: 'POST', body: JSON.stringify({ duration_h: Number(sleepForm.duration_h), bed_time: sleepForm.bed_time || undefined, wake_time: sleepForm.wake_time || undefined, source: 'manual' }) });
              setSleepForm({ duration_h: '', bed_time: '', wake_time: '' });
              home.reload();
            } catch (e) { /* keep form */ }
            setSavingSleep(false);
          }}>{savingSleep ? 'Saving…' : 'Log sleep'}</button>
        </div>
      </div>
    ),
    crowd: crowd?.enabled ? (
      <div className="card p-4">
        <div className="text-[10px] uppercase tracking-[.14em] text-mute font-grotesk mb-2">Gym crowd</div>
        <div className="flex items-end justify-between">
          <div>
            <span className="font-grotesk font-bold text-2xl" style={{ color: CROWD_STYLE[crowd.status]?.color || '#12B8B0' }}>{crowd.current}</span>
            <span className="text-xs text-mute"> / {crowd.capacity} now</span>
          </div>
          <span className="chip" style={{ borderColor: `${CROWD_STYLE[crowd.status]?.color}55`, color: CROWD_STYLE[crowd.status]?.color }}>
            {CROWD_STYLE[crowd.status]?.label || crowd.status}
          </span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-white/8 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${crowd.pct}%`, background: CROWD_STYLE[crowd.status]?.color || '#12B8B0' }} />
        </div>
        <div className="text-[10px] text-faint mt-1.5 font-grotesk">Live from the gym access system · {crowd.pct}% of capacity</div>
      </div>
    ) : null
  };

  // default order (used when the client hasn't customized)
  const defaultOrder = ['workout', 'goal', 'adherence', 'fuel', 'water', 'sleep', 'crowd'];
  const finalOrder = (order.length ? order : defaultOrder).filter((k) => k !== 'coach'); // coach lives inside the adherence card

  return (
    <div className="space-y-4">
      {/* hero greeting — name comes live from the client profile, greeting adapts to the time of day */}
      <div>
        <div className="text-[10px] uppercase tracking-[.18em] text-gold font-grotesk">{greet}, {c.name.split(' ')[0]}</div>
        <h1 className="font-grotesk font-bold text-2xl leading-tight">Here's your day</h1>
        <div className="text-xs text-mute mt-1">{c.goal.replace(/_/g, ' ')} · {c.currentWeight} kg → {c.targetWeight} kg</div>
      </div>

      {/* SK Intelligence Engine — natural-language input */}
      <AskSK onLogged={() => home.reload()} />

      {/* Today's Coach Brief — data-driven insights + today's priority (deterministic; Ollama frames it when available) */}
      {briefFetch.data?.ok && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <span className="font-grotesk font-bold text-sm">Today's Coach Brief</span>
              {briefFetch.data.ai_framed && <span className="chip border-violetx/40 text-violetx !px-1.5 !py-0 text-[8px]">OLLAMA</span>}
              {!briefFetch.data.ai_framed && <span className="chip border-line !px-1.5 !py-0 text-[8px] text-mute">deterministic</span>}
            </div>
            <button onClick={() => briefFetch.reload()} aria-label="Refresh coach brief" className="text-mute hover:text-gold text-sm">⟳</button>
          </div>

          {briefFetch.data.priority && (
            <div className="mb-2.5 rounded-xl border border-gold/30 bg-gold/5 px-3 py-2.5">
              <div className="text-[9px] uppercase tracking-[.14em] text-gold font-grotesk">Today's priority · {briefFetch.data.priority.priority}</div>
              <div className="font-grotesk text-[13px] font-semibold mt-0.5">{briefFetch.data.priority.title}</div>
              <div className="text-[11px] text-mute mt-0.5">{briefFetch.data.priority.message}</div>
              <ActionBtn action={briefFetch.data.priority.action} />
            </div>
          )}

          <div className="space-y-1.5">
            {briefFetch.data.insights?.slice(0, 4).map((ins, i) => (
              <div key={i} className="rounded-lg border border-line bg-white/[.02] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-grotesk text-[12px] font-semibold">{ins.title}</span>
                  <span className={`text-[8px] font-grotesk uppercase tracking-wide ${ins.priority === 'HIGH' ? 'text-ember' : ins.priority === 'MEDIUM' ? 'text-gold' : 'text-faint'}`}>{ins.priority}</span>
                </div>
                <div className="text-[11px] text-mute mt-0.5">{ins.message}</div>
                {ins.action !== 'NONE' && <ActionBtn action={ins.action} small />}
              </div>
            ))}
          </div>
          <div className="text-[9px] text-faint mt-2">{briefFetch.data.note}</div>
          <div className="flex gap-1.5 mt-2.5">
            {['helpful', 'not_helpful', 'not_relevant'].map((fb) => (
              <button key={fb} className="chip border-line text-[9px] text-mute hover:text-gold hover:border-gold/40" onClick={async () => {
                try {
                  await api('/intel/coach/feedback', { method: 'POST', body: JSON.stringify({ feedback: fb, target_type: 'brief', target_id: briefFetch.data.priority?.title || 'daily' }) });
                } catch { /* ignore */ }
              }}>{fb === 'not_helpful' ? 'Not helpful' : fb === 'not_relevant' ? 'Not relevant' : 'Helpful ✓'}</button>
            ))}
          </div>
        </div>
      )}

      {/* Weekly Coach Review */}
      {weeklyFetch.data?.ok && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <span className="font-grotesk font-bold text-sm">Weekly Review</span>
              {weeklyFetch.data.ai_framed && <span className="chip border-violetx/40 text-violetx !px-1.5 !py-0 text-[8px]">OLLAMA</span>}
            </div>
            <button onClick={() => weeklyFetch.reload()} aria-label="Refresh weekly review" className="text-mute hover:text-gold text-sm">⟳</button>
          </div>
          {weeklyFetch.data.went_well?.length > 0 && (
            <div className="mb-2.5">
              <div className="text-[9px] uppercase tracking-[.14em] text-good font-grotesk mb-1">What went well</div>
              {weeklyFetch.data.went_well.map((item, i) => (
                <div key={i} className="text-[12px] text-ink/85 leading-relaxed">✓ {typeof item === 'string' ? item : item.message || item.title || ''}</div>
              ))}
            </div>
          )}
          {weeklyFetch.data.needs_attention?.length > 0 && (
            <div className="mb-2.5">
              <div className="text-[9px] uppercase tracking-[.14em] text-warn font-grotesk mb-1">Needs attention</div>
              {weeklyFetch.data.needs_attention.map((item, i) => (
                <div key={i} className="text-[12px] text-ink/85 leading-relaxed">⚠ {typeof item === 'string' ? item : item.message || item.title || ''}</div>
              ))}
            </div>
          )}
          {weeklyFetch.data.next_week_priority && (
            <div className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2.5 mt-2">
              <div className="text-[9px] uppercase tracking-[.14em] text-gold font-grotesk">Next week priority</div>
              <div className="font-grotesk text-[13px] font-semibold mt-0.5">{weeklyFetch.data.next_week_priority.title || weeklyFetch.data.next_week_priority}</div>
              {weeklyFetch.data.next_week_priority.message && <div className="text-[11px] text-mute mt-0.5">{weeklyFetch.data.next_week_priority.message}</div>}
            </div>
          )}
        </div>
      )}

      {finalOrder.map((key) => show(key) && cards[key] ? <div key={key}>{cards[key]}</div> : null)}

      {show('fuel') && (
        <Link to="/app/client/nutrition" className="block card p-4 text-center hover:border-gold/40 transition-colors">
          <span className="font-grotesk text-xs font-semibold text-gold">Log meals, foods & water →</span>
        </Link>
      )}
      {show('adherence') && show('coach') && (
        <Link to="/app/client/profile" className="block card p-4 text-center hover:border-gold/40 transition-colors">
          <span className="font-grotesk text-xs font-semibold text-gold">Customize my dashboard & metrics →</span>
        </Link>
      )}
    </div>
  );
}

// Maps a structured recommendation action to a real SK OS surface.
function ActionBtn({ action, small }) {
  const href = {
    OPEN_NUTRITION: '/app/client/nutrition',
    OPEN_MEALS: '/app/client/nutrition',
    START_WORKOUT: '/app/client/workout',
    LOG_WATER: '/app/client/nutrition',
    LOG_SLEEP: '/app/client/profile',
    VIEW_PROGRESS: '/app/client/progress',
    VIEW_EXERCISE: '/app/client/workout',
    VIEW_GOAL: '/app/client/progress',
    VIEW_BRIEF: '/app/client'
  }[action];
  if (!href) return null;
  return (
    <Link to={href} className={`inline-block mt-1.5 rounded-lg border border-gold/40 text-gold hover:bg-gold/10 font-grotesk font-semibold transition-colors ${small ? '!px-2 !py-0.5 !text-[10px]' : '!px-3 !py-1 !text-[11px]'}`}>
      Open →
    </Link>
  );
}
