/**
 * The Workout page before a session: today's session as the one thing on
 * the screen that asks to be pressed, the week as a single quiet row, the
 * tools as a grid, and the plan as a readable list.
 *
 * Presentation only. Every action is a prop owned by Workout.jsx, so the
 * session logic (start, restore, autosave) stays in one place.
 */
import { ChevronRight, Info, Moon, Play, Share2, TrendingUp, TriangleAlert } from 'lucide-react';
import { exerciseLabel } from '../../utils.js';
import BodyFocus from './BodyFocus.jsx';

const LB_PER_KG = 2.20462;

/** A plan's weight is free text: '80', '80 kg', '176 lb', 'BW'. A number
 *  (with or without a unit) is shown in the member's own units -- '80 kg'
 *  read as text sat in kilograms beside targets already in pounds --
 *  and anything else ('BW', 'band') as written. */
export function planWeight(w, u) {
  if (w === '' || w == null) return '';
  const m = String(w).trim().match(/^(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)?$/i);
  if (!m) return String(w);
  const n = Number(m[1]);
  if (!(n > 0)) return String(w);
  const kg = /^(lb|lbs|pound)/i.test(m[2] || '') ? n / LB_PER_KG : n;
  return u.fmtWeight(kg);
}

/** A target worth showing: the overload service also suggests adding load
 *  to moves done with none (a plank, a push-up), which reads as nonsense. */
export function loadedTarget(s) {
  return s && Number(s.increment) > 0 && Number(s.current?.weight) > 0 ? s : null;
}

/** '8' reads as '8 reps'; '45 sec' and 'AMRAP' read as written. */
export function repsText(r) {
  if (r == null || r === '') return '';
  return /^\d+(?:\s*-\s*\d+)?$/.test(String(r).trim()) ? `${r} reps` : String(r);
}

function StartButton({ onStart, starting, disabled }) {
  return (
    <button type="button" data-start-workout className="btn-primary btn-lg btn-block wk-start"
      data-loading={starting ? 'true' : undefined} onClick={onStart} disabled={disabled || starting}>
      <Play size={16} strokeWidth={2.4} aria-hidden="true" fill="currentColor" />
      Start session
    </button>
  );
}

export function TodayHero({ workout, meta = {}, focus = [], suggestions = [], u, onStart, starting, onShare, onAddCardio, onBuild }) {
  if (!workout) {
    return (
      <section className="wk-hero wk-hero--rest">
        <div className="wk-hero__rest-icon"><Moon size={22} strokeWidth={1.7} aria-hidden="true" /></div>
        <div className="wk-kicker">Rest day</div>
        <h2 className="wk-hero__name">Recovery is training too</h2>
        <p className="wk-hero__lede">Nothing is scheduled today. Eat well, sleep well, or log something light.</p>
        <div className="wk-hero__row">
          <button type="button" className="btn flex-1" onClick={onAddCardio}>Add cardio</button>
          {onBuild && <button type="button" className="btn flex-1" onClick={onBuild}>Build a session</button>}
        </div>
      </section>
    );
  }

  const done = workout.status === 'completed';
  const exCount = meta.exerciseCount || (workout.exercises || []).length;
  const sets = meta.totalSets || (workout.exercises || []).reduce((s, e) => s + (Number(e.sets) || 0), 0);
  const ready = suggestions.filter(loadedTarget).length;
  const kcal = done && meta.calorie?.source === 'persisted' ? meta.calorie.estimated_active_kcal : null;
  const muscles = focus.map((f) => f.muscle);

  return (
    <section className={`wk-hero${done ? ' is-done' : ''}`}>
      <div className="wk-hero__top">
        <div className="min-w-0">
          <div className="wk-kicker">{done ? 'Done today' : 'Today'}</div>
          <h2 className="wk-hero__name">{workout.name}</h2>
        </div>
        <button type="button" className="wk-iconbtn" onClick={onShare} aria-label="Share this workout">
          <Share2 size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="wk-hero__body">
        <BodyFocus muscles={muscles} />
        <dl className="wk-stats">
          <div className="wk-stat"><dt>Exercises</dt><dd>{exCount}</dd></div>
          <div className="wk-stat"><dt>Sets</dt><dd>{sets}</dd></div>
          {done ? (
            <div className="wk-stat"><dt>Active burn</dt><dd>{kcal != null ? `${kcal} kcal` : '—'}</dd></div>
          ) : (
            <div className="wk-stat"><dt>About</dt><dd>{meta.estMinutes ? `${meta.estMinutes} min` : '—'}</dd></div>
          )}
        </dl>
      </div>

      {!done && ready > 0 && (
        <div className="wk-note">
          <TrendingUp size={15} strokeWidth={2} aria-hidden="true" />
          {ready === 1 ? '1 lift is ready to progress today' : `${ready} lifts are ready to progress today`}
        </div>
      )}

      {done ? (
        <p className="wk-hero__lede">Session logged. See it in your history, or build another if you are not finished.</p>
      ) : (
        <StartButton onStart={onStart} starting={starting} disabled={!exCount} />
      )}
    </section>
  );
}

/** The week as one row: the day's letter, a mark for what it holds, a tick
 *  once it is done. Names live in the preview a tap opens -- seven names in
 *  a phone's width were only ever seven truncated fragments. */
