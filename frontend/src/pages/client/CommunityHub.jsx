/**
 * COMMUNITY — home.
 *
 * The question this screen answers is "where am I training, and with whom".
 * It lists the gym community (if the member's gym has one) and every private
 * community they have been invited into, as one list of places rather than
 * two competing features.
 *
 * WHAT IT WILL NOT DO
 *  - It will not invent activity. "23 workouts this week" is a real count of
 *    real sessions, and a new community says 0 rather than something
 *    encouraging.
 *  - It will not show a member a community they are not in. Everything here
 *    comes from /api/communities, which only ever returns the caller's own.
 *  - It will not bury the way in. Create and Join sit on the first screen,
 *    because a private community is useless until the friends are in it.
 */
import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Toast, PageSkeleton } from '../../components/UI.jsx';
import { IdentityMark, MemberStack, TypeChip, themeOf, GYM_THEME } from '../../components/community/identity.jsx';
import CreateCommunitySheet from '../../components/community/friend/CreateCommunitySheet.jsx';
import JoinWithCodeSheet from '../../components/community/friend/JoinWithCodeSheet.jsx';

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(Math.round(Number(n) || 0));

export default function CommunityHub() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [toast, setToast] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [busyInvite, setBusyInvite] = useState(null);

  const hub = useFetch(() => api('/communities'));
  const highlightInvite = params.get('invite');

  // A notification deep-link (?invite=…) should not stay in the URL after it
  // has done its job, or a refresh re-highlights an invitation long answered.
  useEffect(() => {
    if (!highlightInvite || hub.loading) return;
    const stillOpen = (hub.data?.invites || []).some((i) => i.id === highlightInvite);
    if (!stillOpen) {
      params.delete('invite');
      setParams(params, { replace: true });
    }
  }, [highlightInvite, hub.loading, hub.data, params, setParams]);

  const respond = useCallback(async (invite, accept) => {
    setBusyInvite(invite.id);
    try {
      const res = await api(`/communities/invites/${invite.id}/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      if (accept && res.communityId) {
        nav(`/app/client/community/c/${res.communityId}`);
        return;
      }
      setToast(`Invitation to ${invite.community.name} declined`);
      hub.reload({ silent: true });
    } catch (e) {
      setToast(e.message || 'Could not respond to that invitation');
    } finally {
      setBusyInvite(null);
    }
  }, [hub, nav]);

  if (hub.loading && !hub.data) return <PageSkeleton />;
  if (hub.error && !hub.data) return <ErrorState error={hub.error} onRetry={hub.reload} />;

  const gym = hub.data?.gym || { available: false };
  const communities = hub.data?.communities || [];
  const invites = hub.data?.invites || [];
  const nothingYet = !communities.length;

  return (
    <div className="pb-24">
      <header className="mb-4">
        <h1 className="font-black leading-tight" style={{ fontSize: 26, color: 'var(--ink)' }}>Community</h1>
        <p className="text-[12.5px] mt-1" style={{ color: 'var(--mute)' }}>
          Your gym, and the people you train with wherever they train.
        </p>
      </header>

      {/* ── invitations, first: they are the only thing here that expires ── */}
      {invites.length > 0 && (
        <section className="mb-5 space-y-2">
          <SectionLabel>{invites.length === 1 ? 'Invitation' : 'Invitations'}</SectionLabel>
          {invites.map((invite) => (
            <InviteCard
              key={invite.id}
              invite={invite}
              highlighted={invite.id === highlightInvite}
              busy={busyInvite === invite.id}
              onAccept={() => respond(invite, true)}
              onDecline={() => respond(invite, false)}
            />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <SectionLabel>Your communities</SectionLabel>

        {gym.available && (
          <GymCard gym={gym} onOpen={() => nav('/app/client/community/gym')} />
        )}

        {communities.map((c) => (
          <CommunityCard key={c.id} community={c} onOpen={() => nav(`/app/client/community/c/${c.id}`)} />
        ))}

        {!gym.available && nothingYet && invites.length === 0 && <FirstCommunityHero onCreate={() => setCreating(true)} />}
      </section>

      {/* ── the two ways in ── */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-2xl font-semibold text-[12.5px] transition-transform active:scale-[.98]"
          style={{ minHeight: 48, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          Create community
        </button>
        <button
          type="button"
          onClick={() => setJoining(true)}
          className="rounded-2xl font-semibold text-[12.5px] transition-transform active:scale-[.98]"
          style={{ minHeight: 48, border: '1px solid var(--line)', color: 'var(--ink)', background: 'var(--panel)' }}
        >
          Join with a code
        </button>
      </div>

      {nothingYet && (gym.available || invites.length > 0) && (
        <p className="text-[11.5px] mt-3 leading-relaxed px-1" style={{ color: 'var(--faint)' }}>
          A private community lets you train with friends from other gyms — or no gym at all.
          Only invited members can see it.
        </p>
      )}

      {creating && (
        <CreateCommunitySheet
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); nav(`/app/client/community/c/${id}`); }}
          toast={setToast}
        />
      )}
      {joining && (
        <JoinWithCodeSheet
          onClose={() => setJoining(false)}
          onJoined={(id) => { setJoining(false); nav(`/app/client/community/c/${id}`); }}
          toast={setToast}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <h2 className="text-[11px] font-bold uppercase tracking-[.14em] mb-2" style={{ color: 'var(--mute)' }}>
      {children}
    </h2>
  );
}

function CardShell({ onClick, tone, children, highlighted }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-2xl px-3.5 py-3 flex items-center gap-3.5 transition-transform active:scale-[.99]"
      style={{
        background: 'var(--panel)',
        border: `1px solid ${highlighted ? tone : 'var(--line)'}`,
        boxShadow: highlighted ? `0 0 0 3px color-mix(in srgb, ${tone} 16%, transparent)` : 'none',
        minHeight: 76,
      }}
    >
      {children}
    </button>
  );
}

function GymCard({ gym, onOpen }) {
  const joinedLine = gym.joined
    ? [
      `${fmt(gym.memberCount)} ${gym.memberCount === 1 ? 'member' : 'members'}`,
      gym.workoutsThisWeek > 0 ? `${fmt(gym.workoutsThisWeek)} this week` : null,
    ].filter(Boolean).join(' · ')
    : 'Not joined yet';

  return (
    <CardShell onClick={onOpen} tone={GYM_THEME.fg}>
      <IdentityMark name={gym.name} theme="gym" size={46} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-bold text-[14px] truncate" style={{ color: 'var(--ink)' }}>{gym.name}</span>
          <TypeChip type="gym" />
        </span>
        <span className="block text-[11.5px] mt-1 tabular-nums" style={{ color: 'var(--mute)' }}>{joinedLine}</span>
      </span>
      <Chevron />
    </CardShell>
  );
}

function CommunityCard({ community, onOpen }) {
  const tone = themeOf(community.theme).fg;
  const meta = [
    `${fmt(community.memberCount)} ${community.memberCount === 1 ? 'member' : 'members'}`,
    community.workoutsThisWeek > 0
      ? `${fmt(community.workoutsThisWeek)} ${community.workoutsThisWeek === 1 ? 'workout' : 'workouts'} this week`
      : null,
  ].filter(Boolean).join(' · ');

  return (
    <CardShell onClick={onOpen} tone={tone}>
      <IdentityMark name={community.name} theme={community.theme} mark={community.mark} size={46} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-bold text-[14px] truncate" style={{ color: 'var(--ink)' }}>{community.name}</span>
          <TypeChip type="friend" theme={community.theme} />
          {community.you?.role === 'owner' && (
            <span className="text-[9px] uppercase tracking-[.12em] font-bold" style={{ color: 'var(--faint)' }}>Owner</span>
          )}
        </span>
        <span className="block text-[11.5px] mt-1 tabular-nums" style={{ color: 'var(--mute)' }}>{meta}</span>
        {community.memberPreview?.length > 1 && (
          <span className="block mt-1.5">
            <MemberStack people={community.memberPreview} tone={tone} size={22} />
          </span>
        )}
      </span>
      <Chevron />
    </CardShell>
  );
}

function InviteCard({ invite, highlighted, busy, onAccept, onDecline }) {
  const tone = themeOf(invite.community.theme).fg;
  return (
    <div
      className="rounded-2xl p-3.5"
      style={{
        background: 'var(--panel)',
        border: `1px solid ${highlighted ? tone : 'var(--line)'}`,
        boxShadow: highlighted ? `0 0 0 3px color-mix(in srgb, ${tone} 16%, transparent)` : 'none',
      }}
    >
      <div className="flex items-center gap-3">
        <IdentityMark name={invite.community.name} theme={invite.community.theme} mark={invite.community.mark} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-[14px] truncate" style={{ color: 'var(--ink)' }}>{invite.community.name}</div>
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
            {invite.inviterName} invited you · {fmt(invite.community.memberCount)}{' '}
            {invite.community.memberCount === 1 ? 'member' : 'members'}
          </div>
        </div>
      </div>
      {invite.community.description && (
        <p className="text-[12px] mt-2.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
          {invite.community.description}
        </p>
      )}
      {/* What accepting actually shares, said before it is accepted. */}
      <p className="text-[10.5px] mt-2.5 leading-relaxed" style={{ color: 'var(--faint)' }}>
        Members will see your workout count, active days, training volume, streak and number of
        personal records. Individual workouts and records are shared only when you choose to.
        Sleep, recovery, body weight and nutrition are never shared.
      </p>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          className="rounded-xl font-semibold text-[12.5px]"
          style={{ minHeight: 44, background: tone, color: 'var(--accent-contrast)' }}
        >
          {busy ? 'Joining…' : 'Accept'}
        </button>
        <button
          type="button"
          onClick={onDecline}
          disabled={busy}
          className="rounded-xl font-semibold text-[12.5px]"
          style={{ minHeight: 44, border: '1px solid var(--line)', color: 'var(--mute)' }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

/** The empty state for someone with no gym community and no friends yet.
 *  It says what a community is FOR rather than showing a fake one. */
function FirstCommunityHero({ onCreate }) {
  return (
    <div
      className="rounded-2xl p-5 text-center"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
    >
      <div className="mx-auto mb-3" style={{ width: 64, height: 64 }}>
        <RingsGlyph />
      </div>
      <div className="font-black text-[17px]" style={{ color: 'var(--ink)' }}>Create your first community</div>
      <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
        Train with friends wherever they train. Share the sessions you want to share,
        keep score together, and set challenges.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 rounded-xl px-5 font-semibold text-[13px]"
        style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
      >
        Create community
      </button>
    </div>
  );
}

/** Three interlocking rings — the product's own visual language for
 *  "progress", used here as an illustration rather than as data. */
function RingsGlyph() {
  return (
    <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" fill="none">
      <circle cx="24" cy="26" r="15" stroke="var(--m-energy)" strokeWidth="3" opacity=".85" />
      <circle cx="40" cy="26" r="15" stroke="var(--m-training)" strokeWidth="3" opacity=".85" />
      <circle cx="32" cy="40" r="15" stroke="var(--m-strength)" strokeWidth="3" opacity=".85" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: 'var(--faint)' }} aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
