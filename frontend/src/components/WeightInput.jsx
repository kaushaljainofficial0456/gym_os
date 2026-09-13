/**
 * Inputs whose STORED value is canonical (kilograms, centimetres) and
 * whose TEXT is whatever the reader typed in their own unit.
 *
 * Shared by the live workout logger, the past-workout form and the goal
 * editor so those three cannot drift apart on how a typed number becomes
 * a stored one -- which is the only way a series ends up holding a mix of
 * kilograms and pounds that no later formatter can untangle.
 */
import { useEffect, useRef, useState } from 'react';
import { useUnits } from '../unitsContext.jsx';

/**
 * The shared machinery. The obvious implementation -- format the
 * canonical prop on every render -- is unusable in practice: the moment
 * the text is re-derived from the number on each keystroke, a decimal
 * point cannot survive being typed ("74." parses to 74 and formats back
 * to "74", eating the dot), and in imperial every keystroke also picks up
 * rounding noise. So the typed string is held locally and only re-synced
 * when the canonical value changes from OUTSIDE -- a restored draft,
 * add-set copying the row above, a form loading its data, or a unit
 * switch.
 */
function CanonicalInput({
  value, onChange, toDisplay, fromDisplay, step,
  ariaLabel, className, style, placeholder, emptyValue = 0, min,
}) {
  const u = useUnits();
  const toText = (v) => {
    const n = toDisplay(v);
    return n == null ? '' : String(n);
  };
  const [text, setText] = useState(() => toText(value));
  const emitted = useRef(value);

  useEffect(() => {
    if (value !== emitted.current) { emitted.current = value; setText(toText(value)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // A unit switch must redraw the field, and only the field -- the stored
  // canonical number does not move.
  useEffect(() => {
    emitted.current = value;
    setText(toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u.system]);

  const handle = (e) => {
    const next = e.target.value;
    setText(next);
    const parsed = next.trim() === '' ? emptyValue : fromDisplay(next);
    const out = Number.isFinite(parsed) ? parsed : emptyValue;
    emitted.current = out;
    onChange(out);
  };

  return (
    <input
      type="number" inputMode="decimal" step={step} min={min}
      className={className} style={style} value={text}
      aria-label={ariaLabel} placeholder={placeholder}
      onChange={handle}
    />
  );
}

/** Stores kilograms. */
export default function WeightInput({ valueKg, onChangeKg, emptyValue = 0, ...rest }) {
  const u = useUnits();
  return (
    <CanonicalInput
      value={valueKg}
      onChange={onChangeKg}
      emptyValue={emptyValue}
      toDisplay={(kg) => u.weightNum(kg, { decimals: 1 })}
      fromDisplay={(text) => u.toKg(text)}
      step={u.isImperial ? '1' : '0.5'}
      {...rest}
    />
  );
}

/** Stores centimetres. */
export function LengthInput({ valueCm, onChangeCm, emptyValue = 0, ...rest }) {
  const u = useUnits();
  return (
    <CanonicalInput
      value={valueCm}
      onChange={onChangeCm}
      emptyValue={emptyValue}
      toDisplay={(cm) => u.lengthNum(cm, { decimals: u.isImperial ? 1 : 0 })}
      fromDisplay={(text) => u.toCm(text)}
      step={u.isImperial ? '0.5' : '1'}
      {...rest}
    />
  );
}
