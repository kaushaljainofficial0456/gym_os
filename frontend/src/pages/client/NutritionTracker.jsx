import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, cls } from '../../utils.js';
import { ErrorState, Empty, Seg, Kpi, Bar, PageSkeleton } from '../../components/UI.jsx';
import { WeekBars, TrendChart } from '../../components/charts.jsx';
import Icon from '../../components/Icon.jsx';

/* ════════════════════════════════════════════════════════════════
   Local-date helpers — plain YYYY-MM-DD arithmetic only, NEVER through
   Date.toISOString()/UTC string parsing. `new Date('2026-01-15')` parses
   as UTC midnight; formatting it back with a UTC-behind local clock can
   render "Jan 14" — the exact off-by-one class of bug a calendar can't
   afford. Every function here uses the local-time Date constructor with
   numeric (y, m, d) arguments, which never crosses a timezone boundary.
   ════════════════════════════════════════════════════════════════ */
const pad2 = (n) => String(n).padStart(2, '0');
const toKey = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`; // m is 0-indexed
const parseKey = (key) => { const [y, m, d] = key.split('-').map(Number); return { y, m: m - 1, d }; };
const todayKey = () => { const d = new Date(); return toKey(d.getFullYear(), d.getMonth(), d.getDate()); };
const daysAgoKey = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return toKey(d.getFullYear(), d.getMonth(), d.getDate()); };
const monthLabel = (y, m) => new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const dayLabel = (key) => { const { y, m, d } = parseKey(key); return new Date(y, m, d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }); };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

function monthCells(y, m) {
  const firstDow = new Date(y, m, 1).getDay(); // 0=Sun
  const total = daysInMonth(y, m);
  const cells = Array(firstDow).fill(null);
  for (let d = 1; d <= total; d++) cells.push(toKey(y, m, d));
  return cells;
}

// Every date in [fromKey, toKey], inclusive — used to tell "not logged"
// apart from "not yet fetched" for the history section.
function enumerateDates(fromKey, toKey_) {
  const { y: fy, m: fm, d: fd } = parseKey(fromKey);
  const { y: ty, m: tm, d: td } = parseKey(toKey_);
  const cur = new Date(fy, fm, fd);
  const end = new Date(ty, tm, td);
  const out = [];
  while (cur <= end) {
    out.push(toKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

const RANGE_OPTIONS = [
  { value: '7', label: '7D' },
  { value: '30', label: '30D' },
  { value: '90', label: '3M' },
  { value: '180', label: '6M' },
  { value: 'custom', label: 'Custom' },
];

const WEEKDAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function NutritionTracker() {
  // /tracking/me/home already resolves "my own client id" — the same
  // lookup every other client page (Progress, Home) uses. It's already
  // fetched once by the persistent ClientLayout, so it's reused here via
  // Outlet context instead of firing a second, redundant request.
  const home = useOutletContext();
  const clientId = home.data?.client?.id;

  const today = todayKey();
  const todayParts = parseKey(today);
  const [cursor, setCursor] = useState({ y: todayParts.y, m: todayParts.m }); // visible calendar month
  const [selected, setSelected] = useState(today);
  const [calendarOpen, setCalendarOpen] = useState(false); // collapsed by default -- see the CALENDAR section below
  const [range, setRange] = useState('30');
  const [customFrom, setCustomFrom] = useState(daysAgoKey(29));
  const [customTo, setCustomTo] = useState(today);

  const monthStart = toKey(cursor.y, cursor.m, 1);
  const monthEnd = toKey(cursor.y, cursor.m, daysInMonth(cursor.y, cursor.m));

  // Calendar month fetch — also the source for the selected-day detail
  // view, so picking any day within the visible month is an instant local
  // lookup, not a second network round trip.
  const cal = useFetch(
    () => (clientId ? api(`/nutrition/clients/${clientId}/history?from=${monthStart}&to=${monthEnd}`) : Promise.resolve(null)),
    [clientId, monthStart, monthEnd]
  );

  const histFrom = range === 'custom' ? (customFrom || daysAgoKey(29)) : daysAgoKey(Number(range) - 1);
  const histTo = range === 'custom' ? (customTo || today) : today;
  const hist = useFetch(
    () => (clientId && histFrom <= histTo ? api(`/nutrition/clients/${clientId}/history?from=${histFrom}&to=${histTo}`) : Promise.resolve(null)),
    [clientId, histFrom, histTo]
  );

  // Every hook (including this useMemo) must run unconditionally, before any
  // early return below -- React ties hook identity to call order, and a
  // hook that only runs once loading/error/clientId guards have passed
  // would be called on some renders and not others ("Rendered more hooks
  // than during the previous render").
  const histDates = useMemo(() => (histFrom <= histTo ? enumerateDates(histFrom, histTo) : []), [histFrom, histTo]);

  if (home.loading) return <PageSkeleton variant="dashboard" label="Loading your nutrition history" />;
  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;
  if (!clientId) return <ErrorState error={{ message: 'No client profile linked to this account' }} onRetry={home.reload} />;

  const goMonth = (delta) => {
    setCursor((c) => {
      let m = c.m + delta, y = c.y;
      if (m < 0) { m = 11; y -= 1; } else if (m > 11) { m = 0; y += 1; }
      // The selected-day detail below reads from THIS month's already-fetched
      // data (see the `cal` fetch above) rather than issuing a second request
      // -- so a selected date left over from a different month would silently
      // resolve to "no food logged" (falling out of `cal.data.days`) even on
      // a day that genuinely has logs, just not in the month now in view.
      // Moving the selection to the 1st of the newly-viewed month keeps it
      // always inside the data that's actually on screen.
      setSelected(toKey(y, m, 1));
      return { y, m };
    });
  };
  const goToday = () => { setCursor({ y: todayParts.y, m: todayParts.m }); setSelected(today); };

  const calDayMap = new Map((cal.data?.days || []).map((d) => [d.date, d]));
  const selectedDay = calDayMap.get(selected) || { date: selected, calories: 0, protein: 0, carbs: 0, fat: 0, logged: false, logs: [] };
  const target = cal.data?.target || null;

  // ---- history aggregates (client-side; range already fetched in one shot) ----
  const histByDate = new Map((hist.data?.days || []).map((d) => [d.date, d]));
  const loggedCount = hist.data?.days?.length || 0;
  const sums = (hist.data?.days || []).reduce((s, d) => ({
    calories: s.calories + d.calories, protein: s.protein + d.protein, carbs: s.carbs + d.carbs, fat: s.fat + d.fat
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const avgCal = loggedCount ? Math.round(sums.calories / loggedCount) : 0;
  const chartRows = histDates.map((date) => ({ date, label: date.slice(5), value: Math.round(histByDate.get(date)?.calories || 0) }));
  const chartMax = Math.max(200, ...chartRows.map((r) => r.value)) * 1.15;

  return (
    <div className="space-y-5 pb-2">
      <div>
        <h1 className="font-grotesk font-bold text-xl">Nutrition Tracker</h1>
        <div className="text-xs text-mute mt-0.5">Your full logging history, day by day.</div>
      </div>

      {/* ═══ 1. CALENDAR ═══
          Collapsed by default -- most visits are "how did today go", which
          the selected-day view below already answers without a full grid
          on screen. The grid only appears once someone actually wants to
          browse a previous date, via the toggle below. */}
      <div className="card p-4">
        <button
          className="w-full flex items-center justify-between"
          onClick={() => setCalendarOpen((o) => !o)}
          aria-expanded={calendarOpen}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0" style={{ color: 'var(--accent)' }}><Icon name="chart" size={16} /></span>
            <span className="font-grotesk font-bold text-sm truncate">{calendarOpen ? monthLabel(cursor.y, cursor.m) : dayLabel(selected)}</span>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-mute font-grotesk shrink-0">
            {calendarOpen ? 'Collapse' : 'Browse dates'}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 style={{ transform: calendarOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }}>
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </button>

        {calendarOpen && (
          <div className="mt-3 anim-fadeUp">
            <div className="flex items-center justify-between mb-3">
              <button className="btn-ghost !p-2" onClick={() => goMonth(-1)} aria-label="Previous month">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3 5 8l5 5" /></svg>
              </button>
              <div className="flex items-center gap-2.5">
                <div className="font-grotesk font-bold text-sm">{monthLabel(cursor.y, cursor.m)}</div>
                <button className="chip border-line text-[10px]" onClick={goToday}>Today</button>
              </div>
              <button className="btn-ghost !p-2" onClick={() => goMonth(1)} aria-label="Next month">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 3l5 5-5 5" /></svg>
              </button>
            </div>

            {cal.error ? (
              <ErrorState error={cal.error} onRetry={cal.reload} />
            ) : (
              <>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {WEEKDAY_SHORT.map((w, i) => (
                    <div key={i} className="t-micro text-center py-1">{w}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthCells(cursor.y, cursor.m).map((key, i) => {
                    if (!key) return <div key={`pad${i}`} />;
                    const isToday = key === today;
                    const isSelected = key === selected;
                    const logged = calDayMap.has(key);
                    const { d } = parseKey(key);
                    return (
                      <button
                        key={key}
                        onClick={() => setSelected(key)}
                        disabled={cal.loading}
                        className="aspect-square rounded-lg border text-center relative transition-all active:scale-95 disabled:opacity-50"
                        style={{
                          borderColor: isSelected ? 'var(--accent)' : 'var(--line)',
                          background: isSelected ? 'var(--accent-soft)' : isToday ? 'var(--panel2)' : 'var(--panel)',
                        }}
                      >
                        <span className="text-[11px] font-grotesk" style={{ color: isSelected ? 'var(--accent)' : 'var(--ink)', fontWeight: isToday || isSelected ? 700 : 400 }}>{d}</span>
                        {logged && (
                          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full" style={{ background: isSelected ? 'var(--accent)' : 'var(--good)' }} />
                        )}
                      </button>
                    );
                  })}
                </div>
                {cal.loading && <div className="text-center text-[10px] text-faint mt-2">Loading…</div>}
              </>
            )}
          </div>
        )}
      </div>

      {/* ═══ 2. SELECTED-DAY VIEW ═══ */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="font-grotesk font-bold text-sm">{dayLabel(selected)}</div>
          {selected === today && <span className="chip border-gold/30 text-gold !text-[9px]">Today</span>}
        </div>

        {selectedDay.logs.length === 0 ? (
          <Empty title="No food logged this day" hint="Nothing was recorded for this date." icon="food" />
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 mb-4">
              <Kpi label="Calories" value={Math.round(selectedDay.calories)} />
              <Kpi label="Protein" value={Math.round(selectedDay.protein)} suffix="g" />
              <Kpi label="Carbs" value={Math.round(selectedDay.carbs)} suffix="g" />
              <Kpi label="Fat" value={Math.round(selectedDay.fat)} suffix="g" />
            </div>

            {target && (
              <div className="space-y-2.5 mb-4 p-3 rounded-xl" style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}>
                <div className="t-micro">Target vs actual</div>
                <Bar label="Calories" value={selectedDay.calories} max={target.calories || 1} right={`${Math.round(selectedDay.calories)} / ${target.calories} kcal`} />
                <Bar label="Protein" value={selectedDay.protein} max={target.protein || 1} right={`${Math.round(selectedDay.protein)} / ${target.protein} g`} height="h-1.5" />
                <Bar label="Carbs" value={selectedDay.carbs} max={target.carbs || 1} right={`${Math.round(selectedDay.carbs)} / ${target.carbs} g`} height="h-1.5" />
                <Bar label="Fat" value={selectedDay.fat} max={target.fat || 1} right={`${Math.round(selectedDay.fat)} / ${target.fat} g`} height="h-1.5" />
              </div>
            )}

            <div className="space-y-2">
              {selectedDay.logs.map((l) => (
                <div key={l.id} className="rounded-xl p-3 flex items-start gap-3" style={{ background: 'var(--panel2)', border: '1px solid var(--line)', opacity: l.eaten ? 1 : 0.55 }}>
                  <span className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }}><Icon name="food" size={16} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-grotesk font-semibold text-sm" style={{ color: 'var(--ink)' }}>{l.name}</span>
                      {l.slot && <span className="chip border-line !text-[8px] capitalize">{l.slot.replace(/_/g, ' ')}</span>}
                      {!l.eaten && <span className="chip border-line !text-[8px]">not eaten</span>}
                    </div>
                    <div className="text-[11px] text-mute mt-0.5">
                      {Math.round(l.calories)} kcal · P {Math.round(l.protein)}g · C {Math.round(l.carbs)}g · F {Math.round(l.fat)}g
                      {l.quantity != null && l.unit ? ` · ${l.quantity} ${l.unit}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ═══ 3. HISTORY ═══ */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="font-grotesk font-bold text-sm">History</div>
          <Seg options={RANGE_OPTIONS} value={range} onChange={setRange} />
        </div>

        {range === 'custom' && (
          <div className="flex items-center gap-2 mb-3">
            <input type="date" className="input flex-1 !text-xs" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
            <span className="text-mute text-xs">to</span>
            <input type="date" className="input flex-1 !text-xs" value={customTo} min={customFrom} max={today} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}

        {hist.error ? (
          <ErrorState error={hist.error} onRetry={hist.reload} />
        ) : hist.loading ? (
          <div className="text-center py-8 text-[11px] text-faint">Loading…</div>
        ) : loggedCount === 0 ? (
          <Empty title="No logs in this range" hint="Nothing was recorded for the selected period." icon="food" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <Kpi label="Avg calories" value={avgCal} sub={`per logged day`} />
              <Kpi label="Days logged" value={loggedCount} sub={`of ${histDates.length}`} />
              <Kpi label="Avg protein" value={loggedCount ? Math.round(sums.protein / loggedCount) : 0} suffix="g" />
            </div>

            <div className="t-micro mb-1">Daily calories</div>
            {Number(range) <= 7 && range !== 'custom' ? (
              <WeekBars days={chartRows} valueKey="value" max={chartMax} color="var(--accent)" />
            ) : (
              <TrendChart data={chartRows} color="var(--accent)" domain={[0, chartMax]} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
