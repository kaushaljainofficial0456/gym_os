import { api } from '../api.js';
import { Modal } from './UI.jsx';

function ActionBtn({ action, small }) {
  const href = {
    OPEN_NUTRITION: '/app/client/nutrition',
    OPEN_MEALS: '/app/client/nutrition',
    START_WORKOUT: '/app/client/workout',
    LOG_WATER: '/app/client/nutrition',
    LOG_SLEEP: '/app/client/progress',
    VIEW_PROGRESS: '/app/client/progress',
    VIEW_EXERCISE: '/app/client/workout',
    VIEW_GOAL: '/app/client/progress',
    VIEW_BRIEF: '/app/client'
  }[action];
  if (!href) return null;
  return (
    <a href={href} className={`inline-block mt-1.5 rounded-lg border border-gold/40 text-gold hover:bg-gold/10 font-grotesk font-semibold transition-colors ${small ? '!px-2 !py-0.5 !text-[10px]' : '!px-3 !py-1 !text-[11px]'}`}>
      Open →
    </a>
  );
}

export default function CoachBriefDrawer({ open, onClose, briefFetch, weeklyFetch }) {
  const brief = briefFetch?.data;
  const weekly = weeklyFetch?.data;

  return (
    <Modal open={open} onClose={onClose} title="Coach Brief" wide>
      <div className="space-y-4">
        {/* Daily Brief */}
        {brief?.ok && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-display font-bold text-sm" style={{ color: 'var(--ink)' }}>Today's Coach Brief</span>
              {brief.ai_framed && <span className="chip border-violetx/40 text-violetx !px-1.5 !py-0 text-[8px]">OLLAMA</span>}
              {!brief.ai_framed && <span className="chip !px-1.5 !py-0 text-[8px]" style={{ color: 'var(--mute)' }}>deterministic</span>}
            </div>

            {brief.priority && (
              <div className="rounded-xl border border-gold/30 px-3 py-2.5" style={{ background: 'rgb(var(--accent-rgb) / .04)' }}>
                <div className="font-grotesk text-[9px] uppercase tracking-[.14em] text-gold">Today's priority · {brief.priority.priority}</div>
                <div className="font-grotesk text-[13px] font-semibold mt-0.5" style={{ color: 'var(--ink)' }}>{brief.priority.title}</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>{brief.priority.message}</div>
                <ActionBtn action={brief.priority.action} />
              </div>
            )}

            <div className="space-y-1.5">
              {brief.insights?.slice(0, 6).map((ins, i) => (
                <div key={i} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--bg2)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-grotesk text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>{ins.title}</span>
                    <span className={`text-[8px] font-grotesk uppercase tracking-wide ${ins.priority === 'HIGH' ? 'text-ember' : ins.priority === 'MEDIUM' ? 'text-gold' : 'text-faint'}`}>{ins.priority}</span>
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>{ins.message}</div>
                  {ins.action !== 'NONE' && <ActionBtn action={ins.action} small />}
                </div>
              ))}
            </div>

            <div className="text-[9px]" style={{ color: 'var(--faint)' }}>{brief.note}</div>

            <div className="flex gap-1.5">
              {['helpful', 'not_helpful', 'not_relevant'].map((fb) => (
                <button key={fb} className="chip border-line text-[9px] hover:text-gold hover:border-gold/40 transition-colors" style={{ color: 'var(--mute)' }} onClick={async () => {
                  try {
                    await api('/intel/coach/feedback', { method: 'POST', body: JSON.stringify({ feedback: fb, target_type: 'brief', target_id: brief.priority?.title || 'daily' }) });
                  } catch { /* ignore */ }
                }}>{fb === 'not_helpful' ? 'Not helpful' : fb === 'not_relevant' ? 'Not relevant' : 'Helpful ✓'}</button>
              ))}
            </div>
          </div>
        )}

        {/* Weekly Review */}
        {weekly?.ok && (
          <div className="border-t border-line pt-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-sm" style={{ color: 'var(--ink)' }}>Weekly Review</span>
              {weekly.ai_framed && <span className="chip border-violetx/40 text-violetx !px-1.5 !py-0 text-[8px]">OLLAMA</span>}
            </div>

            {weekly.went_well?.length > 0 && (
              <div>
                <div className="font-grotesk text-[9px] uppercase tracking-[.14em] text-good font-medium mb-1">What went well</div>
                {weekly.went_well.map((item, i) => (
                  <div key={i} className="text-[12px] leading-relaxed" style={{ color: 'var(--ink)' }}>✓ {typeof item === 'string' ? item : item.message || item.title || ''}</div>
                ))}
              </div>
            )}

            {weekly.needs_attention?.length > 0 && (
              <div>
                <div className="font-grotesk text-[9px] uppercase tracking-[.14em] text-warn font-medium mb-1">Needs attention</div>
                {weekly.needs_attention.map((item, i) => (
                  <div key={i} className="text-[12px] leading-relaxed" style={{ color: 'var(--ink)' }}><span style={{ color: 'rgb(var(--warn-rgb))' }}><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg></span> {typeof item === 'string' ? item : item.message || item.title || ''}</div>
                ))}
              </div>
            )}

            {weekly.next_week_priority && (
              <div className="rounded-xl border border-gold/30 px-3 py-2.5" style={{ background: 'rgb(var(--accent-rgb) / .04)' }}>
                <div className="font-grotesk text-[9px] uppercase tracking-[.14em] text-gold">Next week priority</div>
                <div className="font-grotesk text-[13px] font-semibold mt-0.5" style={{ color: 'var(--ink)' }}>{weekly.next_week_priority.title || weekly.next_week_priority}</div>
                {weekly.next_week_priority.message && <div className="text-[11px] mt-0.5" style={{ color: 'var(--mute)' }}>{weekly.next_week_priority.message}</div>}
              </div>
            )}
          </div>
        )}

        {!brief?.ok && !weekly?.ok && (
          <div className="text-center text-sm py-6" style={{ color: 'var(--mute)' }}>
            No coach brief available right now. Check back later.
          </div>
        )}
      </div>
    </Modal>
  );
}
