/**
 * UNITS CONTEXT — one fetch, one source of truth, no mixed units.
 *
 * The rule this exists to enforce is that no two parts of a screen can
 * disagree about which unit they are in. If each component decided for
 * itself -- reading the preference from wherever it happened to have the
 * data -- a chart could render its axis in kg while its tooltip said lb,
 * which is worse than having no preference at all.
 *
 * So the preference is fetched ONCE here and handed down. Components ask
 * this hook for a formatter; they never convert anything themselves and
 * they never see the raw preference unless they are the control that
 * changes it.
 *
 * OPTIMISTIC ON CHANGE, because the whole app re-renders in the new unit
 * and waiting on a round trip to do it feels broken. Reverted from the
 * server's own answer if the save fails, so the displayed unit always
 * ends up matching what is actually stored.
 *
 * SAFE WITHOUT A CLIENT PROFILE. Trainers and owners have no
 * client_profiles row at all; they get metric and a no-op setter rather
 * than an error, so this provider can wrap the whole app.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';
import {
  normalizeSystem, formatWeight, formatWeightDelta, formatLength, formatHeight,
  weightUnit, lengthUnit, weightValue, lengthValue,
  parseWeightToKg, parseLengthToCm,
} from './units.js';

const UnitsContext = createContext(null);

export function UnitsProvider({ children }) {
  const [system, setSystem] = useState('metric');
  const [ready, setReady] = useState(false);
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const load = useCallback(() => {
    // SIGNED OUT, THERE IS NO PROFILE -- and asking anyway was not harmless.
    // This provider wraps every route, public ones included, and api()
    // answers a 401 on anything but the /auth/me probe as a session that
    // expired mid-use: it signs out and sends the browser to /login. So a
    // signed-out visitor could not stay on /signup, the legal pages, a
    // shared workout or an invite link -- each bounced to the login screen
    // the moment this fetch came back. Keyed on the user, so signing in
    // loads the preference and signing out resets it.
    if (!userId) {
      setSystem('metric');
      setReady(true);
      return undefined;
    }
    let alive = true;
    api('/me/profile')
      .then((r) => { if (alive) setSystem(normalizeSystem(r?.profile?.unit_system)); })
      // A trainer/owner has no client profile. Metric is the right answer,
      // not an error state -- they still read weights in the product.
      .catch(() => { if (alive) setSystem('metric'); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [userId]);

  useEffect(() => load(), [load]);

  const changeSystem = useCallback(async (next) => {
    const target = normalizeSystem(next);
    const previous = system;
    setSystem(target);                       // optimistic: redraw immediately
    try {
      await api('/me/profile', { method: 'PUT', body: JSON.stringify({ unit_system: target }) });
    } catch (e) {
      setSystem(previous);                   // never show a unit that is not stored
      throw e;
    }
  }, [system]);

  const value = useMemo(() => ({
    system,
    ready,
    setSystem: changeSystem,
    /* For the one place that writes the preference through some OTHER
       request: onboarding saves the whole profile in one PUT, so this
       provider's copy would otherwise stay on metric until a reload. */
    refresh: load,
    // Bound formatters, so no call site has to remember to pass the
    // system -- which is exactly how one component ends up in the wrong
    // unit while the rest of the screen is right.
    fmtWeight: (kg, opts) => formatWeight(kg, system, opts),
    fmtWeightDelta: (kg, opts) => formatWeightDelta(kg, system, opts),
    fmtLength: (cm, opts) => formatLength(cm, system, opts),
    fmtHeight: (cm) => formatHeight(cm, system),
    weightNum: (kg, opts) => weightValue(kg, system, opts),
    lengthNum: (cm, opts) => lengthValue(cm, system, opts),
    toKg: (input) => parseWeightToKg(input, system),
    toCm: (input) => parseLengthToCm(input, system),
    weightUnit: weightUnit(system),
    lengthUnit: lengthUnit(system),
    isImperial: system === 'imperial',
  }), [system, ready, changeSystem, load]);

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

/**
 * Falls back to metric formatters when used outside the provider rather
 * than throwing. A missing provider should not blank a screen over a unit
 * label, and the fallback is the same behaviour the app had before units
 * existed.
 */
export function useUnits() {
  const ctx = useContext(UnitsContext);
  if (ctx) return ctx;
  return {
    system: 'metric',
    ready: true,
    setSystem: async () => {},
    refresh: () => {},
    fmtWeight: (kg, opts) => formatWeight(kg, 'metric', opts),
    fmtWeightDelta: (kg, opts) => formatWeightDelta(kg, 'metric', opts),
    fmtLength: (cm, opts) => formatLength(cm, 'metric', opts),
    fmtHeight: (cm) => formatHeight(cm, 'metric'),
    weightNum: (kg, opts) => weightValue(kg, 'metric', opts),
    lengthNum: (cm, opts) => lengthValue(cm, 'metric', opts),
    toKg: (input) => parseWeightToKg(input, 'metric'),
    toCm: (input) => parseLengthToCm(input, 'metric'),
    weightUnit: 'kg',
    lengthUnit: 'cm',
    isImperial: false,
  };
}
