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
import { createPortal } from 'react-dom';
import { Avatar } from '../UI.jsx';
import { api } from '../../api.js';
import { exerciseLabel } from '../../utils.js';
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
      // A GROUP id (prg_<client>_<date>), not a record id: the backend now
      // returns one entry per person per session rather than one per
      // record. Reactions and comments therefore attach to the session,
      // which is also the thing a person would actually congratulate.
      id: p.id,
      targetType: 'pr',
      // created_at is the finer instant and is right for a record set
      // today ("2h ago"). But it is the moment the ROW was written, which
      // for backfilled or imported history can be days after the session
      // -- and then "7h ago" is simply false for a record set last week.
      // Trust it only when it falls on the day the record belongs to.
      at: (p.createdAt && String(p.createdAt).slice(0, 10) === p.date)
        ? p.createdAt
        : `${p.date}T12:00:00Z`,
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
  scope, onScopeChange, followingCount = 0,
}) {
  const kinds = new Set(items.map((i) => i.kind));
  const showFilters = items.length >= 5 && kinds.size > 1;

  /* WHOSE activity, then WHAT KIND of activity -- two different questions,
     so they are two controls rather than one merged list of five chips
     that mixes people with content types. */
  const scopeControl = onScopeChange ? (
    <div className="flex gap-1.5" role="tablist" aria-label="Whose activity to show">
      {[['all', 'Everyone'], ['following', 'People I follow']].map(([key, label]) => {
        const on = scope === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={on}
            onClick={() => onScopeChange(key)}
            className="flex-1 rounded-xl text-[11.5px] font-semibold transition-colors"
            style={{
              minHeight: 38,
              background: on ? 'var(--accent-soft)' : 'transparent',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
              color: on ? 'var(--accent)' : 'var(--mute)',
            }}
          >
            {label}
            {key === 'following' && followingCount > 0 && (
              <span className="tabular-nums opacity-70"> · {followingCount}</span>
            )}
          </button>
        );
      })}
    </div>
  ) : null;

  if (!items.length) {
    // An empty "People I follow" feed is not an empty community -- saying
    // so would be wrong, and would hide the one action that fixes it.
    const emptyBecauseScope = scope === 'following';
    return (
      <div className="space-y-2">
      {scopeControl}
      <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        <div className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>
          {emptyBecauseScope ? 'Nothing from the people you follow' : 'Your community is just getting started'}
        </div>
        <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
          {emptyBecauseScope
            ? 'Follow a few more members, or switch to Everyone to see the whole gym.'
            : 'Workouts and personal records show up here when members share them.'}
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
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {scopeControl}
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

/**
 * One event, one card. Exported because friend communities render the same
 * kinds of event (a shared session, a set of records, someone joining) and a
 * second card component would drift from this one within a release.
 *
 * `gym` is the author's gym, shown only where they chose to show it (friend
 * communities only -- inside a gym community everyone is already in it).
 * `verb` lets a caller name an event kind this component does not know.
 */
export function FeedCard({ item, social, isYou, onReact, onOpenComments, onCopy, onUnshare, gym, verb, removable }) {
  const s = social || { counts: {}, mine: [], total: 0, comments: 0 };
  const isPR = item.kind === 'pr';
  const isMember = item.kind === 'joined' || item.kind === 'created';
  // In a GYM community a record is not a post -- it appears because the
  // record exists, so there is nothing to take down (the member's privacy
  // control is elsewhere). In a friend community a record reaches the feed
  // only because someone chose to post it, so they can unpost it; that
  // caller passes `removable` explicitly.
  const canRemove = typeof removable === 'boolean' ? removable : !isPR;

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
              {verb || (isPR
                ? (item.data.recordCount > 1 ? 'set personal records' : 'set a personal record')
                : 'shared a workout')}
            </span>
          </div>
          <div className="text-[10.5px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--faint)' }}>
            <span>{ago(item.at)}</span>
            {gym && (
              <>
                <span aria-hidden="true">·</span>
                <span>{gym}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {isMember ? null : (
      <div className="mt-2.5 ml-[44px]">
        {isPR ? <PRBody pr={item.data} /> : <ShareBody share={item.data} />}
        {/* Only the author needs to know the audience of their own post --
            telling everyone else would be announcing who is in a
            restricted group. */}
        {!isPR && isYou && item.data.visibility === 'followers' && (
          <div className="text-[10px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--faint)' }}>
            <span aria-hidden="true">🔒</span> Visible to your followers
          </div>
        )}
      </div>
      )}

      {/* Actions sit on one compact row rather than a block of buttons.
          Someone joining is a fact, not a post: it gets no reactions and no
          comment thread. */}
      {!isMember && (
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
          aria-label={s.comments > 0
            ? `Comments (${s.comments})`
            : 'Add a comment'}
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
            className="rounded-full px-3 text-[11.5px] font-semibold ml-auto"
            style={{
              minHeight: 32,
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              color: 'var(--accent)',
            }}
          >
            Save to my workouts
          </button>
        )}
        {isYou && onUnshare && canRemove && (
          <button
            type="button"
            onClick={() => onUnshare(item)}
            className="rounded-full px-2.5 text-[11.5px] ml-auto"
            style={{ minHeight: 32, color: 'var(--mute)' }}
          >
            Remove
          </button>
        )}
      </div>
      )}
    </article>
  );
}

function PRBody({ pr }) {
  // `pr` is a SESSION's worth of records. Rendering each record as its own
  // feed card is what turned one leg session into eight posts, and what a
  // 200-member gym would have turned into ~1,600 posts a day.
  const records = pr.records || [];

  // Group by exercise, because four record types on one lift is still one
  // lift. "Leg Extension — heaviest weight, best volume, est. 1RM" is one
  // line a person can read; four cards is not.
  const byExercise = [];
  const index = new Map();
  for (const r of records) {
    if (!index.has(r.exercise)) {
      index.set(r.exercise, { exercise: r.exercise, types: [], best: r });
      byExercise.push(index.get(r.exercise));
    }
    const g = index.get(r.exercise);
    g.types.push(r.type);
    // The headline figure per exercise: a weight the person actually
    // lifted beats a derived estimate.
    if (r.type === 'heaviest_weight') g.best = r;
  }

  const SHOWN = 3;
  const shown = byExercise.slice(0, SHOWN);
  const more = byExercise.length - shown.length;

  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{ background: HUE.prs.bg, border: `1px solid ${HUE.prs.fg}` }}
    >
      <div className="text-[9.5px] uppercase tracking-[.14em] font-bold" style={{ color: HUE.prs.fg }}>
        {records.length === 1
          ? 'Personal record'
          : `${records.length} personal records`}
      </div>

      <div className="mt-1.5 space-y-1.5">
        {shown.map((g) => {
          const beat = deltaFor(g.best);
          return (
            <div key={g.exercise} className="flex items-baseline justify-between gap-3">
              {/* Library names are identifiers (leg_press); exerciseLabel is
                  how the rest of the product renders them to people. */}
              <span className="text-[12.5px] font-bold truncate" style={{ color: 'var(--ink)' }}>
                {exerciseLabel(g.exercise)}
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[12.5px] font-black tabular-nums" style={{ color: HUE.prs.fg }}>
                  {headlineFor(g.best)}
                </span>
                {beat && (
                  <span className="block text-[10px] tabular-nums mt-0.5" style={{ color: 'var(--good)' }}>
                    {beat}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {more > 0 && (
        <div className="text-[10.5px] mt-1.5" style={{ color: 'var(--mute)' }}>
          and {more} more {more === 1 ? 'exercise' : 'exercises'}
        </div>
      )}
    </div>
  );
}

/**
 * What this record BEAT, when the record engine stored it (see
 * personal_records.previous_value). Rendered only for a genuine improvement
 * over a real earlier record: a first-ever record has nothing to compare
 * against, and inventing "+70 kg" for it would be the most flattering lie on
 * the page.
 */
function deltaFor(r) {
  if (!r || r.previousValue == null) return null;
  const gain = Math.round((Number(r.value) - Number(r.previousValue)) * 100) / 100;
  if (!(gain > 0)) return null;
  const trim = (n) => String(Math.round(Number(n) * 10) / 10);
  if (r.type === 'best_reps') return `+${trim(gain)} reps · was ${trim(r.previousValue)}`;
  if (r.type === 'best_volume') return `+${fmtVolume(gain)} kg · was ${fmtVolume(r.previousValue)} kg`;
  return `+${trim(gain)} kg · was ${trim(r.previousValue)} kg`;
}

/** The one figure that best states a record, per type. Rendering them all
 *  as "weight x reps" misreported an estimated 1RM as its source set and
 *  printed a volume record with no unit at all. */
function headlineFor(r) {
  if (!r) return '';
  if (r.type === 'est_1rm') return `${fmt(r.value)} kg 1RM`;
  if (r.type === 'best_volume') return `${fmtVolume(r.value)} kg`;
  if (r.weight != null && r.reps != null) {
    return r.type === 'best_reps'
      ? `${fmt(r.reps)} x ${fmt(r.weight)} kg`
      : `${fmt(r.weight)} kg x ${fmt(r.reps)}`;
  }
  return fmt(r.value);
}

function ShareBody({ share }) {
  const ex = Array.isArray(share.payload) ? share.payload : [];
  const prescribedSets = ex.reduce((n, e) => n + (Number(e.sets) || 0), 0);
  // A friend-community snapshot carries what was actually LOGGED (completed
  // sets, real volume, real minutes); a gym share carries the prescription.
  // Each shows what it genuinely has -- and only metrics the snapshot
  // carries are shown, because a zero here would read as "this workout had
  // no sets" rather than "we didn't store that".
  const sets = Number(share.setCount) > 0 ? Number(share.setCount) : prescribedSets;
  const bits = [
    ex.length > 0 ? `${ex.length} ${ex.length === 1 ? 'exercise' : 'exercises'}` : null,
    sets > 0 ? `${sets} sets` : null,
  ].filter(Boolean);
  const totals = [
    share.durationMin > 0 ? `${share.durationMin} min` : null,
    share.volume > 0 ? `${fmtVolume(share.volume)} kg lifted` : null,
    share.prCount > 0 ? `${share.prCount} ${share.prCount === 1 ? 'record' : 'records'}` : null,
  ].filter(Boolean);

  const SHOWN = 4;
  const shown = ex.slice(0, SHOWN);
  const more = ex.length - shown.length;

  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-bold text-[13.5px] truncate" style={{ color: 'var(--ink)' }}>{share.workoutName}</span>
        {bits.length > 0 && (
          <span className="text-[10.5px] shrink-0 tabular-nums" style={{ color: 'var(--mute)' }}>{bits.join(' · ')}</span>
        )}
      </div>

      {totals.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mt-2">
          {totals.map((t) => (
            <span
              key={t}
              className="text-[10.5px] tabular-nums rounded-full px-2 py-0.5"
              style={{ background: HUE.workouts.bg, color: HUE.workouts.fg }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* The actual prescription, not a truncated comma list. A shared
          workout is only worth copying if you can see what you would be
          copying -- one run-on line of names read as decorative text. */}
      {shown.length > 0 && (
        <div className="mt-2 space-y-1">
          {shown.map((e, i) => (
            <div key={`${e.name}-${i}`} className="flex items-baseline justify-between gap-3 text-[11.5px]">
              <span className="truncate" style={{ color: 'var(--ink)' }}>{exerciseLabel(e.name)}</span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--mute)' }}>
                {[e.sets ? `${e.sets}x${e.reps ?? ''}` : null, e.weight && e.weight !== 'BW' ? `${e.weight}` : null]
                  .filter(Boolean).join(' · ') || '—'}
              </span>
            </div>
          ))}
          {more > 0 && (
            <div className="text-[10.5px] pt-0.5" style={{ color: 'var(--faint)' }}>
              and {more} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ══════════════ COMMENTS SHEET ══════════════ */

/**
 * How the gym community reads and writes comments. A friend community stores
 * its comments against a real event row rather than a (type, id) pair, so it
 * passes its own adapter -- the SHEET, which is all the person sees, stays
 * one component.
 */
export const GYM_COMMENTS = {
  list: (target) => api(`/community/comments?target_type=${target.targetType}&target_id=${encodeURIComponent(target.id)}`),
  add: (target, body) => api('/community/comments', {
    method: 'POST',
    body: JSON.stringify({ target_type: target.targetType, target_id: target.id, body }),
  }),
  remove: (id) => api(`/community/comments/${id}`, { method: 'DELETE' }),
};

export function CommentsSheet({ target, you, onClose, toast, comments: commentsApi = GYM_COMMENTS }) {
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await commentsApi.list(target);
      setComments(res.comments || []);
    } catch (e) {
      setErr(e.message || 'Could not load comments');
      setComments([]);
    }
  }, [target, commentsApi]);

  // A real effect, not a useState initializer: the initializer runs
  // DURING render, so kicking off a fetch there sets state mid-render.
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr('');
    try {
      await commentsApi.add(target, body);
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
      await commentsApi.remove(id);
      await load();
    } catch (e) {
      setErr(e.message || 'Could not delete that comment');
    }
  };

  // Portalled to <body>: ClientLayout's page wrapper carries `.anim-fadeUp`,
  // whose end-state transform makes it the containing block for every
  // `position: fixed` descendant -- so without this the sheet opens at the
  // bottom of the PAGE instead of the viewport (see UI.jsx's Modal and
  // FoodLogSheet.jsx for the same fix and the full reasoning).
  return createPortal((
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
  ), document.body);
}
