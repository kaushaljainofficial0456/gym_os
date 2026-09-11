/**
 * COMMUNITY FEED — shared workouts and personal records, with reactions
 * and comments.
 *
 * TWO EVENT KINDS, ONE CARD SHAPE. A shared workout and a PR are
 * different rows in different tables, but to a reader they are both "this
 * person did a thing worth seeing". They are merged into a single
 * chronological list rather than split into two competing feeds.
 *
 * DENSITY IS A FEATURE. The previous Community page wrapped every line in
 * its own large card and read as mostly empty space. These cards are
 * compact on purpose: avatar, who, what, the one number that matters,
 * when, and the actions. Nothing is given a card of its own unless it is
 * an event.
 *
 * NOTHING HERE IS INVENTED. A PR appears because personal_records has a
 * row; a workout appears because its owner chose to share it. There is no
 * "suggested" or filler content, and an empty feed is rendered as empty.
 */
import { useState, useEffect, useCallback } from 'react';
import { Avatar } from '../UI.jsx';
import { api } from '../../api.js';
import { fmt, fmtVolume, HUE } from './CommunityPieces.jsx';

const REACTION_GLYPH = { like: '❤️', fire: '🔥', clap: '👏', strong: '💪' };
const REACTION_ORDER = ['like', 'fire', 'clap', 'strong'];

