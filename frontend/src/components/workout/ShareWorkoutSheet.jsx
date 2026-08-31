import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SavingOverlay from '../nutrition/SavingOverlay.jsx';

/**
 * SHARE WORKOUT SHEET — select exercises from a workout, bundle them into
 * one shareable link (POST /me/workout-share), then hand off to whatever
 * the platform actually offers: navigator.share() or a clipboard-copy fallback.
 *
 * Props:
 *   open      — boolean, whether the sheet is visible
 *   onClose   — callback to close
 *   workoutId — the workout to share (from planner or today's session)
 *   workoutName — display name
 *   exercises — array of exercise objects [{id, name, sets, reps, weight, rest_sec, tempo, notes}]
 *   t         — theme object
 */
export default function ShareWorkoutSheet({ open, onClose, workoutId, workoutName, exercises, t }) {
  const [selected, setSelected] = useState(() => new Set());
  const [selectAll, setSelectAll] = useState(true);
  const [stage, setStage] = useState(null); // null | 'sharing' | 'success' | 'error'
  const [shared, setShared] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Default: all exercises selected
    setSelected(new Set(exercises.map((_, i) => i)));
    setSelectAll(true);
    setStage(null);
    setShared(false);
    setShareUrl('');
    setCopied(false);
  }, [open, exercises]);

  if (!open) return null;

  const toggleSelect = (idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
    setSelectAll(false);
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(exercises.map((_, i) => i)));
      setSelectAll(true);
    }
  };

  // Keep selectAll in sync
  useEffect(() => {
    if (selected.size === exercises.length && exercises.length > 0) {
      setSelectAll(true);
    } else {
      setSelectAll(false);
    }
  }, [selected.size, exercises.length]);

  const doShare = async () => {
    if (selected.size === 0 || !workoutId) return;
    setStage('sharing');
    try {
      const res = await api('/me/workout-share', {
        method: 'POST',
        body: JSON.stringify({
          workout_id: workoutId,
          exercise_ids: [...selected].map((i) => exercises[i].id).filter(Boolean),
        }),
      });
      const url = `${window.location.origin}/workout-share/${res.id}`;
      setShareUrl(url);
      setShared(true);
      setStage('success');
      setTimeout(async () => {
        setStage(null);
        if (navigator.share) {
          try {
            await navigator.share({
              title: `${workoutName || 'Workout'} on SK OS`,
              text: `Check out this workout: ${workoutName}`,
              url,
            });
          } catch { /* user cancelled */ }
        }
      }, 900);
    } catch (e) {
      setStage('error');
      setTimeout(() => setStage(null), 1600);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center anim-fadeIn"
         style={{ background: 'rgb(var(--bg-rgb) / .72)', backdropFilter: 'blur(4px)' }}
         onClick={(e) => { if (e.target === e.currentTarget && !stage) onClose(); }}>
      <div className="card w-full sm:max-w-md max-h-[85vh] overflow-y-auto rounded-b-none sm:rounded-2xl anim-scaleIn">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3 flex items-center justify-between" style={{ background: 'var(--panel)' }}>
          <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Share Workout</div>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--mute)' }}>✕</button>
        </div>

        <div className="px-4 pb-5 space-y-4">
          {/* Workout name */}
          <div>
            <div className="font-grotesk text-sm font-bold" style={{ color: 'var(--ink)' }}>{workoutName || 'Workout'}</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>
              {selected.size} of {exercises.length} exercises selected
            </div>
          </div>

          {/* Select all toggle */}
          <button onClick={toggleSelectAll}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
            style={{ background: selectAll ? 'var(--accent-soft)' : 'var(--glass, rgba(128,128,128,.04))', border: `1px solid ${selectAll ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--line)'}` }}>
            <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all"
              style={{ background: selectAll ? 'var(--accent)' : 'transparent', border: `2px solid ${selectAll ? 'var(--accent)' : 'var(--line)'}` }}>
              {selectAll && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
            </span>
            <span className="font-grotesk text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>Select all</span>
          </button>

          {/* Exercise list */}
          <div className="space-y-1.5">
            {exercises.map((ex, i) => {
              const sel = selected.has(i);
              return (
                <button key={i} onClick={() => toggleSelect(i)}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
                  style={{ background: sel ? 'var(--accent-soft)' : 'transparent', border: `1px solid ${sel ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--line)'}` }}>
                  <span className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-all"
                    style={{ background: sel ? 'var(--accent)' : 'transparent', border: `2px solid ${sel ? 'var(--accent)' : 'var(--line)'}` }}>
                    {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-contrast)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-grotesk text-[12px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{ex.name}</span>
                    <span className="block text-[10px]" style={{ color: 'var(--mute)' }}>
                      {ex.sets} × {ex.reps} · {ex.weight}{ex.rest_sec ? ` · ${ex.rest_sec}s` : ''}
                      {ex.tempo ? ` · ${ex.tempo}` : ''}
                      {ex.notes ? ` · ${ex.notes}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Share URL display (after sharing) */}
          {shared && shareUrl && (
            <div className="rounded-xl p-3 flex items-center gap-2 anim-fadeIn" style={{ background: 'var(--glass, rgba(128,128,128,.04))', border: '1px solid var(--line)' }}>
              <input readOnly value={shareUrl} className="flex-1 min-w-0 bg-transparent font-grotesk text-[11px] outline-none" style={{ color: 'var(--mute)' }} onFocus={(e) => e.target.select()} />
              <button onClick={copyLink} className="shrink-0 px-2.5 py-1.5 rounded-lg font-grotesk text-[10px] font-bold" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          )}

          {/* Share button */}
          <button onClick={doShare} disabled={selected.size === 0 || stage === 'sharing'}
            className="w-full py-3 rounded-xl font-grotesk text-[13px] font-bold transition-all active:scale-[.98]"
            style={{
              background: selected.size === 0 ? 'var(--surface)' : 'var(--accent)',
              color: selected.size === 0 ? 'var(--mute)' : 'var(--accent-contrast)',
              border: `1px solid ${selected.size === 0 ? 'var(--line)' : 'var(--accent)'}`,
              opacity: selected.size === 0 ? 0.6 : 1, cursor: selected.size === 0 ? 'not-allowed' : 'pointer',
            }}>
            {shared ? 'Share again' : `Create share link${selected.size ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>

      <SavingOverlay open={stage === 'sharing' || stage === 'success' || stage === 'error'}
        stage={stage === 'sharing' ? 'saving' : stage === 'success' ? 'success' : 'error'}
        label={stage === 'sharing' ? 'Sharing' : stage === 'success' ? 'Workout Shared' : 'Could not share'}
        sublabel={stage === 'sharing' ? 'Preparing your workout…' : stage === 'success' ? 'Your workout is ready to share.' : 'Please try again'}
        mode="overlay" />
    </div>
  );
}
