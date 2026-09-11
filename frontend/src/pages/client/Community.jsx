/**
 * SK OS COMMUNITY
 *
 * Not a leaderboard page. This screen answers three questions in order:
 * what is happening here, where do I stand, and who am I training with.
 * Progress already answers "how am I doing" -- keeping those separate is
 * why this page leads with the gym and not with the member.
 *
 * WHAT THIS PAGE WILL NOT DO
 *
 *  - It will not invent activity. Every number and every row comes from
 *    the API; a quiet gym renders as a quiet gym with honest empty states.
 *  - It will not show a section it has no data for. Sections return null
 *    rather than rendering a card full of dashes, so the page is short
 *    when the community is small and grows as the community does.
 *  - It will not rank anyone publicly by how little they did. The board
 *    shows the top and then the viewer's own row; there is no descending
 *    tail of least-active members.
 *  - It will not expose anything a member did not opt into. Membership is
 *    enforced server-side; this file never assumes it.
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Toast, PageSkeleton, Avatar } from '../../components/UI.jsx';
import {
  CommunityPulse, YourPosition, ConsistencyRing, ActivityChart,
  ChallengeCard, StreakBoard, WeeklyRecap, YouVsYou, CommunityMoment,
  SectionTitle, fmt,
} from '../../components/community/CommunityPieces.jsx';
import Leaderboard from '../../components/community/Leaderboard.jsx';
import CommunityFeed, { mergeFeed, CommentsSheet } from '../../components/community/CommunityFeed.jsx';
import ShareWorkoutSheet from '../../components/community/ShareWorkoutSheet.jsx';
import CommunityMembers, { MemberSheet } from '../../components/community/CommunityMembers.jsx';

const FEED_PAGE = 10;
// The weekly target the consistency ring measures against. Stated as a
// constant rather than implied: the ring must never suggest a member
// "should" be training 7 days a week.
const WEEKLY_TARGET = 4;

export default function Community() {
  const nav = useNavigate();
  const [period, setPeriod] = useState('week');
  const [metric, setMetric] = useState('completedWorkouts');
  const [tab, setTab] = useState('community');
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('all');
  const [commentTarget, setCommentTarget] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [memberSheet, setMemberSheet] = useState(null);

  const membershipFetch = useFetch(() => api('/community/membership'));
  const joined = !!membershipFetch.data?.membership?.enabled;
  const available = membershipFetch.data?.available !== false;

  // Every community request is gated on membership, so a client who has
  // not joined does not fire a burst of requests the server will
  // correctly refuse.
  const overviewFetch = useFetch(
    () => (joined ? api(`/community/overview?period=${period}`) : Promise.resolve(null)),
    [joined, period]);
  const boardsFetch = useFetch(
    () => (joined ? api(`/community/leaderboards?period=${period}`) : Promise.resolve(null)),
    [joined, period]);
  const challengesFetch = useFetch(
    () => (joined ? api('/community/challenges') : Promise.resolve(null)),
    [joined]);

  const [shares, setShares] = useState([]);
  const [feedOffset, setFeedOffset] = useState(0);
  const [feedHasMore, setFeedHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [social, setSocial] = useState({});

  const overview = overviewFetch.data;
  const you = overview?.position ? membershipFetch.data?.membership?.client_id : null;
  const prs = overview?.recentPRs || [];

  /* ---------- feed ---------- */

  const loadShares = useCallback(async (offset) => {
    const res = await api(`/community/feed?limit=${FEED_PAGE}&offset=${offset}`);
    return res;
  }, []);

  useEffect(() => {
    if (!joined) return;
    let alive = true;
    loadShares(0).then((res) => {
      if (!alive) return;
      setShares(res.shares || []);
      setFeedHasMore(!!res.hasMore);
      setFeedOffset(res.shares?.length || 0);
    }).catch(() => { /* the feed section renders its own empty state */ });
    return () => { alive = false; };
  }, [joined, loadShares]);

  const items = useMemo(() => {
    const merged = mergeFeed(shares, prs);
    if (filter === 'all') return merged;
    return merged.filter((i) => i.kind === filter);
  }, [shares, prs, filter]);

  /* Reaction and comment counts for the WHOLE visible page in one
     request -- one call per card would grow with the feed and only start
     hurting once a gym is actually busy. */
  const refreshSocial = useCallback(async (list) => {
    const targets = list.map((i) => ({ type: i.targetType, id: i.id }));
    if (!targets.length) { setSocial({}); return; }
    try {
      const res = await api('/community/social', {
        method: 'POST',
        body: JSON.stringify({ targets: targets.slice(0, 100) }),
      });
      setSocial(res.social || {});
    } catch { /* counts are additive detail; the feed still reads without them */ }
  }, []);

  useEffect(() => {
    if (!joined || !items.length) return;
    refreshSocial(items);
  }, [joined, items, refreshSocial]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await loadShares(feedOffset);
      // Guard against a duplicate arriving if something was inserted
      // between pages -- offset pagination can otherwise repeat a row.
      setShares((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...(res.shares || []).filter((s) => !seen.has(s.id))];
      });
      setFeedHasMore(!!res.hasMore);
      setFeedOffset((o) => o + (res.shares?.length || 0));
    } catch (e) {
      setToast(e.message || 'Could not load more');
    }
    setLoadingMore(false);
  };

  /* ---------- reactions ---------- */

  const react = async (targetType, targetId, emoji) => {
    const key = `${targetType}:${targetId}`;
    const before = social[key] || { counts: {}, mine: [], total: 0, comments: 0 };
    const had = before.mine.includes(emoji);
    // Optimistic: a reaction should feel instant. Reverted below if the
    // server disagrees.
    setSocial((s) => ({
      ...s,
      [key]: {
        ...before,
        mine: had ? before.mine.filter((m) => m !== emoji) : [...before.mine, emoji],
        counts: { ...before.counts, [emoji]: Math.max(0, (before.counts[emoji] || 0) + (had ? -1 : 1)) },
      },
    }));
    try {
      await api('/community/reactions', {
        method: 'POST',
        body: JSON.stringify({ target_type: targetType, target_id: targetId, emoji }),
      });
    } catch (e) {
      setSocial((s) => ({ ...s, [key]: before }));
      setToast(e.message || 'Could not save that reaction');
    }
  };

  /* ---------- share / copy ----------
     These three actions existed before this redesign and are carried
     forward deliberately: sharing is the only route into the feed, and
     copying is what makes another member's session useful to you rather
     than just visible. */

  const reloadFeed = useCallback(async () => {
    try {
      const res = await loadShares(0);
      setShares(res.shares || []);
      setFeedHasMore(!!res.hasMore);
      setFeedOffset(res.shares?.length || 0);
    } catch { /* keep whatever is already on screen */ }
  }, [loadShares]);

  const copyShare = async (share) => {
    try {
      await api(`/community/shares/${share.id}/copy`, {
        method: 'POST',
        body: JSON.stringify({
          name: share.workoutName,
          exercises: (share.payload || []).map((e) => ({ ...e, exercise_id: e.exercise_id || null })),
        }),
      });
      setToast('Added to your workouts');
    } catch (e) {
      setToast(e.message || 'Could not copy that workout');
    }
  };

  const unshare = async (share) => {
    try {
      await api(`/community/shares/${share.id}`, { method: 'DELETE' });
      setToast('Removed from the feed');
      reloadFeed();
    } catch (e) {
      setToast(e.message || 'Could not remove that share');
    }
  };

  /* ---------- membership ---------- */

  const setJoined = async (enabled) => {
    try {
      await api('/community/membership', { method: 'PUT', body: JSON.stringify({ enabled }) });
      membershipFetch.reload();
      setToast(enabled ? 'You joined the community' : 'You left the community');
    } catch (e) {
      setToast(e.message || 'Could not update membership');
    }
  };

  /* ---------- render ---------- */

  if (membershipFetch.loading) return <PageSkeleton />;
  if (membershipFetch.error) {
    return <ErrorState message={membershipFetch.error} onRetry={membershipFetch.reload} />;
  }

  const gymName = overview?.gym?.name || membershipFetch.data?.gym?.name || 'Your Gym';

  if (!available) {
    return (
      <div className="pb-24">
        <h1 className="font-black text-[24px] mb-2" style={{ color: 'var(--ink)' }}>Community</h1>
        <div className="rounded-2xl p-5" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
            Community is a gym feature
          </div>
          <div className="text-[12px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
            You are training independently, so there is no gym community to join yet.
          </div>
        </div>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="pb-24">
        <h1 className="font-black text-[24px]" style={{ color: 'var(--ink)' }}>{gymName}</h1>
        <div className="rounded-2xl p-5 mt-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <div className="text-[14px] font-bold" style={{ color: 'var(--ink)' }}>Join your gym community</div>
          <div className="text-[12.5px] mt-2 leading-relaxed" style={{ color: 'var(--mute)' }}>
            See what your gym is training, where you stand, and celebrate other members'
            personal records. Your workouts stay private unless you choose to share them,
            and you can leave at any time.
          </div>
          <button
            type="button"
            onClick={() => setJoined(true)}
            className="mt-4 w-full rounded-xl font-semibold text-[13px]"
            style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Join community
          </button>
        </div>
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </div>
    );
  }

  const pulse = overview?.pulse;
  const position = overview?.position;
  const streaks = boardsFetch.data?.leaderboards?.streak || [];
  const yourStreak = streaks.find((s) => s.clientId === you)?.value || 0;
  const challenges = challengesFetch.data?.challenges || [];

  return (
    <div className="pb-24">
      {/* ── header ── */}
      <header className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-black leading-tight" style={{ fontSize: 24, color: 'var(--ink)' }}>
              {gymName}
            </h1>
            {pulse && (
              <div className="text-[12px] mt-1" style={{ color: 'var(--mute)' }}>
                {fmt(pulse.members)} {pulse.members === 1 ? 'member' : 'members'}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setJoined(false)}
            className="text-[11.5px] rounded-lg px-3 shrink-0"
            style={{ minHeight: 36, border: '1px solid var(--line)', color: 'var(--mute)' }}
          >
            Leave
          </button>
        </div>

        <CommunityMoment pulse={pulse} busiestWeekday={overview?.busiestWeekday} />
      </header>

      {/* ── section tabs ── */}
      <div className="flex gap-1.5 mb-4 flex-wrap" role="tablist" aria-label="Community sections">
        {[['community', 'Community'], ['leaderboard', 'Leaderboard'], ['activity', 'Activity'], ['members', 'Members']].map(([key, label]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={on}
              onClick={() => setTab(key)}
              className="flex-1 rounded-xl text-[12px] font-semibold transition-colors whitespace-nowrap"
              style={{
                minHeight: 40,
                minWidth: 84,
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

      {overviewFetch.loading && !overview && <PageSkeleton />}
      {overviewFetch.error && (
        <ErrorState message={overviewFetch.error} onRetry={overviewFetch.reload} />
      )}

      {/* On a wide screen the page becomes two columns rather than one
          stretched phone layout. */}
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-5 xl:items-start">
        <div className="space-y-4 min-w-0">
          {tab === 'community' && (
            <>
              <CommunityPulse
                pulse={pulse}
                onOpenPRs={() => { setTab('activity'); setFilter('pr'); }}
                onOpenMembers={() => setTab('members')}
              />
              <YourPosition position={position} streak={yourStreak} />
              {position && (
                <ConsistencyRing workouts={position.workouts} target={WEEKLY_TARGET} />
              )}
              {challenges.length > 0 && (
                <div>
                  <SectionTitle>Challenges</SectionTitle>
                  <div className="space-y-2">
                    {challenges.map((c) => <ChallengeCard key={c.id} challenge={c} />)}
                  </div>
                </div>
              )}
              <ActivityChart series={overview?.activity} todayKey={pulse?.week?.end} />
              <YouVsYou trend={overview?.trend} />
              <WeeklyRecap recap={overview?.recap} you={you} />
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
              <Leaderboard
                boards={boardsFetch.data?.leaderboards || {}}
                metric={metric}
                onMetricChange={setMetric}
                period={period}
                you={you}
              />
              <StreakBoard streaks={streaks} you={you} yourStreak={yourStreak} />
            </>
          )}

          {tab === 'activity' && (
            <>
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                className="w-full mb-2 rounded-xl text-[12.5px] font-semibold"
                style={{ minHeight: 44, background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)' }}
              >
                Share a workout
              </button>
            )}
            <CommunityFeed
              items={items}
              social={social}
              you={you}
              onReact={react}
              onOpenComments={setCommentTarget}
              onShare={() => setShareOpen(true)}
              onCopy={copyShare}
              onUnshare={unshare}
              filter={filter}
              onFilterChange={setFilter}
              hasMore={feedHasMore}
              onLoadMore={loadMore}
              loadingMore={loadingMore}
            />
            </>
          )}

          {tab === 'members' && (
            <CommunityMembers you={you} onSelect={setMemberSheet} />
          )}
        </div>

        {/* Desktop sidebar: context BESIDE the main column, never a second
            copy of it. Streaks already render inside the Leaderboard tab
            and the recap inside the Community tab, so each is shown here
            only when the current tab is not already showing it ---
            otherwise a wide screen displayed the same card twice. */}
        <aside className="hidden xl:block space-y-4 min-w-0">
          {tab !== 'leaderboard' && (
            <StreakBoard streaks={streaks} you={you} yourStreak={yourStreak} />
          )}
          {tab !== 'community' && <WeeklyRecap recap={overview?.recap} you={you} />}
        </aside>
      </div>

      {shareOpen && (
        <ShareWorkoutSheet
          onClose={() => setShareOpen(false)}
          onShared={reloadFeed}
          alreadyShared={new Set(shares.filter((sh) => sh.clientId === you).map((sh) => sh.workoutId))}
          toast={setToast}
        />
      )}
      {memberSheet && (
        <MemberSheet
          member={memberSheet}
          isYou={memberSheet.clientId === you}
          onClose={() => setMemberSheet(null)}
        />
      )}
      {commentTarget && (
        <CommentsSheet
          target={commentTarget}
          you={you}
          onClose={() => { setCommentTarget(null); refreshSocial(items); }}
          toast={setToast}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  );
}
