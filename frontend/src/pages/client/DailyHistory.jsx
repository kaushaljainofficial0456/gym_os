/**
 * DAILY HISTORY — "what actually happened on this day": the workouts run
 * (with per-exercise logged sets, not just what was assigned) and the
 * meals logged, for one specific date.
 *
 * Consumes the ALREADY-BUILT, already-tested backend endpoint
 * GET /tracking/me/day/:date (backend/src/routes/tracking.js). That
 * endpoint existed before this page did — merged in from
 * manavi-progress-enhancements-v2 with no frontend consumer at all — so
 * every field this page reads is real, persisted data, never invented
 * here.
 *
 * Reached from Workout.jsx's "Recent sessions" list (already links to
 * /app/client/day/:date for each past session) and from this page's own
 * date-adjacent Prev/Next, so a client can actually browse "what did I do
 * two days ago" instead of that link going nowhere.
 */
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, exerciseLabel } from '../../utils.js';
import { PageHeader, PageSkeleton, ErrorState, Empty, Card } from '../../components/UI.jsx';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-09-05" -> "Saturday, 5 September 2026". Parsed as local calendar
 *  fields (not `new Date(iso)`, which reads UTC midnight and can land on
 *  the PREVIOUS day for anyone west of UTC) -- the date param is already
 *  a plain day key, not a timestamp, so it should never be timezone-shifted. */
function formatDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!m) return key || '';
  const [, y, mo, d] = m;
  const dow = new Date(Number(y), Number(mo) - 1, Number(d)).getDay();
  return `${DOW[dow]}, ${Number(d)} ${MONTH[Number(mo) - 1]} ${y}`;
}

function shiftDateKey(key, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!m) return key;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d) + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export default function DailyHistory() {
  const { date } = useParams();
  const nav = useNavigate();
  const hist = useFetch(() => api(`/tracking/me/day/${date}`), [date]);
  const isFuture = date > todayKey();

  if (hist.loading) return <PageSkeleton variant="list" label="Loading that day" />;
  if (hist.error) return <ErrorState error={hist.error} onRetry={hist.reload} />;

  const data = hist.data || {};
  const workouts = data.workouts || [];
  const mealLogs = data.mealLogs || [];
  const eatenLogs = mealLogs.filter((l) => l.eaten);
  const nutrition = data.nutrition || { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const empty = workouts.length === 0 && mealLogs.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Daily history"
        title={formatDateKey(date)}
        onBack={() => nav(-1)}
        right={
          <div className="flex items-center gap-1.5">
            <button onClick={() => nav(`/app/client/day/${shiftDateKey(date, -1)}`, { replace: true })}
                    className="btn-ghost !px-2" aria-label="Previous day">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <button onClick={() => nav(`/app/client/day/${shiftDateKey(date, 1)}`, { replace: true })}
                    disabled={isFuture} className="btn-ghost !px-2 disabled:opacity-30" aria-label="Next day">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          </div>
        }
      />

      {empty && (
        <Empty title="Nothing logged this day" hint="No workout and no food logged — a rest day, or one this app has no record of." />
      )}

      {/* ── WORKOUTS ── */}
      {workouts.map((w) => {
        const exByExerciseId = new Map((w.exercises || []).map((ex) => [ex.exercise_id, ex]));
        return (
          <div key={w.id} className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="t-micro">{w.day_label || 'Workout'}</div>
                <h2 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>{w.name}</h2>
              </div>
              <span className={`chip ${w.status === 'completed' ? 'border-good/40 text-good bg-good/10' : w.status === 'missed' ? 'border-bad/40 text-bad bg-bad/10' : ''}`}>
                {w.status}
              </span>
            </div>

            {w.status === 'completed' && (w.duration_min || w.estimated_active_kcal) && (
              <div className="grid grid-cols-2 gap-2.5">
                {w.duration_min != null && (
                  <Card className="!p-3 text-center">
                    <div className="font-grotesk font-bold text-lg tabular-nums" style={{ color: 'var(--ink)' }}>{Math.round(w.duration_min)} min</div>
                    <div className="t-micro mt-0.5">Duration</div>
                  </Card>
                )}
                {w.estimated_active_kcal != null && (
                  <Card className="!p-3 text-center">
                    <div className="font-grotesk font-bold text-lg tabular-nums" style={{ color: 'var(--ink)' }}>~{Math.round(w.estimated_active_kcal)} kcal</div>
                    <div className="t-micro mt-0.5">Active burn</div>
                  </Card>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              {(w.exercises || []).map((ex) => {
                const log = (w.logs || []).find((l) => l.exercise_id === ex.exercise_id);
                return (
                  <Card key={ex.id} className="!p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{exerciseLabel(ex.name)}</span>
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--faint)' }}>
                        {ex.sets} × {ex.reps}{ex.weight && ex.weight !== 'BW' ? ` · ${ex.weight}` : ''}
                      </span>
                    </div>
                    {log?.sets?.length > 0 && (
                      <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid var(--line)' }}>
                        <div className="t-micro">Logged</div>
                        <div className="flex flex-wrap gap-1.5">
                          {log.sets.map((s) => (
                            <span key={s.id} className="text-[10px] tabular-nums px-2 py-1 rounded-lg"
                                  style={{ background: 'var(--tint)', color: s.completed ? 'var(--ink)' : 'var(--faint)' }}>
                              Set {s.set_number}: {s.actual_reps ?? '—'} × {s.actual_weight ?? 0}
                              {!s.completed && ' (skipped)'}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {!log?.sets?.length && exByExerciseId.get(ex.exercise_id) && w.status !== 'completed' && (
                      <div className="text-[10px] mt-1.5" style={{ color: 'var(--faint)' }}>Not logged</div>
                    )}
                  </Card>
                );
              })}
              {!(w.exercises || []).length && (
                <div className="text-[11px] py-2" style={{ color: 'var(--faint)' }}>No exercises on this session.</div>
              )}
            </div>
          </div>
        );
      })}

      {/* ── NUTRITION ── */}
      {mealLogs.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="t-micro">Nutrition</div>
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--mute)' }}>
              {Math.round(nutrition.calories)} kcal · P {round1(nutrition.protein)}g · C {round1(nutrition.carbs)}g · F {round1(nutrition.fat)}g
            </span>
          </div>
          <div className="space-y-1.5">
            {eatenLogs.map((l) => (
              <Card key={l.id} className="!p-3.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{l.name}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--faint)' }}>
                    {l.slot ? `${l.slot} · ` : ''}P {round1(l.protein)}g · C {round1(l.carbs)}g · F {round1(l.fat)}g
                  </div>
                </div>
                <span className="text-sm font-bold tabular-nums shrink-0" style={{ color: 'var(--ink)' }}>{Math.round(l.calories)} kcal</span>
              </Card>
            ))}
            {!eatenLogs.length && (
              <div className="text-[11px] py-2" style={{ color: 'var(--faint)' }}>Planned, but nothing marked eaten.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
