/**
 * "Asha shared a workout with you" -- the popup a member gets for an
 * in-app share (routes/appShares.js), and the bell's link opens.
 *
 * A workout can be done today, saved to Saved workouts, or put on days
 * (every Monday and Thursday...); a meal goes into their meals. "Not now"
 * closes it and keeps it in the bell; "Dismiss" says no thanks for good.
 * Loaded only when there is something to show (SharedInboxGate.jsx).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bookmark, CalendarDays, Check, ChevronLeft, Clock, Play, Utensils } from 'lucide-react';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';
import { Sheet } from '../UI.jsx';
import { Avatar } from './PeoplePicker.jsx';
import { DayPicker, dayList, plannerToday } from '../workout/days.jsx';
import './share.css';

function ago(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function WorkoutCard({ w }) {
  const exs = w.exercises || [];
  const sets = exs.reduce((a, e) => a + (Number(e.sets) || 0), 0);
  const supersets = new Set(exs.map((e) => e.superset_group).filter(Boolean)).size;
  const shown = exs.slice(0, 6);
  return (
    <div className="sh-card">
      <div className="sh-card__head">
        <div className="sh-card__name">{w.name}</div>
        <div className="sh-card__meta">{exs.length} {exs.length === 1 ? 'exercise' : 'exercises'} · {sets} sets{supersets ? ` · ${supersets} superset${supersets > 1 ? 's' : ''}` : ''}</div>
      </div>
      <ol className="sh-card__list">
        {shown.map((e, i) => (
          <li key={i} className={e.superset_group ? 'is-ss' : undefined}>
            <span className="truncate">{exerciseLabel(e.name)}</span>
            <span>{e.sets} × {e.reps}</span>
          </li>
        ))}
      </ol>
      {exs.length > shown.length && <div className="sh-card__more">+{exs.length - shown.length} more</div>}
    </div>
  );
}

function MealCard({ m }) {
  const items = m.items || [];
  const total = items.reduce((a, it) => ({ k: a.k + it.calories, p: a.p + it.protein, c: a.c + it.carbs, f: a.f + it.fat }), { k: 0, p: 0, c: 0, f: 0 });
  return (
    <div className="sh-card">
      <div className="sh-card__head">
        <div className="sh-card__name">{items.length === 1 ? items[0].name : `${items.length} meals and foods`}</div>
        <div className="sh-card__meta">{items.length === 1 && items[0].components?.length ? items[0].components.slice(0, 4).join(' · ') : items.map((it) => it.name).slice(0, 4).join(' · ')}</div>
      </div>
      <div className="sh-macros" style={{ paddingTop: 10 }}>
        <span><b>{total.k}</b> kcal</span><span><b>{total.p}</b> g protein</span><span><b>{total.c}</b> g carbs</span><span><b>{total.f}</b> g fat</span>
      </div>
    </div>
  );
}

const DONE = {
  today: { title: 'It’s today’s workout', body: 'Start it from the Workout tab whenever you’re ready.', go: 'Go to workout', to: '/app/client/workout' },
  planner: { title: 'Saved to your workouts', body: 'Find it in Saved workouts. Do it any day, or give it days.', go: 'Go to workout', to: '/app/client/workout' },
  meal: { title: 'Added to your meals', body: 'It’s in My Diet, ready to log.', go: 'Go to nutrition', to: '/app/client/nutrition' },
};

/**
 * @param share     the share to show (from /app-shares/inbox or /:id)
 * @param canPlan   false in a gym that follows the coach's plan
 * @param remaining how many more are waiting after this one
 * @param onAnswered(id)  accepted or dismissed
 * @param onLater()       closed without answering
 */
