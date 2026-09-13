/**
 * WHO IS IN THIS COMMUNITY.
 *
 * A member card shows training facts and nothing else: sessions this month,
 * records this month, current streak, when they last trained. Body weight,
 * sleep, recovery and nutrition are not props this component has, so no
 * future endpoint can leak them through it by accident.
 *
 * Someone who has turned their stats off is listed by name and role, with no
 * zeros standing in for numbers they chose not to share -- "0 workouts" reads
 * as "did nothing" rather than "keeps it private", and those are different
 * statements about a person.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../../api.js';
import { Avatar } from '../../UI.jsx';
import { SectionTitle, HUE, fmt } from '../CommunityPieces.jsx';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: null };

export default function FriendMembers({ members, onSelect, onInvite, canInvite }) {
  const [query, setQuery] = useState('');
  const term = query.trim().toLowerCase();
  const shown = term ? members.filter((m) => m.name.toLowerCase().includes(term)) : members;

  return (
    <div className="space-y-3">
      {canInvite && (
        <button
          type="button"
          onClick={onInvite}
          className="w-full rounded-xl text-[12.5px] font-semibold"
          style={{ minHeight: 46, background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)' }}
        >
          Invite friends
        </button>
      )}

      {members.length > 6 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members"
          aria-label="Search members"
          className="w-full rounded-xl px-3 text-[12.5px]"
          style={{ minHeight: 44, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
        />
      )}

      <SectionTitle>{fmt(shown.length)} {shown.length === 1 ? 'member' : 'members'}</SectionTitle>

      {shown.length === 0 ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <div className="text-[12.5px]" style={{ color: 'var(--mute)' }}>
            {term ? `Nobody matches “${query.trim()}”.` : 'No members yet.'}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {shown.map((m) => <MemberCard key={m.clientId} member={m} onClick={() => onSelect(m)} />)}
        </div>
      )}
    </div>
  );
}

function MemberCard({ member: m, onClick }) {
  const role = ROLE_LABEL[m.role];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View ${m.name}`}
      className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-transform active:scale-[.99]"
      style={{
        minHeight: 66,
        background: m.isYou ? HUE.active.bg : 'var(--panel)',
        border: `1px solid ${m.isYou ? HUE.active.fg : 'var(--line)'}`,
      }}
    >
      <Avatar name={m.name} size={38} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>
            {m.isYou ? 'You' : m.name}
          </span>
          {role && (
            <span className="text-[9px] uppercase tracking-[.12em] font-bold shrink-0" style={{ color: 'var(--faint)' }}>
              {role}
            </span>
          )}
        </span>
        <span className="block text-[10.5px] mt-0.5 flex gap-2 flex-wrap" style={{ color: 'var(--mute)' }}>
          {m.gym && <span>{m.gym}</span>}
          {m.stats ? (
            <>
              {m.stats.workoutsThisMonth > 0 && (
                <span className="tabular-nums" style={{ color: HUE.workouts.fg }}>
                  {m.stats.workoutsThisMonth} this month
                </span>
              )}
              {m.stats.streak > 0 && (
                <span className="tabular-nums" style={{ color: HUE.streak.fg }}>{m.stats.streak}d streak</span>
              )}
              {m.stats.prsThisMonth > 0 && (
                <span className="tabular-nums" style={{ color: HUE.prs.fg }}>
                  {m.stats.prsThisMonth} {m.stats.prsThisMonth === 1 ? 'PR' : 'PRs'}
                </span>
              )}
              {m.stats.workoutsThisMonth === 0 && m.stats.prsThisMonth === 0 && <span>No sessions this month</span>}
            </>
          ) : (
            <span>Stats not shared</span>
          )}
        </span>
      </span>
    </button>
  );
}

/* ══════════════ MEMBER DETAIL ══════════════ */

