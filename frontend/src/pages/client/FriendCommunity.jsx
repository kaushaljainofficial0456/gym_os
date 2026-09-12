/**
 * A FRIEND COMMUNITY.
 *
 * Same three questions the gym community answers -- what is happening here,
 * where do I stand, who am I training with -- for a group whose members can
 * be at three different gyms or no gym at all.
 *
 * WHAT THIS PAGE WILL NOT DO
 *  - It will not invent activity. Every number comes from the API, and a
 *    quiet week renders as a quiet week.
 *  - It will not show a section it has no data for. A new community is a
 *    short page that grows as the group does, not a wall of empty cards.
 *  - It will not publish anything. Sharing happens through an explicit
 *    picker, per session, per community.
 *  - It will not let anyone act in the wrong community: the community is in
 *    the URL, and its name and colour are on screen at all times.
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Toast, PageSkeleton } from '../../components/UI.jsx';
import {
  YourPosition, ActivityChart, ChallengeCard, StreakBoard, WeeklyRecap, YouVsYou,
  SectionTitle, RingRow, ActivityHeatmap, MilestoneStrip, HUE, challengeHue, fmt,
} from '../../components/community/CommunityPieces.jsx';
import Leaderboard from '../../components/community/Leaderboard.jsx';
import { FeedCard, CommentsSheet } from '../../components/community/CommunityFeed.jsx';
import { IdentityMark, MemberStack, themeOf } from '../../components/community/identity.jsx';
import CommunitySwitcher from '../../components/community/friend/CommunitySwitcher.jsx';
import InvitePanel from '../../components/community/friend/InvitePanel.jsx';
import CommunitySettingsSheet from '../../components/community/friend/CommunitySettingsSheet.jsx';
import ShareWorkoutHereSheet from '../../components/community/friend/ShareWorkoutHereSheet.jsx';
import FriendMembers, { FriendMemberSheet } from '../../components/community/friend/FriendMembers.jsx';
import { CreateChallengeSheet, ChallengeDetailSheet } from '../../components/community/friend/ChallengeSheets.jsx';
import { Modal } from '../../components/UI.jsx';

const FEED_PAGE = 12;
// The weekly target the consistency ring measures against -- the same one the
// gym community uses. Stated as a constant rather than implied: the ring must
// never suggest a member "should" train seven days a week.
const WEEKLY_TARGET = 4;

const TABS = [['overview', 'Overview'], ['leaderboard', 'Leaderboard'], ['activity', 'Activity'], ['members', 'Members']];
const FEED_FILTERS = [['all', 'All'], ['workouts', 'Workouts'], ['prs', 'Records'], ['members', 'People']];

export default function FriendCommunity() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview'));
  const [period, setPeriod] = useState('week');
  const [metric, setMetric] = useState('completedWorkouts');
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState('');
  const [sheet, setSheet] = useState(null);
  const [openChallenge, setOpenChallenge] = useState(null);
  const [memberSheet, setMemberSheet] = useState(null);
  const [commentTarget, setCommentTarget] = useState(null);

  const overview = useFetch(() => api(`/communities/${id}/overview?period=${period}`), [id, period]);
  const boards = useFetch(
    () => (tab === 'leaderboard' ? api(`/communities/${id}/leaderboards?period=${period}`) : Promise.resolve(null)),
    [id, period, tab]);
  const members = useFetch(
    () => (tab === 'members' ? api(`/communities/${id}/members`) : Promise.resolve(null)),
    [id, tab, overview.data?.community?.memberCount]);

  const [events, setEvents] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [social, setSocial] = useState({});

  const community = overview.data?.community;
  const you = community?.you;
  const can = you?.permissions || {};

  const setTabParam = (next) => {
    setTab(next);
    if (next === 'overview') params.delete('tab'); else params.set('tab', next);
    setParams(params, { replace: true });
  };

  /* ---------- feed ---------- */

  const loadFeed = useCallback(async (after = null) => {
    const query = new URLSearchParams({ limit: String(FEED_PAGE), filter });
    if (after) query.set('cursor', after);
    return api(`/communities/${id}/feed?${query.toString()}`);
  }, [id, filter]);

  useEffect(() => {
    let alive = true;
    loadFeed().then((res) => {
      if (!alive) return;
      setEvents(res.events || []);
      setCursor(res.nextCursor || null);
    }).catch(() => { /* the feed renders its own empty state */ });
    return () => { alive = false; };
  }, [loadFeed]);

  const refreshSocial = useCallback(async (list) => {
    const ids = list.filter((e) => e.type === 'workout' || e.type === 'pr').map((e) => e.id);
    if (!ids.length) { setSocial({}); return; }
    try {
      const res = await api(`/communities/${id}/social`, {
        method: 'POST', body: JSON.stringify({ event_ids: ids.slice(0, 100) }),
      });
      setSocial(res.social || {});
    } catch { /* counts are additive detail; the feed still reads without them */ }
  }, [id]);

  useEffect(() => { if (events.length) refreshSocial(events); }, [events, refreshSocial]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await loadFeed(cursor);
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...(res.events || []).filter((e) => !seen.has(e.id))];
      });
      setCursor(res.nextCursor || null);
    } catch (e) {
      setToast(e.message || 'Could not load more');
    }
    setLoadingMore(false);
  };

  const reloadFeed = useCallback(async () => {
    try {
      const res = await loadFeed();
      setEvents(res.events || []);
      setCursor(res.nextCursor || null);
    } catch { /* keep what is on screen */ }
  }, [loadFeed]);

  /* ---------- reactions ---------- */

  const react = async (targetType, eventId, emoji) => {
    const before = social[eventId] || { counts: {}, mine: [], total: 0, comments: 0 };
    const had = before.mine.includes(emoji);
    setSocial((s) => ({
      ...s,
      [eventId]: {
        ...before,
        mine: had ? before.mine.filter((m) => m !== emoji) : [...before.mine, emoji],
        counts: { ...before.counts, [emoji]: Math.max(0, (before.counts[emoji] || 0) + (had ? -1 : 1)) },
      },
    }));
    try {
      await api(`/communities/${id}/reactions`, {
        method: 'POST', body: JSON.stringify({ event_id: eventId, emoji }),
      });
    } catch (e) {
      setSocial((s) => ({ ...s, [eventId]: before }));
      setToast(e.message || 'Could not save that reaction');
    }
  };

  const removeEvent = async (item) => {
    try {
      await api(`/communities/${id}/events/${item.id}`, { method: 'DELETE' });
      setToast('Removed from the feed');
      reloadFeed();
      overview.reload({ silent: true });
    } catch (e) {
      setToast(e.message || 'Could not remove that');
    }
  };

  const copyWorkout = async (item) => {
    try {
      const res = await api(`/communities/${id}/events/${item.id}/copy`, { method: 'POST' });
      const n = res?.exerciseCount || 0;
      setToast(`Saved to My Workout${n ? ` · ${n} ${n === 1 ? 'exercise' : 'exercises'}` : ''}`);
    } catch (e) {
      setToast(e.message || 'Could not save that workout');
    }
  };

  const commentsApi = useMemo(() => ({
    list: (target) => api(`/communities/${id}/comments?event_id=${encodeURIComponent(target.id)}`),
    add: (target, body) => api(`/communities/${id}/comments`, {
      method: 'POST', body: JSON.stringify({ event_id: target.id, body }),
    }),
    remove: (commentId) => api(`/communities/${id}/comments/${commentId}`, { method: 'DELETE' }),
  }), [id]);

  /* ---------- render ---------- */

  if (overview.loading && !overview.data) return <PageSkeleton />;
  if (overview.error && !overview.data) {
    const gone = overview.error?.status === 404;
    return (
      <div className="pb-24">
        <ErrorState
          error={gone ? new Error('This community is no longer available to you.') : overview.error}
          onRetry={gone ? undefined : overview.reload}
        />
        <button
          type="button"
          onClick={() => nav('/app/client/community')}
          className="w-full mt-3 rounded-xl text-[12.5px] font-semibold"
          style={{ minHeight: 46, border: '1px solid var(--line)', color: 'var(--ink)' }}
        >
          Back to your communities
        </button>
      </div>
    );
  }

  const { pulse, position, streaks = [], yourStreak = 0, challenges, milestones, recap, activity, trend } = overview.data || {};
  const tone = themeOf(community?.theme).fg;
  const active = challenges?.active || [];
  const communityGoal = active.find((c) => c.scope === 'community');
  const yourChallenge = active.find((c) => c.scope === 'member');
  const isAlone = community?.memberCount === 1;
  const nothingYet = (pulse?.workoutsThisWeek || 0) === 0 && !events.some((e) => e.type === 'workout' || e.type === 'pr');

  const rings = [
    position && {
      key: 'you',
      value: Math.min(1, (position.workouts || 0) / WEEKLY_TARGET),
      color: HUE.workouts.fg,
      label: 'Your week',
      detail: `${position.workouts} / ${WEEKLY_TARGET}`,
    },
    communityGoal && {
      key: 'goal',
      value: communityGoal.percent / 100,
      color: challengeHue(communityGoal.metric).fg,
      label: 'Community goal',
      detail: `${fmt(communityGoal.value)} / ${fmt(communityGoal.goal)}`,
    },
    yourChallenge && {
      key: 'challenge',
      value: yourChallenge.yourPercent / 100,
      color: challengeHue(yourChallenge.metric).fg,
      label: 'Challenge',
      detail: `${fmt(yourChallenge.yourValue)} / ${fmt(yourChallenge.goal)}`,
    },
  ].filter(Boolean);

  const feedItems = events.map(toItem).filter(Boolean);

  return (
    <div className="pb-24">
      {/* ── header ── */}
      <header className="mb-4">
        <div className="flex items-start justify-between gap-2">
          <CommunitySwitcher
            current={{ id: community.id, name: community.name, theme: community.theme, mark: community.mark, type: 'friend' }}
            onNavigate={nav}
          />
          <div className="flex items-center gap-1.5 shrink-0">
            {can.invite && (
              <HeaderButton onClick={() => setSheet('invite')} label="Invite people">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19 8v6M22 11h-6" />
              </HeaderButton>
            )}
            <HeaderButton onClick={() => setSheet('settings')} label="Community settings">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </HeaderButton>
          </div>
        </div>

        {/* Identity band: who this is, in the group's own colour. */}
        <div
          className="rounded-2xl px-4 py-3.5 mt-3"
          style={{
            background: `linear-gradient(135deg, color-mix(in srgb, ${tone} 16%, var(--panel)), var(--panel))`,
            border: `1px solid color-mix(in srgb, ${tone} 30%, var(--line))`,
          }}
        >
          {community.description && (
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>{community.description}</p>
          )}
          <div className="flex items-center justify-between gap-3 mt-2">
            <div className="text-[11.5px] tabular-nums" style={{ color: 'var(--mute)' }}>
              {fmt(community.memberCount)} {community.memberCount === 1 ? 'member' : 'members'} · Private
            </div>
            <MemberStack people={overview.data?.memberPreview || []} tone={tone} size={24} />
          </div>

          {pulse && (
            <div className="flex gap-1.5 flex-wrap mt-3">
              <Pulse value={pulse.workoutsThisWeek} label="workouts this week" hue={HUE.workouts} />
              <Pulse value={pulse.prsThisWeek} label={pulse.prsThisWeek === 1 ? 'record' : 'records'} hue={HUE.prs} />
              <Pulse value={pulse.activeThisWeek} label="active" hue={HUE.active} />
            </div>
          )}
        </div>
      </header>

      {/* ── tabs ── */}
      <div className="flex gap-1.5 mb-4 flex-wrap" role="tablist" aria-label="Community sections">
        {TABS.map(([key, label]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={on}
              onClick={() => setTabParam(key)}
              className="flex-1 rounded-xl text-[12px] font-semibold transition-colors whitespace-nowrap"
              style={{
                minHeight: 40,
                minWidth: 80,
                background: on ? `color-mix(in srgb, ${tone} 14%, transparent)` : 'transparent',
                border: `1px solid ${on ? tone : 'var(--line)'}`,
                color: on ? tone : 'var(--mute)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-5 xl:items-start">
        <div className="space-y-4 min-w-0">
          {tab === 'overview' && (
            <>
              {isAlone && nothingYet && <ReadyState name={community.name} tone={tone} canInvite={can.invite} onInvite={() => setSheet('invite')} />}

              {rings.length > 0 && <RingRow rings={rings} />}
              <YourPosition position={position} streak={yourStreak} />

              {!you?.shareStats && (
                <Note>
                  You are not sharing your training stats with this community, so you do not appear on its
                  boards or totals. You can turn that back on in settings.
                </Note>
              )}

              {(active.length > 0 || can.manageChallenges) && (
                <div>
                  <SectionTitle
                    action={can.manageChallenges ? (
                      <button
                        type="button"
                        onClick={() => setSheet('challenge')}
                        className="text-[11.5px] font-semibold"
                        style={{ color: tone }}
                      >
                        New
                      </button>
                    ) : null}
                  >
                    Challenges
                  </SectionTitle>
                  {active.length > 0 ? (
                    <div className="space-y-2">
                      {active.map((c) => (
                        <ChallengeCard key={c.id} challenge={c} onOpen={() => setOpenChallenge(c.id)} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl p-4 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                      <div className="text-[12.5px]" style={{ color: 'var(--mute)' }}>
                        No challenge running. Set one and everyone has something to chase.
                      </div>
                    </div>
                  )}
                  {challenges?.ended?.length > 0 && (
                    <div className="mt-2 space-y-2">
                      <div className="text-[10px] uppercase tracking-[.13em]" style={{ color: 'var(--faint)' }}>Just finished</div>
                      {challenges.ended.map((c) => (
                        <ChallengeCard key={c.id} challenge={c} onOpen={() => setOpenChallenge(c.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              <ActivityChart series={activity} todayKey={pulse?.week?.end} />
              <ActivityHeatmap series={activity} />
              <YouVsYou trend={trend} />
              <MilestoneStrip milestones={milestones} />
              <WeeklyRecap recap={recap} you={you?.clientId} />
              {recap?.highestStreak && (
                <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                  <SectionTitle>Longest streak right now</SectionTitle>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                      {recap.highestStreak.clientId === you?.clientId ? 'You' : recap.highestStreak.name}
                    </span>
                    <span className="font-black tabular-nums" style={{ fontSize: 20, color: HUE.streak.fg }}>
                      {recap.highestStreak.value}d
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'leaderboard' && (
            <>
              <div className="flex gap-1.5" role="tablist" aria-label="Leaderboard period">
                {[['day', 'Today'], ['week', 'This week'], ['month', 'This month']].map(([key, label]) => {
                  const on = period === key;
                  return (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={on}
                      onClick={() => setPeriod(key)}
                      className="flex-1 rounded-lg text-[11.5px] font-semibold"
                      style={{
                        minHeight: 36,
                        background: on ? `color-mix(in srgb, ${tone} 14%, transparent)` : 'transparent',
                        border: `1px solid ${on ? tone : 'var(--line)'}`,
                        color: on ? tone : 'var(--mute)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {boards.loading && !boards.data && <PageSkeleton />}
              <Leaderboard
                boards={boards.data?.leaderboards || {}}
                definitions={boards.data?.definitions}
                metric={metric}
                onMetricChange={setMetric}
                period={period}
                you={you?.clientId}
              />
              <StreakBoard streaks={streaks} you={you?.clientId} yourStreak={yourStreak} />
            </>
          )}

          {tab === 'activity' && (
            <>
              <button
                type="button"
                onClick={() => setSheet('share')}
                className="w-full rounded-xl text-[12.5px] font-semibold"
                style={{ minHeight: 46, background: `color-mix(in srgb, ${tone} 14%, transparent)`, border: `1px solid ${tone}`, color: tone }}
              >
                Share a workout
              </button>

              {feedItems.some((i) => i.kind === 'share' || i.kind === 'pr') && (
                <div className="flex gap-1.5 flex-wrap" role="tablist" aria-label="Filter activity">
                  {FEED_FILTERS.map(([key, label]) => {
                    const on = filter === key;
                    return (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={on}
                        onClick={() => setFilter(key)}
                        className="rounded-lg px-3 text-[11.5px] font-semibold"
                        style={{
                          minHeight: 34,
                          background: on ? `color-mix(in srgb, ${tone} 14%, transparent)` : 'transparent',
                          border: `1px solid ${on ? tone : 'var(--line)'}`,
                          color: on ? tone : 'var(--mute)',
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {feedItems.length === 0 ? (
                <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                  <div className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>Nothing here yet</div>
                  <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
                    Workouts and personal records appear here when members choose to share them.
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {feedItems.map((item) => (
                    <FeedCard
                      key={item.id}
                      item={item}
                      social={social[item.id]}
                      isYou={item.clientId === you?.clientId}
                      gym={item.gym}
                      verb={item.verb}
                      removable={item.kind === 'share' || item.kind === 'pr'}
                      onReact={react}
                      onOpenComments={setCommentTarget}
                      onCopy={item.kind === 'share' ? copyWorkout : undefined}
                      onUnshare={removeEvent}
                    />
                  ))}
                  {cursor && (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="w-full rounded-xl text-[12.5px] font-semibold"
                      style={{ minHeight: 44, border: '1px solid var(--line)', color: 'var(--mute)' }}
                    >
                      {loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {tab === 'members' && (
            members.loading && !members.data
              ? <PageSkeleton />
              : (
                <FriendMembers
                  members={members.data?.members || []}
                  onSelect={setMemberSheet}
                  onInvite={() => setSheet('invite')}
                  canInvite={can.invite}
                />
              )
          )}
        </div>

        {/* Desktop sidebar: context BESIDE the main column, never a second copy
            of it -- each card is shown here only when the current tab is not
            already showing it. */}
        <aside className="hidden xl:block space-y-4 min-w-0">
          {tab !== 'leaderboard' && <StreakBoard streaks={streaks} you={you?.clientId} yourStreak={yourStreak} />}
          {tab !== 'overview' && <MilestoneStrip milestones={milestones} />}
          {tab !== 'overview' && <WeeklyRecap recap={recap} you={you?.clientId} />}
        </aside>
      </div>

      {/* ── sheets ── */}
      {sheet === 'invite' && (
        <Modal open onClose={() => setSheet(null)} title="Invite to this community" sub={community.name}>
          <InvitePanel
            communityId={community.id}
            communityName={community.name}
            onToast={setToast}
            onChanged={() => overview.reload({ silent: true })}
          />
        </Modal>
      )}
      {sheet === 'settings' && (
        <CommunitySettingsSheet
          community={community}
          members={members.data?.members || []}
          onClose={() => setSheet(null)}
          onChanged={() => { overview.reload({ silent: true }); members.reload({ silent: true }); }}
          onGone={() => nav('/app/client/community')}
          toast={setToast}
        />
      )}
      {sheet === 'share' && (
        <ShareWorkoutHereSheet
          communityId={community.id}
          communityName={community.name}
          onClose={() => setSheet(null)}
          onShared={() => { reloadFeed(); overview.reload({ silent: true }); }}
          toast={setToast}
        />
      )}
      {sheet === 'challenge' && (
        <CreateChallengeSheet
          communityId={community.id}
          today={overview.data?.today}
          onClose={() => setSheet(null)}
          onCreated={() => overview.reload({ silent: true })}
          toast={setToast}
        />
      )}
      {openChallenge && (
        <ChallengeDetailSheet
          communityId={community.id}
          challengeId={openChallenge}
          canManage={can.manageChallenges}
          onClose={() => setOpenChallenge(null)}
          onChanged={() => overview.reload({ silent: true })}
          toast={setToast}
        />
      )}
      {memberSheet && (
        <FriendMemberSheet
          communityId={community.id}
          member={memberSheet}
          onClose={() => setMemberSheet(null)}
          onChanged={() => { members.reload({ silent: true }); overview.reload({ silent: true }); }}
          toast={setToast}
        />
      )}
      {commentTarget && (
        <CommentsSheet
          target={commentTarget}
          you={you?.clientId}
          comments={commentsApi}
          onClose={() => { setCommentTarget(null); refreshSocial(events); }}
          toast={setToast}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  );
}

/** A feed event in the shape the shared card component reads. */
function toItem(e) {
  const base = {
    id: e.id,
    targetType: 'event',
    at: e.createdAt,
    clientId: e.clientId,
    name: e.authorName,
    gym: e.gym,
  };
  if (e.type === 'workout') {
    return {
      ...base,
      kind: 'share',
      data: {
        workoutName: e.payload.name,
        payload: e.payload.exercises || [],
        setCount: e.payload.setCount,
        durationMin: e.payload.durationMin,
        volume: e.payload.volume,
        prCount: e.payload.prCount,
      },
    };
  }
  if (e.type === 'pr') return { ...base, kind: 'pr', data: e.payload };
  return {
    ...base,
    kind: e.type === 'created' ? 'created' : 'joined',
    verb: e.type === 'created' ? 'started this community' : 'joined',
    data: {},
  };
}

function Pulse({ value, label, hue }) {
  return (
    <span
      className="text-[11px] rounded-full px-2.5 py-1 tabular-nums"
      style={{ background: hue.bg, color: hue.fg }}
    >
      <strong className="font-black">{fmt(value)}</strong> {label}
    </span>
  );
}

function Note({ children }) {
  return (
    <div className="rounded-2xl p-3.5 text-[11.5px] leading-relaxed"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--mute)' }}>
      {children}
    </div>
  );
}

/** The first screen of a brand-new community: one instruction, no fake
 *  members, no sample activity. */
function ReadyState({ name, tone, canInvite, onInvite }) {
  return (
    <div
      className="rounded-2xl p-5 text-center"
      style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${tone} 14%, var(--panel)), var(--panel))`, border: `1px solid ${tone}` }}
    >
      <div className="font-black text-[17px]" style={{ color: 'var(--ink)' }}>{name} is ready</div>
      <p className="text-[12.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
        Invite your training partners. Once they are in, their sessions, records and streaks show up here.
      </p>
      {canInvite && (
        <button
          type="button"
          onClick={onInvite}
          className="mt-4 rounded-xl px-5 font-semibold text-[13px]"
          style={{ minHeight: 46, background: tone, color: 'var(--accent-contrast)' }}
        >
          Invite friends
        </button>
      )}
    </div>
  );
}

function HeaderButton({ onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="rounded-xl grid place-items-center"
      style={{ width: 40, height: 40, border: '1px solid var(--line)', color: 'var(--mute)', background: 'var(--panel)' }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