export default function SharedInboxSheet({ share, canPlan, remaining = 0, onAnswered, onLater, onNext }) {
  const nav = useNavigate();
  const [view, setView] = useState('main'); // main | days | done
  const [days, setDays] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => { setView('main'); setDays(new Set()); setBusy(false); setErr(''); setDone(null); }, [share?.id]);

  if (!share) return null;
  const isWorkout = share.kind === 'workout';
  const answered = share.status && share.status !== 'pending';

  const accept = async (action) => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const r = await api(`/app-shares/${share.id}/accept`, { method: 'POST', body: JSON.stringify(action === 'days' ? { action, days: [...days] } : { action }) });
      window.dispatchEvent(new CustomEvent(isWorkout ? 'skos:plan-changed' : 'skos:meals-changed'));
      if (action === 'days') {
        setDone({
          title: `Every ${dayList(days)}`,
          body: r.today_workout_id ? 'Today is one of them, so it’s today’s workout too.' : 'It’ll be ready on each of those days.',
          go: 'Go to workout', to: '/app/client/workout',
        });
      } else setDone(DONE[action]);
      setView('done');
      onAnswered?.(share.id, false);
    } catch (e) { setErr(e.message || 'Could not add it'); }
    setBusy(false);
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try { await api(`/app-shares/${share.id}/dismiss`, { method: 'POST' }); } catch { /* it will show again; nothing lost */ }
    setBusy(false);
    onAnswered?.(share.id, true);
  };

  const close = view === 'done' ? () => onAnswered?.(share.id, true) : onLater;

  let footer = null;
  let body;
  if (view === 'done' && done) {
    body = (
      <div className="sh-done">
        <span className="sh-done__icon"><Check size={26} strokeWidth={2.6} aria-hidden="true" /></span>
        <div className="sh-done__title">{done.title}</div>
        <p className="sh-done__body">{done.body}</p>
      </div>
    );
    footer = (
      <div className="sh-secondary">
        <button type="button" className="btn" onClick={() => { onAnswered?.(share.id, true); nav(done.to); }}>{done.go}</button>
        <button type="button" className="btn-primary" onClick={() => (remaining ? onNext?.() : onAnswered?.(share.id, true))}>
          {remaining ? `Next · ${remaining} more` : 'Done'}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-3">
        <div className="sh-from">
          <Avatar name={share.from} size={44} />
          <div className="min-w-0">
            <div className="sh-from__line">{share.from} shared {isWorkout ? 'a workout' : share.meal?.items?.length > 1 ? 'meals' : 'a meal'}</div>
            <div className="sh-from__when">{ago(share.created_at)}</div>
          </div>
        </div>
        {share.message && <p className="sh-msg">{share.message}</p>}
        {share.expired ? (
          <div className="sh-note"><Clock size={16} strokeWidth={2} aria-hidden="true" /><span>This share has expired. Ask {share.from.split(' ')[0]} to send it again.</span></div>
        ) : isWorkout ? <WorkoutCard w={share.workout} /> : <MealCard m={share.meal} />}
        {view === 'days' && (
          <div className="grid gap-2">
            <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>Repeat it every week on</span>
            <DayPicker value={days} onToggle={(d) => setDays((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n; })} />
            <p className="text-[12.5px]" style={{ color: 'var(--mute)' }}>
              {days.size ? (days.has(plannerToday()) ? `Every ${dayList(days)}, starting today.` : `Every ${dayList(days)}.`) : 'Pick one or more days.'}
            </p>
          </div>
        )}
        {answered && (
          <div className="sh-note"><Check size={16} strokeWidth={2.4} aria-hidden="true" /><span>{share.status === 'accepted' ? 'You already added this.' : 'You dismissed this one.'}</span></div>
        )}
        {!isWorkout || canPlan || answered || share.expired ? null : (
          <p className="text-[12.5px]" style={{ color: 'var(--mute)' }}>Your gym follows your coach&rsquo;s plan, so you can do it today but not save it.</p>
        )}
        {err && <p className="text-[13px]" role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
      </div>
    );

    if (answered || share.expired) {
      footer = <button type="button" className="btn-primary btn-block" onClick={() => onAnswered?.(share.id, true)}>Close</button>;
    } else if (view === 'days') {
      footer = (
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => setView('main')}><ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />Back</button>
          <button type="button" className="btn-primary flex-1" disabled={!days.size || busy} onClick={() => accept('days')}>
            {busy ? 'Saving…' : days.size ? `Save · every ${dayList(days)}` : 'Pick a day'}
          </button>
        </div>
      );
    } else {
      footer = (
        <div className="sh-actions">
          {isWorkout ? (
            <>
              <button type="button" className="btn-primary btn-block" disabled={busy} onClick={() => accept('today')}>
                <Play size={15} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />{busy ? 'Adding…' : 'Do it today'}
              </button>
              {canPlan && (
                <div className="sh-secondary">
                  <button type="button" className="btn" disabled={busy} onClick={() => accept('planner')}>
                    <Bookmark size={15} strokeWidth={2} aria-hidden="true" />Save it
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setView('days')}>
                    <CalendarDays size={15} strokeWidth={2} aria-hidden="true" />Pick days
                  </button>
                </div>
              )}
            </>
          ) : (
            <button type="button" className="btn-primary btn-block" disabled={busy} onClick={() => accept('meal')}>
              <Utensils size={15} strokeWidth={2.2} aria-hidden="true" />{busy ? 'Adding…' : 'Add to my meals'}
            </button>
          )}
          <div className="sh-later">
            <button type="button" className="sh-textbtn sh-textbtn--bad" disabled={busy} onClick={dismiss}>Dismiss</button>
            <button type="button" className="sh-textbtn" onClick={onLater}>Not now</button>
          </div>
        </div>
      );
    }
  }

  return (
    <Sheet open onClose={busy ? undefined : close} title="Shared with you"
      sub={isWorkout ? 'A workout' : 'Meals'} footer={footer}>
      {body}
    </Sheet>
  );
}
