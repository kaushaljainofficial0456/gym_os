/**
 * NET ENERGY — the one number a cut or a bulk actually runs on.
 *
 * The app showed what you ate and, elsewhere, roughly what you burned,
 * and never subtracted one from the other. "2,800 in, 2,600 out" is two
 * facts; "+200" is the answer, and it was the answer nobody could see.
 *
 * CLOSED IT IS ONE FIGURE AND ONE WORD. Surplus or deficit, today. That
 * is what you check, and checking it should cost a glance — not a tap, a
 * scroll, and some mental arithmetic against a ring.
 *
 * OPEN IT SHOWS ITS WORKING, because an estimate you cannot interrogate
 * is an estimate you stop believing the first time it looks wrong. Every
 * component is named and attributed: resting energy from your body, the
 * sessions you logged, the food you logged.
 *
 * WHEN IT CANNOT KNOW, IT SAYS SO AND SAYS WHAT IS MISSING. Mifflin-St
 * Jeor needs weight, height, age and sex; without all four there is no
 * honest figure. Showing "intake minus the bits we have" would hand
 * everyone with a half-filled profile a spectacular fictional surplus,
 * and it would look exactly like a working feature.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

const fmt = (n) => (n == null ? '—' : Math.abs(Math.round(n)).toLocaleString());

/** A deficit is not a win and a surplus is not a failure — which one is
 *  "good" depends entirely on whether you are cutting or bulking, and
 *  this component is not told. So the colour encodes DIRECTION, never
 *  judgement, and the words stay flat. */
function toneFor(net, t) {
  if (net == null) return { fg: t.mute, bg: 'transparent' };
  if (net > 0) return { fg: t.carbs, bg: 'rgb(var(--warn-rgb) / .10)' };
  if (net < 0) return { fg: t.fat, bg: 'rgb(var(--good-rgb) / .10)' };
  return { fg: t.mute, bg: 'transparent' };
}

function Line({ label, value, sub, t, strong, sign }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[12px]" style={{ color: strong ? t.ink : t.mute, fontWeight: strong ? 700 : 500 }}>
          {label}
        </div>
        {sub && <div className="text-[10px] mt-0.5 leading-snug" style={{ color: t.faint }}>{sub}</div>}
      </div>
      <div className="font-grotesk text-[13px] font-bold tabular-nums shrink-0" style={{ color: strong ? t.ink : t.mute }}>
        {sign}{fmt(value)}
      </div>
    </div>
  );
}

export default function NetEnergyCard({ t, refreshKey }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/me/energy/balance?days=1')
      .then((r) => { if (alive) { setData(r); setErr(false); } })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [refreshKey]);

  // Absent rather than broken: a card that cannot say anything yet should
  // not occupy the screen explaining that.
  if (err || !data || !data.today) return null;

  const today = data.today;
  const net = today.netKcal;
  const tone = toneFor(net, t);
  const known = net != null;

  const word = !known ? '' : net > 0 ? 'surplus' : net < 0 ? 'deficit' : 'even';

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: t.surface, border: `1px solid ${t.border}` }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full text-left px-4 py-3.5 flex items-center gap-3 transition-colors"
        style={{ background: tone.bg, minHeight: 64 }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-semibold uppercase tracking-[.12em]" style={{ color: t.faint }}>
            Net energy today
          </div>

          {known ? (
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="font-grotesk font-black tabular-nums leading-none"
                    style={{ fontSize: 30, color: tone.fg }}>
                {net > 0 ? '+' : net < 0 ? '−' : ''}{fmt(net)}
              </span>
              <span className="font-grotesk text-[12px] font-semibold" style={{ color: t.mute }}>
                kcal {word}
              </span>
            </div>
          ) : (
            <div className="text-[12.5px] font-semibold mt-1" style={{ color: t.ink }}>
              Add your {data.missing.slice(0, 2).join(' and ')} to see this
            </div>
          )}

          {known && today.partialDay && (
            <div className="text-[10px] mt-1" style={{ color: t.faint }}>
              So far today — resting burn is counted as the day passes.
            </div>
          )}
          {!known && (
            <div className="text-[10px] mt-1 leading-snug" style={{ color: t.faint }}>
              Your burn can't be estimated without them, and a made-up number is worse than none.
            </div>
          )}
        </div>

        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={t.faint} strokeWidth="2.4"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
             style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: `1px solid ${t.border}` }}>
          <div className="text-[9.5px] font-semibold uppercase tracking-[.12em] mt-3 mb-0.5"
               style={{ color: t.faint }}>In</div>
          <Line t={t} label="Food logged" value={today.intakeKcal} strong sign="" />

          <div className="text-[9.5px] font-semibold uppercase tracking-[.12em] mt-3 mb-0.5"
               style={{ color: t.faint }}>Out</div>
          <Line t={t} label="Resting energy"
                sub={today.partialDay ? 'What your body uses doing nothing, so far today' : 'What your body uses doing nothing'}
                value={today.burn.restingKcal} />
          <Line t={t} label="Workouts" sub="Above resting, from the sessions you logged"
                value={today.burn.workoutKcal} />
          <Line t={t} label="Cardio & sport" sub="Above resting, from bouts you logged"
                value={today.burn.cardioKcal} />
          <div style={{ borderTop: `1px solid ${t.border}` }} className="mt-1.5 pt-1.5">
            <Line t={t} label="Total burn" value={today.burn.totalKcal} strong />
          </div>

          <div className="mt-3 pt-3 flex items-baseline justify-between gap-3"
               style={{ borderTop: `1px solid ${t.border}` }}>
            <span className="text-[12px] font-bold" style={{ color: t.ink }}>
              Net {known ? word : ''}
            </span>
            <span className="font-grotesk text-[17px] font-black tabular-nums" style={{ color: tone.fg }}>
              {known ? `${net > 0 ? '+' : net < 0 ? '−' : ''}${fmt(net)}` : '—'}
            </span>
          </div>

          <p className="text-[10px] mt-3 leading-snug" style={{ color: t.faint }}>
            Every figure here except the food you logged is an ESTIMATE — resting energy from a
            standard formula, exercise from models of effort. Good for comparing your week to your
            last one; not a measurement.
          </p>
        </div>
      )}
    </div>
  );
}
