/**
 * Cardio, live. One panel wherever cardio is running -- on its own, or
 * alongside a lifting session -- instead of three hand-copied variants.
 *
 * Settings are CONTROLLED inputs. The copies this replaces read their own
 * fields back with document.getElementById under ids that differed only
 * by prefix, so two panels on screen at once (cardio beside a session)
 * could read each other's boxes.
 *
 * Changing a setting closes the current segment and starts a new one --
 * the timer never stops -- so a run that went from 8 to 10 km/h is
 * costed as both, not as whichever speed it ended on.
 */
import { useEffect, useState } from 'react';
import { clock } from './SessionView.jsx';

/** Parameter form for one activity, used to add it and to adjust it. */
export function CardioParamsForm({ fields = [], initial = {}, submitLabel, onSubmit, idPrefix }) {
  const [vals, setVals] = useState(() => ({ ...initial }));
  useEffect(() => { setVals({ ...initial }); }, [JSON.stringify(initial)]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const v = vals[f.key];
      if (v !== '' && v != null) out[f.key] = v;
    }
    onSubmit(out);
  };
  return (
    <form className="wk-params" onSubmit={submit}>
      {fields.map((f) => (
        <label key={f.key} className="wk-params__field" htmlFor={`${idPrefix}-${f.key}`}>
          <span>{f.label}</span>
          <span className="wk-params__box">
            <input id={`${idPrefix}-${f.key}`} type="text" inputMode="decimal" className="input"
              placeholder={f.placeholder} value={vals[f.key] ?? ''}
              onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))} />
            {f.unit && <em>{f.unit}</em>}
          </span>
        </label>
      ))}
      <button type="submit" className="btn-primary btn-block">{submitLabel}</button>
    </form>
  );
}

export default function CardioLive({ name, elapsed, kcal, fields, currentParams = {}, segments = [], summarize, onAdjust, onEnd, idPrefix = 'cardio' }) {
  const [adjusting, setAdjusting] = useState(false);
  return (
    <section className="wk-card wk-cardio" aria-label={`Cardio: ${name}`}>
      <div className="wk-cardio__top">
        <div>
          <div className="wk-kicker">Cardio · {name}</div>
          <div className="wk-clock wk-clock--md" role="timer">{clock(elapsed)}</div>
        </div>
        <div className="wk-cardio__burn">
          <span>Estimated</span>
          <b>~{kcal}<small> kcal</small></b>
        </div>
      </div>

      {fields.length > 0 && (
        <div className="wk-chips">
          {fields.map((f) => (
            <span key={f.key} className="wk-chip">
              {f.label} <b>{currentParams[f.key] || '—'}</b>{f.unit ? ` ${f.unit}` : ''}
            </span>
          ))}
        </div>
      )}

      {segments.length > 0 && (
        <ol className="wk-segments">
          {segments.map((seg, i) => (
            <li key={i}>Segment {i + 1} · {Math.max(1, Math.round(seg.durationSec / 60))} min{summarize ? ` · ${summarize(seg.params)}` : ''}</li>
          ))}
        </ol>
      )}

      {adjusting && fields.length > 0 && (
        <CardioParamsForm fields={fields} initial={currentParams} idPrefix={`${idPrefix}-adj`}
          submitLabel="Update and keep going"
          onSubmit={(p) => { setAdjusting(false); onAdjust(p); }} />
      )}

      <div className="wk-cardio__actions">
        {fields.length > 0 && !adjusting && (
          <button type="button" className="btn flex-1" onClick={() => setAdjusting(true)}>Adjust settings</button>
        )}
        <button type="button" className="btn-primary flex-1" onClick={onEnd}>
          End cardio · {Math.max(0, Math.round(elapsed / 60))} min
        </button>
      </div>
    </section>
  );
}
