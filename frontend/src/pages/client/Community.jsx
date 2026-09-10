/**
 * GYM COMMUNITY — leaderboards, activity feed, workout sharing
 * Opt-in participation. Org-scoped. Privacy-first (default OFF).
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, Avatar, Empty, Toast, Skeleton, XIcon, PageSkeleton } from '../../components/UI.jsx';
import Icon from '../../components/Icon.jsx';

// Page size for the activity feed. The API caps limit at 100 and defaults to
// 30; 10 keeps the first paint small on a phone, where this page lives.
const FEED_PAGE_SIZE = 10;

const MEDAL = ['🥇', '🥈', '🥉'];
const MEDAL_TONE = ['var(--gold, #C4A06A)', '#C0C0C0', '#CD7F32'];

export default function Community() {
  const nav = useNavigate();
  const membershipFetch = useFetch(() => api('/community/membership'));
  const [period, setPeriod] = useState('week');

  /* Both of these are gated on membership.
     They used to fire unconditionally on mount, in parallel with the
     membership check — so every visit by a client who has NOT joined the
     community made two requests the server correctly answered 403, on a
     page that then rendered the join prompt and never used either result.
     Two wasted round trips per visit, and a console full of red for anyone
     debugging something else on this screen.
     `Promise.resolve(null)` rather than a conditional hook, matching the
     pattern Dashboard.jsx already uses for its trainer/owner split — hooks
     cannot be called conditionally, but the work inside them can be. */
  const joined = !!membershipFetch.data?.membership?.enabled;
  const lbFetch = useFetch(
    () => (joined ? api(`/community/leaderboards?period=${period}`) : Promise.resolve(null)),
    [period, joined]
  );
  // Page 1 stays on useFetch so it keeps the shared loading/error/Retry
  // semantics, and so the reload() calls after share/unshare/copy below
  // reset pagination for free. Later pages are appended separately.
  const feedFetch = useFetch(
    () => (joined ? api(`/community/feed?limit=${FEED_PAGE_SIZE}&offset=0`) : Promise.resolve(null)),
    [joined]
  );
  const [extraShares, setExtraShares] = useState([]);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  // Bumped whenever page 1 is refetched. A "load more" that was already in
  // flight compares this before committing, so a slow older response can
  // never append onto a newer feed (or resurrect a share that was just
  // unshared).
  const feedSeq = useRef(0);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3000);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // These two live up here with the other hooks, ABOVE the early returns
  // further down (loading / community-disabled / not-a-member all return
  // before the member view). A hook placed after a conditional return is only
  // called on some renders, which React rejects with "Rendered more hooks
  // than during the previous render" -- it crashed the whole page into the
  // error boundary until they were moved here.
  //
  // A fresh page 1 (initial load, Retry, or reload() after share/unshare/copy)
  // discards every appended page and invalidates in-flight ones.
  useEffect(() => {
    feedSeq.current += 1;
    setExtraShares([]);
    setMoreError(null);
    setMoreLoading(false);
    setHasMore(!!feedFetch.data?.hasMore);
  }, [feedFetch.data]);

  // Deduplicated by id: offset paging can still repeat a row if a share is
  // deleted between two page requests and shifts everything down one slot.
  const shares = useMemo(() => {
    const page1 = feedFetch.data?.shares || [];
    const seen = new Set(page1.map((s) => s.id));
    const rest = [];
    for (const s of extraShares) {
      if (!seen.has(s.id)) { seen.add(s.id); rest.push(s); }
    }
    return page1.concat(rest);
  }, [feedFetch.data, extraShares]);
  const [sharing, setSharing] = useState(null); // workout_id being shared
  const [copyModal, setCopyModal] = useState(null); // share object
  const [copyForm, setCopyForm] = useState({ name: '', exercises: [] });
  const [copying, setCopying] = useState(false);

  const membership = membershipFetch.data?.membership;
  const settings = membershipFetch.data?.settings;
  const gym = membershipFetch.data?.gym;
  const isMember = !!membership?.enabled;
  const communityEnabled = settings?.community_enabled !== false;

  const toggleMembership = async () => {
    try {
      const res = await api('/community/membership', {
        method: 'PUT',
        body: JSON.stringify({ enabled: !isMember }),
      });
      // silent: true -- this page gates its whole render on
      // `membershipFetch.loading` (below); a bare reload() would unmount
      // everything for the duration of the refetch, same class of bug
      // already fixed for Nutrition.jsx (see useFetch's own comment).
      membershipFetch.reload({ silent: true });
      lbFetch.reload({ silent: true });
      feedFetch.reload({ silent: true });
      showToast(isMember ? 'Left community' : 'Welcome to the community!');
    } catch (e) {
      showToast(e.message || 'Could not update membership');
    }
  };

  const shareWorkout = async (workoutId) => {
    setSharing(workoutId);
    try {
      await api('/community/shares', {
        method: 'POST',
        body: JSON.stringify({ workout_id: workoutId }),
      });
      showToast('Workout shared with your gym!');
      feedFetch.reload({ silent: true });
    } catch (e) {
      showToast(e.message || 'Could not share workout');
    }
    setSharing(null);
  };

  const unshare = async (shareId) => {
    try {
      await api(`/community/shares/${shareId}`, { method: 'DELETE' });
      showToast('Share removed');
      feedFetch.reload({ silent: true });
    } catch (e) {
      showToast(e.message || 'Could not remove share');
    }
  };

  const openCopy = (share) => {
    setCopyModal(share);
    setCopyForm({
      name: share.workoutName,
      exercises: (share.payload || []).map(e => ({
        ...e,
        exercise_id: e.exercise_id || null,
      })),
    });
  };

  const doCopy = async () => {
    if (!copyModal) return;
    setCopying(true);
    try {
      const res = await api(`/community/shares/${copyModal.id}/copy`, {
        method: 'POST',
        body: JSON.stringify({ name: copyForm.name, exercises: copyForm.exercises }),
      });
      showToast('Workout added to your library!');
      setCopyModal(null);
    } catch (e) {
      showToast(e.message || 'Could not copy workout');
    }
    setCopying(false);
  };

  if (membershipFetch.loading) return <PageSkeleton variant="split" label="Loading community" />;
  if (membershipFetch.error) return <ErrorState error={membershipFetch.error} onRetry={membershipFetch.reload} />;

  // Community not enabled by gym
  if (!communityEnabled) {
    return (
      <div className="space-y-4 pb-28">
        <div className="card p-8 text-center">
          <Icon name="lock" size={40} className="mx-auto mb-3" style={{ color: 'var(--faint)' }} />
          <h2 className="font-grotesk font-bold text-lg" style={{ color: 'var(--ink)' }}>Community not available</h2>
          <p className="text-sm mt-2" style={{ color: 'var(--mute)' }}>
            Your gym hasn't enabled the community feature yet.
          </p>
        </div>
        {toast && <Toast message={toast} />}
      </div>
    );
  }

  // Not a member yet — show join prompt
  if (!isMember) {
    return (
      <div className="space-y-4 pb-28">
        <div className="card p-8 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl border grid place-items-center mb-4"
               style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
            <Icon name="trending" size={28} style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="font-grotesk font-bold text-xl" style={{ color: 'var(--ink)' }}>
            Join {gym?.name || 'your gym'}'s community
          </h2>
          <p className="text-sm mt-2 max-w-xs mx-auto" style={{ color: 'var(--mute)' }}>
            See leaderboards, compare progress, and share workouts with your gym friends.
            You control what's visible — participation is always optional.
          </p>
          <div className="mt-6 space-y-3">
            <button className="btn-primary btn-lg btn-block" onClick={toggleMembership}>
              Join Community
            </button>
            <button className="btn w-full" onClick={() => nav(-1)}>Maybe later</button>
          </div>
        </div>
        {toast && <Toast message={toast} />}
      </div>
    );
  }

  // ---- Member view ----
  const lb = lbFetch.data?.leaderboards || { streak: [], volume: [], completedWorkouts: [] };

  const loadMore = async () => {
    if (moreLoading || !hasMore) return;   // no double-fire, no request past the end
    const seq = feedSeq.current;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const res = await api(`/community/feed?limit=${FEED_PAGE_SIZE}&offset=${shares.length}`);
      if (seq !== feedSeq.current) return; // page 1 reloaded underneath us — drop it
      setExtraShares((prev) => prev.concat(res.shares || []));
      setHasMore(!!res.hasMore);
    } catch (e) {
      if (seq !== feedSeq.current) return;
      setMoreError(e);
    } finally {
      if (seq === feedSeq.current) setMoreLoading(false);
    }
  };
  const periods = [
    { value: 'day', label: 'Today' },
    { value: 'week', label: 'This Week' },
    { value: 'month', label: 'This Month' },
  ];

  return (
    <div className="space-y-5 pb-28">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-grotesk font-bold text-xl" style={{ color: 'var(--ink)' }}>
            {gym?.name || 'Community'}
          </h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--mute)' }}>
            Member leaderboards &amp; workout sharing
          </p>
        </div>
        <button className="btn btn-sm" onClick={toggleMembership}>Leave</button>
      </div>

      {/* Period tabs */}
      <div className="flex gap-1.5 border rounded-full p-1 overflow-x-auto"
           style={{ background: 'rgba(128,128,128,.06)', borderColor: 'var(--line)' }}>
        {periods.map(p => (
          <button key={p.value}
            className={`flex-1 text-center py-2 px-3 rounded-full text-xs font-grotesk font-semibold transition-all
              ${period === p.value
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'text-[var(--mute)] hover:text-[var(--ink)]'}`}
            onClick={() => setPeriod(p.value)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* ---- LEADERBOARDS ---- */}
      {lbFetch.loading ? (
        <Skeleton lines={6} />
      ) : lbFetch.error ? (
        <div className="card p-4 text-center">
          <p className="text-xs mb-2" style={{ color: 'var(--faint)' }}>Could not load leaderboards</p>
          <button className="btn btn-sm" onClick={lbFetch.reload}>Retry</button>
        </div>
      ) : (
        <>
          <LeaderboardSection
            title="Top Streaks"
            subtitle="Consecutive training days"
            entries={lb.streak}
            valueLabel={(v) => v === 1 ? '1 day' : `${v} days`}
          />
          <LeaderboardSection
            title="Workout Volume"
            subtitle="Total weight lifted (kg)"
            entries={lb.volume}
            valueLabel={(v) => `${Number(v).toLocaleString()} kg`}
          />
          <LeaderboardSection
            title="Most Workouts"
            subtitle="Sessions completed"
            entries={lb.completedWorkouts}
            valueLabel={(v) => v === 1 ? '1 workout' : `${v} workouts`}
          />
        </>
      )}

      {/* ---- COMMUNITY ACTIVITY ---- */}
      <div>
        <div className="text-[10px] uppercase tracking-[.14em] font-grotesk font-semibold mb-3"
             style={{ color: 'var(--mute)' }}>
          Community Activity
        </div>
        {feedFetch.loading ? (
          <Skeleton lines={3} />
        ) : feedFetch.error ? (
          <div className="card p-4 text-center">
            <p className="text-xs mb-2" style={{ color: 'var(--faint)' }}>Could not load activity feed</p>
            <button className="btn btn-sm" onClick={feedFetch.reload}>Retry</button>
          </div>
        ) : shares.length === 0 ? (
          <Empty title="No shared workouts yet" hint="Complete a workout and share it with your gym friends!" icon="trending" />
        ) : (
          <div className="space-y-3">
            {shares.map(share => (
              <div key={share.id} className="card p-4">
                <div className="flex items-center gap-3 mb-2">
                  <Avatar name={share.authorName} size="w-8 h-8" />
                  <div className="flex-1 min-w-0">
                    <div className="font-grotesk text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>
                      {share.authorName}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                      {share.workoutName} · {new Date(share.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                </div>

                {/* Exercise preview */}
                <div className="space-y-1 mb-3">
                  {(share.payload || []).slice(0, 4).map((ex, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span style={{ color: 'var(--ink)' }}>{ex.name}</span>
                      <span style={{ color: 'var(--mute)' }}>{ex.sets} × {ex.reps} · {ex.weight}</span>
                    </div>
                  ))}
                  {(share.payload || []).length > 4 && (
                    <div className="text-[10px]" style={{ color: 'var(--faint)' }}>
                      +{share.payload.length - 4} more exercises
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button className="btn-primary btn-sm flex-1"
                    onClick={() => openCopy(share)}>
                    Copy Workout
                  </button>
                  {share.clientId === membership?.client_id && (
                    <button className="btn btn-sm"
                      onClick={() => unshare(share.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Pagination: load-more, its own error, and an explicit end. */}
            {moreError ? (
              <div className="card p-4 text-center">
                <p className="text-xs mb-2" style={{ color: 'var(--faint)' }}>Could not load more activity</p>
                <button className="btn btn-sm" onClick={loadMore}>Retry</button>
              </div>
            ) : hasMore ? (
              <button
                className="btn btn-sm btn-block"
                onClick={loadMore}
                disabled={moreLoading}
                aria-busy={moreLoading}>
                {moreLoading ? 'Loading…' : 'Load more'}
              </button>
            ) : (
              <p className="text-center text-[10px] py-1" style={{ color: 'var(--faint)' }}>
                You&rsquo;re all caught up
              </p>
            )}
          </div>
        )}
      </div>

      {/* Copy modal */}
      {copyModal && (
        <div className="fixed inset-0 z-50 bg-[var(--bg)]/80 backdrop-blur-sm flex items-center justify-center p-4"
             onClick={() => setCopyModal(null)}>
          <div className="card w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
               onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between"
                 style={{ borderColor: 'var(--line)' }}>
              <div>
                <div className="font-grotesk font-bold">Copy Workout</div>
                <div className="text-[10px]" style={{ color: 'var(--mute)' }}>Edit and add to your library</div>
              </div>
              <button className="text-lg" style={{ color: 'var(--mute)' }} onClick={() => setCopyModal(null)}><XIcon /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <input className="input" placeholder="Workout name" value={copyForm.name}
                onChange={e => setCopyForm(f => ({ ...f, name: e.target.value }))} />
              {copyForm.exercises.map((ex, i) => (
                <div key={i} className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
                  <div className="font-grotesk text-[13px] font-semibold mb-2" style={{ color: 'var(--ink)' }}>
                    {i + 1}. {ex.name}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Sets</label>
                      <input type="number" className="input !py-1 !text-xs" value={ex.sets}
                        onChange={e => setCopyForm(f => ({
                          ...f,
                          exercises: f.exercises.map((x, j) => j === i ? { ...x, sets: parseInt(e.target.value) || 3 } : x),
                        }))} />
                    </div>
                    <div>
                      <label className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Reps</label>
                      <input className="input !py-1 !text-xs" value={ex.reps}
                        onChange={e => setCopyForm(f => ({
                          ...f,
                          exercises: f.exercises.map((x, j) => j === i ? { ...x, reps: e.target.value } : x),
                        }))} />
                    </div>
                    <div>
                      <label className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>Weight</label>
                      <input className="input !py-1 !text-xs" value={ex.weight}
                        onChange={e => setCopyForm(f => ({
                          ...f,
                          exercises: f.exercises.map((x, j) => j === i ? { ...x, weight: e.target.value } : x),
                        }))} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t" style={{ borderColor: 'var(--line)' }}>
              <button className="btn-primary w-full"
                disabled={copying || !copyForm.name.trim() || !copyForm.exercises.length}
                onClick={doCopy}>
                {copying ? 'Copying…' : 'Add to My Workouts'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast} />}
    </div>
  );
}

// ---- Leaderboard section component ----

function LeaderboardSection({ title, subtitle, entries, valueLabel }) {
  if (!entries || entries.length === 0) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-[.14em] font-grotesk font-semibold mb-2"
             style={{ color: 'var(--mute)' }}>{title}</div>
        <div className="card p-4 text-center text-xs" style={{ color: 'var(--faint)' }}>
          No data yet
        </div>
      </div>
    );
  }

  const top3 = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-[10px] uppercase tracking-[.14em] font-grotesk font-semibold"
               style={{ color: 'var(--mute)' }}>{title}</div>
          {subtitle && <div className="text-[9px] mt-0.5" style={{ color: 'var(--faint)' }}>{subtitle}</div>}
        </div>
      </div>

      {/* Top 3 podium */}
      {top3.length > 0 && (
        <div className="card p-4 mb-2">
          <div className="flex items-end justify-center gap-4">
            {/* 2nd place (left) */}
            {top3[1] && <PodiumSpot entry={top3[1]} medal={1} />}
            {/* 1st place (center, tallest) */}
            {top3[0] && <PodiumSpot entry={top3[0]} medal={0} tall />}
            {/* 3rd place (right) */}
            {top3[2] && <PodiumSpot entry={top3[2]} medal={2} />}
          </div>
        </div>
      )}

      {/* Rest of list */}
      {rest.map((entry, i) => (
        <div key={entry.clientId}
          className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0"
          style={{ borderColor: 'var(--line)' }}>
          <span className="text-xs font-grotesk w-6 text-center" style={{ color: 'var(--faint)' }}>
            {entry.rank}
          </span>
          <Avatar name={entry.name} size="w-7 h-7" />
          <span className="flex-1 min-w-0 font-grotesk text-sm font-semibold truncate"
                style={{ color: 'var(--ink)' }}>{entry.name}</span>
          <span className="text-xs font-grotesk tabular-nums" style={{ color: 'var(--mute)' }}>
            {valueLabel(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function PodiumSpot({ entry, medal, tall }) {
  const heights = tall ? 'h-20' : medal === 1 ? 'h-16' : 'h-14';
  return (
    // min-w-0 is load-bearing: a flex item defaults to min-width:auto, which
    // refuses to shrink below its content, so a long member name widened this
    // column past the card and `truncate` never engaged (a 51-character name
    // pushed the page from 375px to 499px on a phone). users.name allows up
    // to 80 characters, so this is reachable with a real display name. Same
    // min-w-0 + truncate pairing the rest-of-list rows above already use.
    <div className="flex flex-col items-center gap-1.5 min-w-0" style={{ flex: 1 }}>
      <div className="text-2xl">{MEDAL[medal]}</div>
      <Avatar name={entry.name} size={tall ? 'w-11 h-11' : 'w-9 h-9'} />
      <div className="font-grotesk text-[11px] font-semibold text-center truncate max-w-full w-full"
           style={{ color: 'var(--ink)' }}>{entry.name}</div>
      <div className="font-grotesk text-xs font-bold tabular-nums truncate max-w-full w-full text-center"
           style={{ color: MEDAL_TONE[medal] }}>{entry.value}</div>
      <div className={`w-full rounded-t-lg ${heights}`}
           style={{ background: `linear-gradient(to top, ${MEDAL_TONE[medal]}22, transparent)` }} />
    </div>
  );
}