/** Relative time, in the coarse units a feed actually needs. */
export function ago(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PR_LABEL = {
  heaviest_weight: 'Heaviest weight',
  best_reps: 'Most reps',
  est_1rm: 'Estimated 1RM',
  best_volume: 'Best volume',
};

/**
 * Merge shares and PRs into one time-ordered list.
 *
 * Sorted by a single comparable instant with the id as a tiebreaker, so
 * two events in the same second can never swap places between renders --
 * the same stability rule the paginated share query already follows.
 */
export function mergeFeed(shares, prs) {
  const items = [
    ...(shares || []).map((s) => ({
      kind: 'share',
      id: s.id,
      targetType: 'share',
      at: s.createdAt,
      clientId: s.clientId,
      name: s.authorName,
      data: s,
    })),
    ...(prs || []).map((p) => ({
      kind: 'pr',
      id: p.id,
      targetType: 'pr',
      // personal_records keeps the DAY it happened plus the row's own
      // created_at; created_at is the finer instant and is what orders
      // the feed correctly when several PRs land on one date.
      at: p.createdAt || `${p.date}T12:00:00Z`,
      clientId: p.clientId,
      name: p.memberName,
      data: p,
    })),
  ];
  items.sort((a, b) => {
    const d = Date.parse(b.at || 0) - Date.parse(a.at || 0);
    return d !== 0 ? d : String(b.id).localeCompare(String(a.id));
  });
  return items;
}

export default function CommunityFeed({
  items, social, you, onReact, onOpenComments, onShare, onCopy, onUnshare,
  filter, onFilterChange, hasMore, onLoadMore, loadingMore,
}) {
  const kinds = new Set(items.map((i) => i.kind));
  const showFilters = items.length >= 5 && kinds.size > 1;

  if (!items.length) {
    return (
      <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        <div className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>
          Your community is just getting started
        </div>
        <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
          Workouts and personal records show up here when members share them.
        </div>
        {onShare && (
          <button
            type="button"
            onClick={onShare}
            className="mt-4 rounded-xl px-4 font-semibold text-[12.5px]"
            style={{ minHeight: 44, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Share a workout
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {showFilters && (
        <div className="flex gap-1.5" role="tablist" aria-label="Filter activity">
          {[['all', 'All'], ['share', 'Workouts'], ['pr', 'PRs']].map(([key, label]) => {
            const on = filter === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={on}
                onClick={() => onFilterChange(key)}
                className="rounded-lg px-3 text-[11.5px] font-semibold"
                style={{
                  minHeight: 34,
                  background: on ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  color: on ? 'var(--accent)' : 'var(--mute)',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {items.map((item) => (
        <FeedCard
          key={`${item.targetType}:${item.id}`}
          item={item}
          social={social[`${item.targetType}:${item.id}`]}
          isYou={item.clientId === you}
          onReact={onReact}
          onOpenComments={onOpenComments}
          onCopy={onCopy}
          onUnshare={onUnshare}
        />
      ))}

      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="w-full rounded-xl text-[12.5px] font-semibold"
          style={{ minHeight: 44, border: '1px solid var(--line)', color: 'var(--mute)' }}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function FeedCard({ item, social, isYou, onReact, onOpenComments, onCopy, onUnshare }) {
  const s = social || { counts: {}, mine: [], total: 0, comments: 0 };
  const isPR = item.kind === 'pr';

  return (
    <article
      className="rounded-2xl px-3.5 py-3"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="flex items-start gap-2.5">
        <Avatar name={item.name} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-semibold text-[12.5px]" style={{ color: 'var(--ink)' }}>
              {isYou ? 'You' : item.name}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--mute)' }}>
              {isPR ? 'set a personal record' : 'shared a workout'}
            </span>
          </div>
          <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>{ago(item.at)}</div>
        </div>
      </div>

      <div className="mt-2.5 ml-[44px]">
        {isPR ? <PRBody pr={item.data} /> : <ShareBody share={item.data} />}
      </div>

      {/* Actions sit on one compact row rather than a block of buttons. */}
      <div className="mt-2.5 ml-[44px] flex items-center gap-1.5 flex-wrap">
        {REACTION_ORDER.map((key) => {
          const count = s.counts[key] || 0;
          const mine = s.mine.includes(key);
          // An unreacted, zero-count emoji still renders so the gesture is
          // discoverable -- but quietly, without a "0".
          return (
            <button
              key={key}
              type="button"
              aria-pressed={mine}
              aria-label={`${mine ? 'Remove' : 'Add'} ${key} reaction`}
              onClick={() => onReact(item.targetType, item.id, key)}
              className="rounded-full px-2.5 flex items-center gap-1 text-[12px] transition-transform active:scale-90"
              style={{
                minHeight: 32,
                background: mine ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${mine ? 'var(--accent)' : 'var(--line)'}`,
              }}
            >
              <span aria-hidden="true">{REACTION_GLYPH[key]}</span>
              {count > 0 && (
                <span className="tabular-nums text-[11px] font-semibold" style={{ color: mine ? 'var(--accent)' : 'var(--mute)' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onOpenComments(item)}
          className="rounded-full px-2.5 flex items-center gap-1 text-[11.5px]"
          style={{ minHeight: 32, border: '1px solid var(--line)', color: 'var(--mute)' }}
        >
          <span aria-hidden="true">💬</span>
          {s.comments > 0 && <span className="tabular-nums font-semibold">{s.comments}</span>}
        </button>

        {/* A shared workout is the one event kind you can act on beyond
            reacting: take it for yourself, or -- if it is yours -- take it
            back down. Unsharing is offered right where the share is
            visible, so withdrawing something is as easy as posting it. */}
        {!isPR && !isYou && onCopy && (
          <button
            type="button"
            onClick={() => onCopy(item.data)}
            className="rounded-full px-2.5 text-[11.5px] font-semibold"
            style={{ minHeight: 32, border: '1px solid var(--line)', color: 'var(--accent)' }}
          >
            Copy workout
          </button>
        )}
        {!isPR && isYou && onUnshare && (
          <button
            type="button"
            onClick={() => onUnshare(item.data)}
            className="rounded-full px-2.5 text-[11.5px] ml-auto"
            style={{ minHeight: 32, color: 'var(--mute)' }}
          >
            Remove
          </button>
        )}
      </div>
    </article>
  );
}

function PRBody({ pr }) {
  // Each PR type means a different thing, so each states its own number.
  // Rendering them all as "weight x reps" was actively misleading: for an
  // estimated 1RM that shows the SOURCE SET rather than the estimate, and
  // for a volume record it printed a bare figure with no unit at all.
  const detail = (() => {
    if (pr.type === 'est_1rm') return `${fmt(pr.value)} kg est. 1RM`;
    if (pr.type === 'best_volume') return `${fmtVolume(pr.value)} kg volume`;
    if (pr.weight != null && pr.reps != null) {
      return pr.type === 'best_reps'
        ? `${fmt(pr.reps)} reps @ ${fmt(pr.weight)} kg`
        : `${fmt(pr.weight)} kg × ${fmt(pr.reps)}`;
    }
    return fmt(pr.value);
  })();
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      // Records are bronze everywhere in the product -- the same hue the
      // PR tile in the pulse uses, so the two read as one concept.
      style={{ background: HUE.prs.bg, border: `1px solid ${HUE.prs.fg}` }}
    >
      <div className="text-[9.5px] uppercase tracking-[.14em] font-bold" style={{ color: HUE.prs.fg }}>
        {PR_LABEL[pr.type] || 'Personal record'}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="font-bold text-[13.5px]" style={{ color: 'var(--ink)' }}>{pr.exercise}</span>
      </div>
      <div className="font-black tabular-nums mt-0.5" style={{ fontSize: 19, color: HUE.prs.fg }}>
        {detail}
      </div>
    </div>
  );
}

function ShareBody({ share }) {
  const ex = Array.isArray(share.payload) ? share.payload : [];
  const sets = ex.reduce((n, e) => n + (Number(e.sets) || 0), 0);
  // Only metrics the snapshot actually carries are shown -- a zero here
  // would read as "this workout had no sets" rather than "we didn't store
  // that".
  const bits = [
    ex.length > 0 ? `${ex.length} ${ex.length === 1 ? 'exercise' : 'exercises'}` : null,
    sets > 0 ? `${sets} sets` : null,
  ].filter(Boolean);

  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
      <div className="font-bold text-[13.5px]" style={{ color: 'var(--ink)' }}>{share.workoutName}</div>
      {bits.length > 0 && (
        <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>{bits.join(' · ')}</div>
      )}
      {ex.length > 0 && (
        <div className="text-[11px] mt-1.5 truncate" style={{ color: 'var(--faint)' }}>
          {ex.slice(0, 3).map((e) => e.name).filter(Boolean).join(', ')}
          {ex.length > 3 ? ` +${ex.length - 3}` : ''}
        </div>
      )}
    </div>
  );
}

/* ══════════════ COMMENTS SHEET ══════════════ */

export function CommentsSheet({ target, you, onClose, toast }) {
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api(`/community/comments?target_type=${target.targetType}&target_id=${encodeURIComponent(target.id)}`);
      setComments(res.comments || []);
    } catch (e) {
      setErr(e.message || 'Could not load comments');
      setComments([]);
    }
  }, [target]);

  // A real effect, not a useState initializer: the initializer runs
  // DURING render, so kicking off a fetch there sets state mid-render.
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr('');
    try {
      await api('/community/comments', {
        method: 'POST',
        body: JSON.stringify({ target_type: target.targetType, target_id: target.id, body }),
      });
      setDraft('');
      await load();
      toast?.('Comment added');
    } catch (e) {
      setErr(e.message || 'Could not post that comment');
    }
    setBusy(false);
  };

  const remove = async (id) => {
    try {
      await api(`/community/comments/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e.message || 'Could not delete that comment');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Comments"
    >
      <div
        className="w-full max-w-lg rounded-t-3xl p-4 max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>Comments</h2>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-lg px-3" style={{ minHeight: 36, color: 'var(--mute)' }}>
            Close
          </button>
        </div>

        {comments === null && <div className="text-[12px]" style={{ color: 'var(--mute)' }}>Loading…</div>}
        {comments?.length === 0 && (
          <div className="text-[12px] py-4 text-center" style={{ color: 'var(--mute)' }}>
            No comments yet. Say something encouraging.
          </div>
        )}

        <div className="space-y-2.5">
          {(comments || []).map((c) => (
            <div key={c.id} className="flex items-start gap-2.5">
              <Avatar name={c.authorName} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>
                    {c.clientId === you ? 'You' : c.authorName}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--faint)' }}>{ago(c.createdAt)}</span>
                </div>
                <div className="text-[12.5px] mt-0.5 break-words" style={{ color: 'var(--ink)' }}>{c.body}</div>
              </div>
              {c.clientId === you && (
                <button type="button" onClick={() => remove(c.id)} aria-label="Delete your comment"
                        className="text-[11px] shrink-0" style={{ color: 'var(--mute)', minHeight: 32 }}>
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>

        {err && <div className="text-[11.5px] mt-2" style={{ color: 'var(--bad)' }}>{err}</div>}

        <div className="flex gap-2 mt-4 sticky bottom-0 pt-2" style={{ background: 'var(--bg)' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Add a comment"
            aria-label="Add a comment"
            maxLength={500}
            className="flex-1 rounded-xl px-3 text-[12.5px]"
            style={{ minHeight: 44, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="rounded-xl px-4 font-semibold text-[12.5px]"
            style={{
              minHeight: 44,
              background: draft.trim() ? 'var(--accent)' : 'var(--line)',
              color: draft.trim() ? 'var(--accent-contrast)' : 'var(--mute)',
            }}
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
