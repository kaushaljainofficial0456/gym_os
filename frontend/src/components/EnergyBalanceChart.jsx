/**
 * ENERGY BALANCE OVER TIME — did the last fortnight actually add up to a
 * cut, or did it just feel like one?
 *
 * A single day's net figure is noise. Ate late, trained hard, skipped
 * logging lunch — any one day proves nothing. The SHAPE over a fortnight
 * is the whole story, and it was the one view the app could not produce.
 *
 * DRAWN AS BARS FROM A ZERO LINE, not as a trend line. The sign is the
 * meaning here: a line through +400, −300, +700 invites you to read the
 * slope, when what matters is which side of nothing each day fell on and
 * by how much. Bars growing up and down from a shared baseline make that
 * unmissable, and the running total underneath says where it all landed.
 *
 * COLOUR ENCODES DIRECTION, NOT JUDGEMENT. A deficit is not a win — it is
 * a win if you are cutting and a problem if you are bulking, and this
 * chart is not told which. So surplus and deficit get two distinct hues
 * and neither gets a tick or a cross.
 *
 * DAYS WITH NOTHING LOGGED ARE DRAWN AS GAPS, not as zeroes. A zero means
 * "I ate nothing and burned nothing", which never happened. An untracked
 * day is missing information and has to look like missing information.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const RANGES = [
  { key: 7, label: '7d' },
  { key: 14, label: '14d' },
  { key: 30, label: '30d' },
  { key: 90, label: '90d' },
];

const SURPLUS = 'var(--warn)';
const DEFICIT = 'var(--good)';

const fmtSigned = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n)).toLocaleString()}`);

function shortDate(key) {
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function EnergyBalanceChart() {
  const [days, setDays] = useState(14);
  const [custom, setCustom] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(null);   // date key of the tapped bar

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/me/energy/balance?days=${days}`)
      .then((r) => { if (alive) { setData(r); setErr(null); } })
      .catch((e) => { if (alive) setErr(e.message || 'Could not load your balance'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const model = useMemo(() => {
    const all = data?.days || [];
    // A day is only PLOTTABLE if we could compute a net for it and
    // something was actually logged. Everything else is a gap.
    const plottable = all.filter((d) => d.netKcal != null && (d.intakeKcal > 0 || d.burn.workoutKcal > 0 || d.burn.cardioKcal > 0));
    const values = plottable.map((d) => d.netKcal);
    const peak = values.length ? Math.max(...values.map((v) => Math.abs(v)), 1) : 1;
    const total = values.reduce((s, v) => s + v, 0);
    return {
      all,
      plottable,
      peak,
      total,
      avg: values.length ? Math.round(total / values.length) : null,
      surplusDays: values.filter((v) => v > 0).length,
      deficitDays: values.filter((v) => v < 0).length,
    };
  }, [data]);

  const applyCustom = () => {
    const n = parseInt(custom, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 365) { setDays(n); setPicked(null); }
    setCustom('');
  };

  const shown = picked ? model.all.find((d) => d.date === picked) : null;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1.5">
          {RANGES.map((r) => {
            const on = days === r.key;
            return (
              <button
                key={r.key} type="button" onClick={() => { setDays(r.key); setPicked(null); }}
                aria-pressed={on}
                className="rounded-full px-3 text-[11.5px] font-semibold transition-colors"
                style={{
                  minHeight: 34,
                  background: on ? 'var(--cta-solid)' : 'transparent',
                  color: on ? 'var(--cta-ink)' : 'var(--mute)',
                  border: `1px solid ${on ? 'var(--cta-edge)' : 'var(--line)'}`,
                }}
              >{r.label}</button>
            );
          })}
        </div>

        {/* Any number of days, because "my cut started 23 days ago" is a
            real question and a fixed shelf of presets cannot answer it. */}
        <form
          onSubmit={(e) => { e.preventDefault(); applyCustom(); }}
          className="flex items-center gap-1.5"
        >
          <input
            type="number" min="1" max="365" inputMode="numeric"
            value={custom} onChange={(e) => setCustom(e.target.value)}
            placeholder={String(days)} aria-label="Show a custom number of days"
            className="input w-16 text-right tabular-nums"
            style={{ minHeight: 34, fontSize: 12 }}
          />
          <span className="text-[11px]" style={{ color: 'var(--faint)' }}>days</span>
          <button
            type="submit" disabled={!custom}
            className="rounded-full px-2.5 text-[11px] font-semibold disabled:opacity-35"
            style={{ minHeight: 34, border: '1px solid var(--line)', color: 'var(--mute)' }}
          >Go</button>
        </form>
      </div>

      {loading && (
        <div className="py-10 text-center text-[11.5px]" style={{ color: 'var(--faint)' }}>Loading…</div>
      )}

      {!loading && err && (
        <div role="alert" className="py-8 text-center text-[11.5px]" style={{ color: 'var(--bad)' }}>{err}</div>
      )}

      {!loading && !err && data?.missing?.length > 0 && (
        <div className="py-8 text-center">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
            Add your {data.missing.join(', ')} first
          </div>
          <div className="text-[11px] mt-1 leading-snug px-4" style={{ color: 'var(--faint)' }}>
            Your resting burn can't be estimated without them — and without that there is no
            surplus or deficit to chart, only what you ate.
          </div>
        </div>
      )}

      {!loading && !err && !data?.missing?.length && !model.plottable.length && (
        <div className="py-8 text-center">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>Nothing logged in this range</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>
            Log your food and training and this fills in day by day.
          </div>
        </div>
      )}

      {!loading && !err && model.plottable.length > 0 && (
        <>
          {/* ── the bars ── */}
          <div className="mt-4 overflow-x-auto -mx-1 px-1" style={{ scrollbarWidth: 'none' }}>
            <div
              className="flex items-stretch gap-[3px]"
              style={{ height: 150, minWidth: Math.max(model.all.length * 10, 260) }}
              role="img"
              aria-label={`Net energy balance for the last ${days} days. ${model.surplusDays} days in surplus, ${model.deficitDays} in deficit.`}
            >
              {model.all.map((d) => {
                const v = d.netKcal;
                const logged = v != null && (d.intakeKcal > 0 || d.burn.workoutKcal > 0 || d.burn.cardioKcal > 0);
                const frac = logged ? Math.abs(v) / model.peak : 0;
                const up = logged && v > 0;
                const on = picked === d.date;

                return (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => setPicked(on ? null : d.date)}
                    aria-label={logged ? `${shortDate(d.date)}: ${fmtSigned(v)} kcal` : `${shortDate(d.date)}: nothing logged`}
                    className="relative flex-1 min-w-[6px] flex flex-col"
                    style={{ opacity: picked && !on ? 0.45 : 1, transition: 'opacity .15s' }}
                  >
                    {/* top half = surplus */}
                    <div className="flex-1 flex flex-col justify-end">
                      {up && (
                        <div className="rounded-t-[3px] w-full" style={{ height: `${frac * 100}%`, background: SURPLUS }} />
                      )}
                    </div>
                    {/* the zero line itself */}
                    <div style={{ height: 1, background: on ? 'var(--ink)' : 'var(--line)' }} />
                    {/* bottom half = deficit */}
                    <div className="flex-1">
                      {logged && v < 0 && (
                        <div className="rounded-b-[3px] w-full" style={{ height: `${frac * 100}%`, background: DEFICIT }} />
                      )}
                      {/* A day with nothing logged draws no bar at all, on
                          either side -- a zero-height bar at the baseline
                          would read as "perfectly balanced". */}
                      {!logged && (
                        <div className="w-full" style={{ height: 3, background: 'var(--line)', opacity: .7 }} />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between text-[9.5px] mt-1.5 tabular-nums" style={{ color: 'var(--faint)' }}>
            <span>{shortDate(model.all[0]?.date)}</span>
            <span>{shortDate(model.all[model.all.length - 1]?.date)}</span>
          </div>

          {/* ── the tapped day, or the period summary ── */}
          {shown ? (
            <div className="mt-3 rounded-xl p-3" style={{ border: '1px solid var(--line)' }}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11.5px] font-semibold" style={{ color: 'var(--ink)' }}>{shortDate(shown.date)}</span>
                <span className="font-grotesk text-[16px] font-black tabular-nums"
                      style={{ color: shown.netKcal > 0 ? SURPLUS : shown.netKcal < 0 ? DEFICIT : 'var(--mute)' }}>
                  {fmtSigned(shown.netKcal)}
                </span>
              </div>
              <div className="text-[10.5px] mt-1 tabular-nums" style={{ color: 'var(--mute)' }}>
                Ate {shown.intakeKcal?.toLocaleString() ?? '—'} · burned {shown.burn.totalKcal?.toLocaleString() ?? '—'}
                {shown.burn.workoutKcal > 0 ? ` (${shown.burn.workoutKcal} training)` : ''}
              </div>
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Avg / day</div>
                <div className="font-grotesk text-[17px] font-black tabular-nums mt-0.5"
                     style={{ color: model.avg > 0 ? SURPLUS : model.avg < 0 ? DEFICIT : 'var(--ink)' }}>
                  {fmtSigned(model.avg)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Total</div>
                <div className="font-grotesk text-[17px] font-black tabular-nums mt-0.5"
                     style={{ color: model.total > 0 ? SURPLUS : model.total < 0 ? DEFICIT : 'var(--ink)' }}>
                  {fmtSigned(model.total)}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] font-semibold uppercase tracking-[.06em]" style={{ color: 'var(--faint)' }}>Days</div>
                <div className="text-[11px] mt-1 tabular-nums" style={{ color: 'var(--mute)' }}>
                  <span style={{ color: SURPLUS }}>{model.surplusDays}</span> up ·{' '}
                  <span style={{ color: DEFICIT }}>{model.deficitDays}</span> down
                </div>
              </div>
            </div>
          )}

          <div className="text-[10px] mt-3 leading-snug" style={{ color: 'var(--faint)' }}>
            {/* ~7,700 kcal per kg of body fat is the standard figure. Given
                as a rough consequence, not a prediction -- the inputs are
                estimates and compounding them into a promise would be
                dishonest. */}
            {model.plottable.length >= 3 && Math.abs(model.total) > 3000 ? (
              <>Over these {model.plottable.length} logged days that's roughly{' '}
                <strong style={{ color: 'var(--mute)' }}>
                  {(Math.abs(model.total) / 7700).toFixed(1)} kg
                </strong>{' '}
                of {model.total > 0 ? 'gain' : 'loss'} in energy terms — a rough guide, not a promise.
              </>
            ) : (
              <>Bars above the line are days you ate more than you burned; below, less. Tap one for its detail.</>
            )}
          </div>
        </>
      )}
    </div>
  );
}