export function FriendMemberSheet({ communityId, member, onClose, onChanged, toast }) {
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setProfile(await api(`/communities/${communityId}/members/${member.clientId}`));
    } catch (e) {
      setErr(e.message || 'Could not load that member');
    }
  }, [communityId, member.clientId]);

  useEffect(() => { load(); }, [load]);

  const act = async (run, message) => {
    setBusy(true); setErr('');
    try {
      await run();
      toast?.(message);
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(e.message || 'Could not do that');
      setBusy(false);
    }
  };

  const setRole = (role) => act(
    () => api(`/communities/${communityId}/members/${member.clientId}`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    }),
    role === 'admin' ? `${member.name} is now an admin` : `${member.name} is now a member`);

  const remove = () => act(
    () => api(`/communities/${communityId}/members/${member.clientId}`, { method: 'DELETE' }),
    `${member.name} was removed`);

  const transfer = () => act(
    () => api(`/communities/${communityId}/transfer`, {
      method: 'POST', body: JSON.stringify({ client_id: member.clientId }),
    }),
    `${member.name} owns this community now`);

  const stats = profile?.stats;
  const actions = profile?.actions || {};

  // Portalled to <body> -- see UI.jsx's Modal for why a `fixed` sheet inside
  // ClientLayout's animated page wrapper is not fixed to the viewport.
  return createPortal((
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${member.name} in this community`}
    >
      <div
        className="w-full max-w-lg rounded-t-3xl p-5 max-h-[86vh] overflow-y-auto"
        style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <Avatar name={member.name} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold truncate" style={{ color: 'var(--ink)' }}>
              {profile?.isYou ? 'You' : member.name}
            </div>
            <div className="text-[11.5px] mt-0.5 flex gap-2" style={{ color: 'var(--mute)' }}>
              <span>{ROLE_LABEL[profile?.role || member.role] || 'Member'}</span>
              {profile?.gym && <span>· {profile.gym}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-lg px-3 shrink-0" style={{ minHeight: 40, color: 'var(--mute)' }}>
            Close
          </button>
        </div>

        {profile === null && !err && (
          <div className="text-[12px] py-6 text-center" style={{ color: 'var(--mute)' }}>Loading…</div>
        )}

        {profile && !stats && (
          <p className="text-[12.5px] mt-4 leading-relaxed" style={{ color: 'var(--mute)' }}>
            {profile.isYou ? 'You are not sharing your training stats with this community.'
              : `${member.name} does not share training stats with this community.`}
          </p>
        )}

        {stats && (
          <>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <Tile label="workouts this month" value={fmt(stats.workoutsThisMonth)} hue={HUE.workouts} />
              <Tile label={stats.prsThisMonth === 1 ? 'record this month' : 'records this month'} value={fmt(stats.prsThisMonth)} hue={HUE.prs} />
              <Tile label="day streak" value={fmt(stats.streak)} hue={HUE.streak} />
              <Tile label="workouts logged" value={fmt(stats.totalWorkouts)} hue={HUE.part} />
            </div>

            {profile.milestones?.length > 0 && (
              <div className="mt-4">
                <SectionTitle>Milestones</SectionTitle>
                <div className="flex gap-1.5 flex-wrap">
                  {profile.milestones.map((m) => (
                    <span
                      key={m.key}
                      className="text-[11px] rounded-full px-2.5 py-1"
                      style={{
                        background: m.kind === 'prs' ? HUE.prs.bg : HUE.workouts.bg,
                        color: m.kind === 'prs' ? HUE.prs.fg : HUE.workouts.fg,
                      }}
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {profile?.recentShares?.length > 0 && (
          <div className="mt-4">
            <SectionTitle>Shared here</SectionTitle>
            <div className="space-y-1.5">
              {profile.recentShares.map((s) => (
                <div key={s.id} className="rounded-xl px-3 py-2 flex items-baseline justify-between gap-3"
                  style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                  <span className="text-[12px] truncate" style={{ color: 'var(--ink)' }}>
                    {s.type === 'pr'
                      ? `${s.payload.recordCount} personal ${s.payload.recordCount === 1 ? 'record' : 'records'}`
                      : s.payload.name || 'Workout'}
                  </span>
                  <span className="text-[10.5px] shrink-0" style={{ color: 'var(--faint)' }}>
                    {new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(actions.makeAdmin || actions.makeMember || actions.remove || actions.transfer) && (
          <div className="mt-5 pt-4 space-y-1.5" style={{ borderTop: '1px solid var(--line)' }}>
            {actions.makeAdmin && <Action onClick={() => setRole('admin')} disabled={busy}>Make admin</Action>}
            {actions.makeMember && <Action onClick={() => setRole('member')} disabled={busy}>Remove admin rights</Action>}
            {actions.transfer && <Action onClick={transfer} disabled={busy}>Make owner of this community</Action>}
            {actions.remove && (
              confirmRemove ? (
                <div className="rounded-xl p-3" style={{ background: 'var(--panel)', border: '1px solid rgb(var(--bad-rgb) / .4)' }}>
                  <div className="text-[12.5px]" style={{ color: 'var(--ink)' }}>Remove {member.name}?</div>
                  <p className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--mute)' }}>
                    They lose access immediately and what they shared here is removed. Their own
                    workouts and records are untouched, and they can be invited back.
                  </p>
                  <div className="grid grid-cols-2 gap-2 mt-2.5">
                    <button type="button" onClick={() => setConfirmRemove(false)}
                      className="rounded-xl text-[12.5px] font-semibold"
                      style={{ minHeight: 42, border: '1px solid var(--line)', color: 'var(--mute)' }}>
                      Cancel
                    </button>
                    <button type="button" onClick={remove} disabled={busy}
                      className="rounded-xl text-[12.5px] font-semibold"
                      style={{ minHeight: 42, background: 'rgb(var(--bad-rgb))', color: '#fff' }}>
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <Action onClick={() => setConfirmRemove(true)} danger>Remove from community</Action>
              )
            )}
          </div>
        )}

        <p className="text-[10.5px] mt-4 leading-relaxed" style={{ color: 'var(--faint)' }}>
          Community profiles show training activity only. Body measurements, nutrition, sleep and
          recovery are never shared here.
        </p>

        {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
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

function Action({ children, onClick, danger, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl px-3 text-left text-[12.5px] font-semibold"
      style={{
        minHeight: 46,
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        color: danger ? 'rgb(var(--bad-rgb))' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );
}
