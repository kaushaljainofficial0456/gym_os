// ============================================================
// FLEXIBLE CALORIE BALANCE — optional, opt-in redistribution of a day's
// calorie surplus across future days. Self-contained: fetches its own
// state (GET /me/nutrition/balance), renders the surplus prompt / active
// plan card / preview+apply flow / cancel / history, and calls
// `onEffectivePlanChange` so Nutrition.jsx can feed today's adjusted
// target into the existing calorie ring without this component owning
// that rendering itself (Section 34: minimal UI, no redesign).
//
// Copy follows the master prompt's own banned/preferred phrasing —
// "above target" / "remaining balance" / "flexible adjustment", never
// "failed" / "overate" / "must burn this off".
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';

const STRATEGY_ORDER = ['EASY', 'MODERATE', 'AGGRESSIVE', 'INTENSE'];
const STRATEGY_HINT = {
  EASY: 'Gentlest — spreads it out over more days',
  MODERATE: 'Balanced pace',
  AGGRESSIVE: 'Faster, bigger daily adjustment',
  INTENSE: 'Fastest — largest daily adjustment we allow',
};

function fmtDate(dateKey) {
  if (!dateKey) return '';
  const d = new Date(dateKey + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function addDaysKey(dateKey, n) {
  const d = new Date(dateKey + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
}

function ModalShell({ onClose, kicker, title, t, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 anim-fadeIn" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)' }}>
      <div className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'} rounded-3xl overflow-hidden anim-scaleIn max-h-[85vh] flex flex-col`} style={{ background: t.bg, border: `1px solid ${t.border}`, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div className="px-5 pt-5 pb-3 flex items-start justify-between shrink-0">
          <div>
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>{kicker}</div>
            <div className="font-grotesk text-base font-bold mt-1" style={{ color: t.ink }}>{title}</div>
          </div>
          <button className="w-8 h-8 rounded-full grid place-items-center text-sm transition-colors shrink-0" onClick={onClose} aria-label="Close" style={{ background: t.glass, color: t.mute, border: `1px solid ${t.border}` }}>✕</button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function Row({ label, value, t, strong }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs" style={{ color: t.mute }}>{label}</span>
      <span className={`font-grotesk text-sm ${strong ? 'font-bold' : 'font-semibold'}`} style={{ color: strong ? t.accent : t.ink }}>{value}</span>
    </div>
  );
}

export default function CalorieBalance({ balance, t, onToast, baseTarget }) {
  const [pickerStrategy, setPickerStrategy] = useState(null); // key while previewing
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [viewPlanOpen, setViewPlanOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const announcedSettle = useRef(false);
  const announcedExpiry = useRef(false);

  const data = balance.data;
  const active = data?.activePlan;
  const prompt = data?.promptEligible;

  useEffect(() => {
    if (data?.justSettled && !announcedSettle.current) {
      announcedSettle.current = true;
      onToast?.('Your calorie balance is settled.');
    }
  }, [data?.justSettled]);

  useEffect(() => {
    // A plan that went untouched too long (the client stopped opening the
    // app) rather than one that genuinely paid itself off -- neutral,
    // non-punitive phrasing, matching the settled-balance toast's tone.
    if (data?.justExpired && !announcedExpiry.current) {
      announcedExpiry.current = true;
      onToast?.('Your calorie balance adjustment period ended. Back to your normal target.');
    }
  }, [data?.justExpired]);

  useEffect(() => { setDismissed(false); }, [prompt?.sourceDate]);

  if (balance.loading || !data) return null;

  const openPicker = async (strategy) => {
    setPickerStrategy(strategy);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const res = await api('/me/nutrition/balance/preview', { method: 'POST', body: JSON.stringify({ strategy }) });
      setPreview(res);
    } catch (e) {
      setPreviewError(e.message || 'Could not build a preview');
    }
    setPreviewLoading(false);
  };

  const closePicker = () => { setPickerStrategy(null); setPreview(null); setPreviewError(null); };

  const applyPlan = async () => {
    setBusy(true);
    try {
      await api('/me/nutrition/balance/apply', { method: 'POST', body: JSON.stringify({ strategy: pickerStrategy }) });
      closePicker();
      onToast?.('Flexible adjustment applied ✓');
      balance.reload({ silent: true });
    } catch (e) {
      setPreviewError(e.message || 'Could not apply this plan');
    }
    setBusy(false);
  };

  const decline = async () => {
    setBusy(true);
    try {
      await api('/me/nutrition/balance/decline', { method: 'POST', body: JSON.stringify({}) });
      closePicker();
      setDismissed(true);
      balance.reload({ silent: true });
    } catch (e) {
      onToast?.(e.message || "Couldn't save that — try again");
    }
    setBusy(false);
  };

  const cancelPlan = async () => {
    setBusy(true);
    try {
      await api('/me/nutrition/balance/cancel', { method: 'POST', body: JSON.stringify({}) });
      setViewPlanOpen(false);
      onToast?.('Adjustment cancelled — your normal target is back');
      balance.reload({ silent: true });
    } catch (e) {
      onToast?.(e.message || "Couldn't cancel — try again");
    }
    setBusy(false);
  };

  const recalculate = async () => {
    setBusy(true);
    try {
      await api('/me/nutrition/balance/recalculate', { method: 'POST', body: JSON.stringify({}) });
      onToast?.('Plan recalculated for your new target ✓');
      balance.reload({ silent: true });
    } catch (e) {
      onToast?.(e.message || "Couldn't recalculate — try again");
    }
    setBusy(false);
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    if (history) return;
    try {
      const res = await api('/me/nutrition/balance/history');
      setHistory(res.history || []);
    } catch { setHistory([]); }
  };

  const card = { background: t.surface, border: `1px solid ${t.border}`, boxShadow: t.cardShadow };
  const btnGhost = { background: t.glass, color: t.mute, border: `1px solid ${t.border}` };
  const btnPrimary = { background: t.accent, color: 'var(--accent-contrast)' };

  return (
    <>
      {/* ══ TARGET-CHANGED WHILE A PLAN IS ACTIVE ══ */}
      {active?.targetChanged && (
        <div className="rounded-2xl p-4" style={{ ...card, borderColor: t.gold }}>
          <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold mb-1" style={{ color: t.gold }}>Calorie Balance</div>
          <div className="text-sm font-medium mb-3" style={{ color: t.ink }}>Your daily target changed. Your current balance plan needs to be recalculated.</div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={recalculate} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnPrimary}>Recalculate</button>
            <button disabled={busy} onClick={cancelPlan} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnGhost}>Cancel adjustment</button>
          </div>
        </div>
      )}

      {/* ══ SURPLUS PROMPT (no active plan yet) ══ */}
      {!active && prompt && !dismissed && (
        <div className="rounded-2xl p-4" style={card}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Flexible Calorie Balance</div>
              <div className="text-sm font-semibold mt-1" style={{ color: t.ink }}>{prompt.surplusCalories} kcal above target on {fmtDate(prompt.sourceDate)}</div>
              <div className="text-xs mt-0.5" style={{ color: t.mute }}>Totally optional — spread it across the next few days, or leave your target exactly as it is.</div>
            </div>
            <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="w-6 h-6 rounded-md grid place-items-center text-[10px] shrink-0" style={{ color: t.mute, background: t.glass }}>✕</button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {STRATEGY_ORDER.map((s) => (
              <button key={s} disabled={busy} onClick={() => openPicker(s)} className="px-3 py-2 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnGhost}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
            <button disabled={busy} onClick={decline} className="px-3 py-2 rounded-xl font-grotesk text-xs font-semibold transition-all active:scale-[.97]" style={{ color: t.mute }}>Don't adjust</button>
          </div>
        </div>
      )}

      {/* ══ ACTIVE PLAN — compact card ══ */}
      {active && !active.targetChanged && (
        <div className="rounded-2xl p-4 flex items-center justify-between gap-3" style={card}>
          <div className="min-w-0">
            <div className="font-grotesk text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: t.accent }}>Calorie Balance Active</div>
            <div className="text-sm font-semibold mt-1" style={{ color: t.ink }}>
              {active.remainingSurplusCalories} kcal remaining · today −{active.dailyAdjustmentCalories} kcal
            </div>
            <div className="text-xs mt-0.5" style={{ color: t.mute }}>
              {active.remainingDays} day{active.remainingDays === 1 ? '' : 's'} left · protein protected at {active.adjustedProteinTarget}g
            </div>
          </div>
          <button onClick={() => setViewPlanOpen(true)} className="shrink-0 px-3 py-2 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnGhost}>View plan</button>
        </div>
      )}

      {/* ══ STRATEGY PREVIEW MODAL ══ */}
      {pickerStrategy && (
        <ModalShell kicker="Flexible Calorie Balance" title={`${pickerStrategy.charAt(0) + pickerStrategy.slice(1).toLowerCase()} plan`} t={t} onClose={closePicker}>
          {previewLoading && <div className="text-center py-8 text-xs" style={{ color: t.mute }}>Building your preview…</div>}
          {previewError && <div className="text-xs font-grotesk px-3 py-2 rounded-xl mb-3" style={{ background: `${t.danger}10`, border: `1px solid ${t.danger}25`, color: t.danger }}>{previewError}</div>}
          {preview && !previewLoading && (
            <>
              <div className="text-xs mb-2" style={{ color: t.mute }}>{STRATEGY_HINT[pickerStrategy]}</div>
              {preview.preview.feasible ? (
                <div className="rounded-xl p-3 mb-3" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <Row t={t} label="Today's balance" value={`${preview.totalSurplusCalories} kcal over`} />
                  <Row t={t} label="Daily adjustment" value={`−${preview.preview.dailyAdjustmentCalories} kcal`} strong />
                  <Row t={t} label="Duration" value={`${preview.preview.plannedDays} day${preview.preview.plannedDays === 1 ? '' : 's'}`} />
                  <Row t={t} label="Future daily target" value={`${preview.preview.adjustedCalorieTarget} kcal`} />
                  <Row t={t} label="Protein minimum" value={`${preview.preview.macros.protein}g (protected)`} />
                  <Row t={t} label="Back to normal" value={fmtDate(addDaysKey(new Date().toLocaleDateString('en-CA'), preview.preview.plannedDays))} />
                  {preview.preview.extended && (
                    <div className="text-[11px] mt-2 pt-2" style={{ color: t.gold, borderTop: `1px solid ${t.border}` }}>
                      We've extended the plan to {preview.preview.plannedDays} days to keep your daily target within your safe range.
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs rounded-xl p-3 mb-3" style={{ background: t.glass, border: `1px solid ${t.border}`, color: t.mute }}>{preview.preview.message}</div>
              )}
              <div className="flex gap-2">
                {preview.preview.feasible && (
                  <button disabled={busy} onClick={applyPlan} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnPrimary}>Apply plan</button>
                )}
                <button disabled={busy} onClick={closePicker} className="flex-1 py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={btnGhost}>Choose another</button>
              </div>
              <button disabled={busy} onClick={decline} className="w-full mt-2 py-2 rounded-xl font-grotesk text-xs font-semibold" style={{ color: t.mute }}>Don't adjust</button>
            </>
          )}
        </ModalShell>
      )}

      {/* ══ VIEW ACTIVE PLAN ══ */}
      {viewPlanOpen && active && (
        <ModalShell kicker="Calorie Balance" title="Your active plan" t={t} onClose={() => setViewPlanOpen(false)}>
          <div className="rounded-xl p-3 mb-3" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
            <Row t={t} label="Base target" value={`${active.baseCalorieTarget} kcal`} />
            <Row t={t} label="Today's adjusted target" value={`${active.adjustedCalorieTarget} kcal`} strong />
            <Row t={t} label="Remaining balance" value={`${active.remainingSurplusCalories} kcal`} />
            <Row t={t} label="Days remaining" value={active.remainingDays} />
            <Row t={t} label="Protein (protected)" value={`${active.adjustedProteinTarget}g`} />
            <Row t={t} label="Carbs / Fat today" value={`${active.adjustedCarbsTarget}g / ${active.adjustedFatTarget}g`} />
            <Row t={t} label="Strategy" value={active.strategy.charAt(0) + active.strategy.slice(1).toLowerCase()} />
          </div>
          <button disabled={busy} onClick={cancelPlan} className="w-full py-2.5 rounded-xl font-grotesk text-xs font-bold transition-all active:scale-[.97]" style={{ background: `${t.danger}12`, color: t.danger, border: `1px solid ${t.danger}30` }}>Cancel adjustment</button>
          <button onClick={openHistory} className="w-full mt-2 py-2 rounded-xl font-grotesk text-xs font-semibold" style={{ color: t.mute }}>Plan history</button>
        </ModalShell>
      )}

      {/* ══ HISTORY ══ */}
      {historyOpen && (
        <ModalShell kicker="Calorie Balance" title="Plan history" t={t} onClose={() => setHistoryOpen(false)}>
          {!history && <div className="text-center py-8 text-xs" style={{ color: t.mute }}>Loading…</div>}
          {history && history.length === 0 && <div className="text-center py-8 text-xs" style={{ color: t.mute }}>No past plans yet.</div>}
          {history && history.length > 0 && (
            <div className="space-y-2">
              {history.map((h) => (
                <div key={h.id} className="rounded-xl p-3" style={{ background: t.glass, border: `1px solid ${t.border}` }}>
                  <div className="flex items-center justify-between">
                    {/* A Declined entry has no strategy -- nothing was ever redistributed. */}
                    <span className="font-grotesk text-xs font-bold" style={{ color: t.ink }}>
                      {h.strategy ? h.strategy.charAt(0) + h.strategy.slice(1).toLowerCase() : 'Not adjusted'}
                    </span>
                    <span className="font-grotesk text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: t.accentDim, color: t.accent }}>{h.status}</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: t.mute }}>
                    {fmtDate(h.sourceDate)}{h.originalSurplusCalories != null ? ` · ${h.originalSurplusCalories} kcal original balance` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ModalShell>
      )}
    </>
  );
}