export function WeekStrip({ rows = [], todayDow, doneDows = new Set(), programName, onPick }) {
  if (!rows.length) return null;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDow = new Map(rows.map((d, i) => [d.day_of_week, { d, i }]));
  const training = rows.filter((d) => d.name !== 'Rest').length;
  return (
    <section className="wk-card wk-week" aria-label="This week">
      <div className="wk-head">
        <span className="wk-h">This week</span>
        <span className="wk-head__aside">{programName ? `${programName} · ` : ''}{training} training days</span>
      </div>
      <div className="wk-week__row">
        {order.map((dow) => {
          const hit = byDow.get(dow);
          if (!hit) return <span key={dow} className="wk-day is-empty" />;
          const { d, i } = hit;
          const rest = d.name === 'Rest';
          const isToday = dow === todayDow;
          const done = doneDows.has(dow);
          return (
            <button key={dow} type="button" onClick={() => onPick(d, i)}
              className={`wk-day${isToday ? ' is-today' : ''}${rest ? ' is-rest' : ''}${done ? ' is-done' : ''}`}
              aria-current={isToday ? 'date' : undefined}
              aria-label={`${d.label}: ${rest ? 'rest day' : d.name}${done ? ', done' : ''}`}>
              <span className="wk-day__l">{d.label.slice(0, 1)}</span>
              <span className="wk-day__mark" aria-hidden="true">
                {done ? '✓' : rest ? '' : <i />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ToolGrid({ tools }) {
  return (
    <section className="wk-tools" aria-label="Workout tools">
      {tools.map(({ key, label, icon: I, onClick }) => (
        <button key={key} type="button" className="wk-tool" onClick={onClick}>
          <I size={20} strokeWidth={1.7} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </section>
  );
}

/** Today's plan as a list a person reads top to bottom. The coach's cues,
 *  muscles and equipment open in place behind each row's info button. */
export function PlanList({ exercises = [], equipMap = {}, suggestionByEx = {}, infoEx, onToggleInfo, u }) {
  if (!exercises.length) return null;
  return (
    <section aria-label="Today's exercises">
      <div className="wk-head">
        <span className="wk-h">Today&rsquo;s exercises</span>
        <span className="wk-head__aside">{exercises.length}</span>
      </div>
      <ol className="wk-card wk-plan">
        {exercises.map((ex, i) => {
          const open = infoEx === ex.id;
          const eq = equipMap[ex.id];
          const s = suggestionByEx[ex.id];
          const up = loadedTarget(s);
          const w = planWeight(ex.weight, u);
          return (
            <li key={ex.id} className={`wk-ex${open ? ' is-open' : ''}`}>
              <div className="wk-ex__row">
                <span className="wk-ex__n" aria-hidden="true">{i + 1}</span>
                <div className="wk-ex__body">
                  <div className="wk-ex__name">
                    {exerciseLabel(ex.name)}
                    {eq?.missing?.length > 0 && (
                      <span className="wk-ex__warn" title={`Needs: ${eq.required.join(', ')}`} aria-label={`Needs ${eq.missing.join(', ')}`}>
                        <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
                      </span>
                    )}
                  </div>
                  <div className="wk-ex__meta">
                    {ex.sets} × {ex.reps}{w ? ` · ${w}` : ''}
                    {up && <span className="wk-up"><TrendingUp size={12} strokeWidth={2.2} aria-hidden="true" />{u.fmtWeight(s.suggested.weight)}</span>}
                  </div>
                </div>
                <button type="button" className={`wk-iconbtn wk-iconbtn--sm${open ? ' is-on' : ''}`}
                  aria-label={`About ${exerciseLabel(ex.name)}`} aria-expanded={open} onClick={() => onToggleInfo(ex.id)}>
                  <Info size={15} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
              {open && (
                <div className="wk-ex__info">
                  <div className="wk-chips">
                    {[ex.primary_muscle, ex.equipment, ex.difficulty].filter(Boolean).map((t) => (
                      <span key={t} className="wk-chip">{String(t).replace(/_/g, ' ').toLowerCase()}</span>
                    ))}
                  </div>
                  {/* Coaching cues come from the exercise library and are
                      already in this payload. Without them the line says so
                      rather than inventing form advice. */}
                  <p>
                    {ex.cues || ex.notes
                      || `${ex.sets} sets of ${ex.reps}${ex.rest_sec ? `, about ${ex.rest_sec}s rest between sets` : ''}. No form notes from your coach for this one yet.`}
                  </p>
                  {ex.secondary_muscles && <p className="wk-faint">Also works {String(ex.secondary_muscles).replace(/_/g, ' ').toLowerCase()}.</p>}
                  {s && <p className="wk-faint">{s.rationale}</p>}
                  {eq?.missing?.length > 0 && (
                    <p className="wk-faint">
                      Needs {eq.missing.join(', ').toLowerCase()}
                      {eq.alternatives?.length ? ` — try ${eq.alternatives.slice(0, 2).map((a) => a.name).join(' or ')} instead.` : '.'}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function SectionLink({ label, onClick }) {
  return (
    <button type="button" className="wk-head__link" onClick={onClick}>
      {label}<ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
