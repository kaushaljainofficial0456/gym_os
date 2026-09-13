/**
 * MEMBER DISCOVERY — who is in this community, and what they have
 * publicly done.
 *
 * WHAT A MEMBER CARD MAY SHOW is decided on the server (see
 * communityIntel.memberDirectory): workouts this month, PRs this month,
 * and when they last trained. That is the whole list, and it is short on
 * purpose.
 *
 * WHAT IT MUST NEVER SHOW: body weight, nutrition, sleep, recovery, or
 * any other health data. Those are between a member and their coach.
 * Community is a social surface, not a window into someone's health
 * record -- so this component has no prop through which such a field
 * could arrive even if a future endpoint started returning one.
 *
 * Only opted-in members appear at all; the server filters them out
 * before this ever renders.
 */
import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { Avatar } from '../UI.jsx';
import { SectionTitle, HUE, fmt } from './CommunityPieces.jsx';

const FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['top', 'Top'],
];

/** "Active" means trained within the last 7 days -- stated here rather
 *  than implied, because a filter whose rule the reader cannot infer is
 *  just a mystery button. */
const ACTIVE_DAYS = 7;

export default function CommunityMembers({ you, onSelect, onFollowChange }) {
  const [members, setMembers] = useState(null);
  const [following, setFollowing] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [err, setErr] = useState('');

  /* Optimistic, because following is a one-tap gesture that should feel
     instant; reverted if the server refuses. */
  const toggleFollow = async (m) => {
    const on = following.has(m.clientId);
    setBusy(m.clientId);
    setFollowing((prev) => {
      const next = new Set(prev);
      if (on) next.delete(m.clientId); else next.add(m.clientId);
      return next;
    });
    try {
      await api(`/community/follows/${m.clientId}`, { method: on ? 'DELETE' : 'POST' });
      onFollowChange?.();
    } catch (e) {
      setFollowing((prev) => {
        const next = new Set(prev);
        if (on) next.add(m.clientId); else next.delete(m.clientId);
        return next;
      });
      setErr(e.message || 'Could not update that');
    }
    setBusy(null);
  };

  useEffect(() => {
    let alive = true;
    setErr('');
    api('/community/members?limit=200')
      .then((res) => {
        if (!alive) return;
        setMembers(res.members || []);
        // The follow set arrives WITH the list -- one request, not one per
        // member card.
        setFollowing(new Set(res.following || []));
      })
      .catch((e) => { if (alive) { setErr(e.message || 'Could not load members'); setMembers([]); } });
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => {
    let list = members || [];
    // Filtering happens client-side over an already-bounded list, so
    // typing is instant and does not fire a request per keystroke.
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((m) => m.name.toLowerCase().includes(q));
    if (filter === 'active') {
      const cutoff = new Date(Date.now() - ACTIVE_DAYS * 86400000).toISOString().slice(0, 10);
      list = list.filter((m) => m.lastActive && m.lastActive >= cutoff);
    }
    if (filter === 'top') list = list.filter((m) => m.workoutsThisMonth > 0).slice(0, 20);
    return list;
  }, [members, query, filter]);

  if (members === null) {
    return <div className="text-[12px] py-6 text-center" style={{ color: 'var(--mute)' }}>Loading members…</div>;
  }

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members"
        aria-label="Search members"
        className="w-full rounded-xl px-3 text-[12.5px]"
        style={{ minHeight: 44, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
      />

      <div className="flex gap-1.5" role="tablist" aria-label="Filter members">
        {FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(key)}
              className="rounded-lg px-3 text-[11.5px] font-semibold"
              style={{
                minHeight: 36,
                background: on ? HUE.active.bg : 'transparent',
                border: `1px solid ${on ? HUE.active.fg : 'var(--line)'}`,
                color: on ? HUE.active.fg : 'var(--mute)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {err && <div className="text-[11.5px]" style={{ color: 'var(--bad)' }}>{err}</div>}

      {shown.length === 0 ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <div className="text-[12.5px]" style={{ color: 'var(--mute)' }}>
            {query.trim()
              ? `No members match “${query.trim()}”.`
              : filter === 'active'
                ? `Nobody has trained in the last ${ACTIVE_DAYS} days.`
                : 'No members yet.'}
          </div>
        </div>
      ) : (
        <>
          <SectionTitle>
            {fmt(shown.length)} {shown.length === 1 ? 'member' : 'members'}
          </SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {shown.map((m) => (
              <MemberCard
                key={m.clientId}
                member={m}
                isYou={m.clientId === you}
                isFollowing={following.has(m.clientId)}
                busy={busy === m.clientId}
                onToggleFollow={() => toggleFollow(m)}
                onClick={() => onSelect?.(m)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MemberCard({ member: m, isYou, isFollowing, busy, onToggleFollow, onClick }) {
  // A div, not a button: the card contains its own Follow button, and a
  // button inside a button is invalid and breaks keyboard activation.
  return (
    <div
      className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left"
      style={{
        minHeight: 64,
        background: isYou ? HUE.active.bg : 'var(--panel)',
        border: `1px solid ${isYou ? HUE.active.fg : 'var(--line)'}`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-3 min-w-0 flex-1 text-left"
        aria-label={`View ${m.name}'s profile`}
      >
      <Avatar name={m.name} size={38} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {isYou ? 'You' : m.name}
        </div>
        <div className="text-[10.5px] mt-0.5 flex gap-2 flex-wrap" style={{ color: 'var(--mute)' }}>
          {m.workoutsThisMonth > 0 && (
            <span style={{ color: HUE.workouts.fg }} className="tabular-nums">
              {m.workoutsThisMonth} this month
            </span>
          )}
          {m.prsThisMonth > 0 && (
            <span style={{ color: HUE.prs.fg }} className="tabular-nums">
              {m.prsThisMonth} {m.prsThisMonth === 1 ? 'PR' : 'PRs'}
            </span>
          )}
          {/* Someone with nothing this month is shown plainly, not flagged
              as inactive. The page never ranks people by how little they
              did. */}
          {m.workoutsThisMonth === 0 && m.prsThisMonth === 0 && <span>No sessions this month</span>}
        </div>
      </div>
      </button>

      {/* Following is a one-way "show me this person's activity", so the
          button state is a fact about the viewer, never a pending request
          needing the other person's approval. */}
      {!isYou && (
        <button
          type="button"
          onClick={onToggleFollow}
          disabled={busy}
          aria-pressed={isFollowing}
          className="shrink-0 rounded-xl px-3 text-[11.5px] font-semibold transition-colors"
          style={{
            minHeight: 36,
            background: isFollowing ? 'transparent' : 'var(--accent-soft)',
            border: `1px solid ${isFollowing ? 'var(--line)' : 'var(--accent)'}`,
            color: isFollowing ? 'var(--mute)' : 'var(--accent)',
          }}
        >
          {isFollowing ? 'Following' : 'Follow'}
        </button>
      )}
    </div>
  );
}

/* ══════════════ MEMBER DETAIL ══════════════ */

/**
 * A member's public card, expanded. Renders exactly the fields the
 * directory already returned -- it deliberately makes no extra request,
 * so there is no second endpoint that could widen what is visible.
 */
export function MemberSheet({ member, isYou, onClose }) {
  if (!member) return null;
  const last = member.lastActive
    ? new Date(`${member.lastActive}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

  // Portalled to <body> -- see UI.jsx's Modal for why a `fixed` sheet inside
  // ClientLayout's animated page wrapper is not fixed to the viewport.
  return createPortal((
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${member.name} profile`}
    >
      <div
        className="w-full max-w-lg rounded-t-3xl p-5"
        style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <Avatar name={member.name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold truncate" style={{ color: 'var(--ink)' }}>
              {isYou ? 'You' : member.name}
            </div>
            {last && (
              <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
                Last trained {last}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="rounded-lg px-3 shrink-0" style={{ minHeight: 40, color: 'var(--mute)' }}>
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-4">
          <Tile label="workouts this month" value={fmt(member.workoutsThisMonth)} hue={HUE.workouts} />
          <Tile label={member.prsThisMonth === 1 ? 'PR this month' : 'PRs this month'} value={fmt(member.prsThisMonth)} hue={HUE.prs} />
        </div>

        <p className="text-[10.5px] mt-4 leading-relaxed" style={{ color: 'var(--faint)' }}>
          Community profiles show training activity only. Body measurements, nutrition
          and recovery data are never shared here.
        </p>
      </div>
    </div>
  ), document.body);
}

function Tile({ label, value, hue }) {
  return (
    <div className="rounded-2xl px-3.5 py-3" style={{ background: hue.bg, border: '1px solid var(--line)' }}>
      <div className="font-black tabular-nums leading-none whitespace-nowrap" style={{ fontSize: 24, color: hue.fg }}>
        {value}
      </div>
      <div className="text-[10.5px] mt-1.5" style={{ color: 'var(--mute)' }}>{label}</div>
    </div>
  );
}
