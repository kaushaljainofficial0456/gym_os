/**
 * AN INVITATION — /invite/:code
 *
 * PUBLIC on purpose. An invite link is usually opened on a phone that is not
 * signed in, and a link that demands a login before it will say what it is
 * for is a link people do not follow.
 *
 * What it shows without a session is deliberately thin: the community's name,
 * colour and size. No member names, no inviter, no id. Everything else waits
 * until someone is signed in, and joining is always an explicit tap.
 *
 * Every way a code can fail gets its own sentence, because "invalid" tells
 * the person holding it nothing about what to do next.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, getStoredUser, setReturnTo } from '../../api.js';
import { IdentityMark } from '../../components/community/identity.jsx';
import Logo from '../../components/Logo.jsx';

const STATE_COPY = {
  expired: ['This invitation has expired', 'Ask whoever sent it for a fresh code — they can make one in seconds.'],
  revoked: ['This invitation was turned off', 'Ask whoever sent it for a new code.'],
  used_up: ['This invitation has been used up', 'It was set to a limited number of uses. Ask for a new one.'],
  invalid: ['We could not find that invitation', 'Check the code or the link — it may have been mistyped.'],
};

export default function CommunityInvite() {
  const { code } = useParams();
  const nav = useNavigate();
  const authed = !!getStoredUser();

  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    // Signed in, the authenticated preview also says whether you are already
    // a member; signed out, the public one says only what the card needs.
    const path = authed ? `/communities/join/${encodeURIComponent(code)}` : `/community-invite/${encodeURIComponent(code)}`;
    api(path)
      .then((res) => { if (alive) setPreview(res); })
      .catch((e) => { if (alive) setError(e.message || 'Could not open this invitation'); });
    return () => { alive = false; };
  }, [code, authed]);

  const join = async () => {
    setBusy(true); setError('');
    try {
      const res = await api('/communities/join', { method: 'POST', body: JSON.stringify({ code }) });
      nav(`/app/client/community/c/${res.communityId}`);
    } catch (e) {
      setError(e.message || 'Could not join with this invitation');
      setBusy(false);
    }
  };

  const signIn = () => {
    setReturnTo(`/invite/${code}`);
    nav('/login');
  };

  const state = preview?.state;
  const community = preview?.community;
  const failed = state && state !== 'valid';
  const [failTitle, failBody] = STATE_COPY[state] || STATE_COPY.invalid;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-5 py-10" style={{ background: 'var(--bg)' }}>
      <div className="flex items-center gap-2 mb-6">
        <Logo alt="" aria-hidden="true" className="w-7 h-7 rounded-lg object-cover" />
        <span className="font-brand text-[13px] font-bold" style={{ color: 'var(--ink)', letterSpacing: '.02em' }}>Barbell</span>
      </div>

      <div
        className="w-full max-w-sm rounded-3xl p-6 text-center"
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--e-3)' }}
      >
        {!preview && !error && (
          <div className="text-[12.5px] py-8" style={{ color: 'var(--mute)' }}>Opening your invitation…</div>
        )}

        {preview && !failed && community && (
          <>
            <div className="text-[10.5px] uppercase tracking-[.18em] mb-4" style={{ color: 'var(--faint)' }}>
              You&apos;ve been invited
            </div>
            <div className="flex justify-center mb-4">
              <IdentityMark name={community.name} theme={community.theme} mark={community.mark} size={72} />
            </div>
            <h1 className="font-black leading-tight" style={{ fontSize: 24, color: 'var(--ink)' }}>{community.name}</h1>
            <div className="text-[12px] mt-1.5" style={{ color: 'var(--mute)' }}>
              {community.memberCount} {community.memberCount === 1 ? 'member' : 'members'} · Private community
            </div>
            <p className="text-[12.5px] mt-4 leading-relaxed" style={{ color: 'var(--mute)' }}>
              Train together. Compete together. Share the sessions you want to share — and nothing else.
            </p>

            {!authed ? (
              <>
                <button
                  type="button"
                  onClick={signIn}
                  className="w-full mt-6 rounded-xl font-semibold text-[13px]"
                  style={{ minHeight: 48, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  Sign in to join
                </button>
                <p className="text-[11px] mt-3" style={{ color: 'var(--faint)' }}>
                  You will come straight back here after signing in.
                </p>
              </>
            ) : preview.alreadyMember ? (
              <button
                type="button"
                onClick={() => nav(`/app/client/community/c/${preview.communityId}`)}
                className="w-full mt-6 rounded-xl font-semibold text-[13px]"
                style={{ minHeight: 48, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                You are already in — open it
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={join}
                  disabled={busy}
                  className="w-full mt-6 rounded-xl font-semibold text-[13px]"
                  style={{ minHeight: 48, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  {busy ? 'Joining…' : 'Join community'}
                </button>
                <p className="text-[10.5px] mt-3 leading-relaxed" style={{ color: 'var(--faint)' }}>
                  Members see your workout count, active days, volume, streak and number of personal
                  records. Individual workouts and records are shared only when you choose to.
                  Sleep, recovery, body weight and nutrition are never shared.
                </p>
              </>
            )}
          </>
        )}

        {(failed || error) && (
          <>
            <div className="mx-auto mb-4 grid place-items-center rounded-2xl"
              style={{ width: 56, height: 56, background: 'var(--panel2)', border: '1px solid var(--line)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--mute)" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
            </div>
            <h1 className="font-bold text-[17px]" style={{ color: 'var(--ink)' }}>
              {failed ? failTitle : 'Something went wrong'}
            </h1>
            <p className="text-[12.5px] mt-2 leading-relaxed" style={{ color: 'var(--mute)' }}>
              {failed ? failBody : error}
            </p>
            <button
              type="button"
              onClick={() => nav(authed ? '/app/client/community' : '/login')}
              className="w-full mt-5 rounded-xl font-semibold text-[13px]"
              style={{ minHeight: 46, border: '1px solid var(--line)', color: 'var(--ink)' }}
            >
              {authed ? 'Go to Community' : 'Sign in'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
