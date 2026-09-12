/**
 * JOIN WITH A CODE.
 *
 * The code is checked BEFORE joining, so the answer to "what am I about to
 * join?" arrives before the decision, not after it. Every way a code can fail
 * — wrong, expired, turned off, fully used, already yours, or a group you
 * were removed from — gets its own sentence, because "invalid code" tells
 * someone nothing about what to do next.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';
import { IdentityMark } from '../identity.jsx';

const CODE_LENGTH = 8;

/** Accept what people paste: lowercase, spaces, dashes, the whole link. */
export function normalizeTyped(raw) {
  const fromLink = String(raw || '').split('/').pop();
  return fromLink.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}
const display = (normalized) => (normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized);

const STATE_MESSAGE = {
  invalid: 'We could not find that code. Check it and try again.',
  expired: 'That code has expired. Ask for a new one.',
  revoked: 'That code was turned off. Ask for a new one.',
  used_up: 'That code has been used as many times as it was meant to be. Ask for a new one.',
};

export default function JoinWithCodeSheet({ onClose, onJoined, toast }) {
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const normalized = normalizeTyped(typed);
  const ready = normalized.length === CODE_LENGTH;

  const check = async () => {
    setBusy(true); setErr(''); setPreview(null);
    try {
      const res = await api(`/communities/join/${display(normalized)}`);
      if (res.state !== 'valid') {
        setErr(STATE_MESSAGE[res.state] || STATE_MESSAGE.invalid);
      } else {
        setPreview(res);
      }
    } catch (e) {
      setErr(e.message || 'Could not check that code');
    }
    setBusy(false);
  };

  const join = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api('/communities/join', { method: 'POST', body: JSON.stringify({ code: display(normalized) }) });
      toast?.(res.already ? `You are already in ${preview.community.name}` : `Welcome to ${preview.community.name}`);
      onJoined(res.communityId);
    } catch (e) {
      setErr(e.message || 'Could not join with that code');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Join a community"
      sub="Enter the code a friend sent you"
      footer={preview ? (
        <button
          type="button"
          onClick={preview.alreadyMember ? () => onJoined(preview.communityId) : join}
          disabled={busy}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          {preview.alreadyMember ? `Open ${preview.community.name}` : busy ? 'Joining…' : `Join ${preview.community.name}`}
        </button>
      ) : (
        <button
          type="button"
          onClick={check}
          disabled={!ready || busy}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{
            minHeight: 46,
            background: ready ? 'var(--accent)' : 'var(--line)',
            color: ready ? 'var(--accent-contrast)' : 'var(--mute)',
          }}
        >
          {busy ? 'Checking…' : 'Check code'}
        </button>
      )}
    >
      <input
        value={display(normalized)}
        onChange={(e) => { setTyped(e.target.value); setPreview(null); setErr(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && ready && !preview) check(); }}
        placeholder="ABCD-1234"
        aria-label="Invite code"
        autoFocus
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className="w-full rounded-xl px-3 text-center font-black tabular-nums"
        style={{
          minHeight: 56,
          fontSize: 22,
          letterSpacing: '.16em',
          background: 'var(--panel2)',
          border: '1px solid var(--line)',
          color: 'var(--ink)',
        }}
      />

      {preview && (
        <div
          className="mt-4 rounded-2xl p-4 flex items-center gap-3.5 anim-fadeIn"
          style={{ background: 'var(--panel2)', border: '1px solid var(--accent)' }}
        >
          <IdentityMark name={preview.community.name} theme={preview.community.theme} mark={preview.community.mark} size={48} />
          <div className="min-w-0">
            <div className="font-bold text-[15px] truncate" style={{ color: 'var(--ink)' }}>{preview.community.name}</div>
            <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>
              {preview.community.memberCount} {preview.community.memberCount === 1 ? 'member' : 'members'} · Private
            </div>
            {preview.alreadyMember && (
              <div className="text-[11.5px] mt-1" style={{ color: 'var(--accent)' }}>You are already in this one.</div>
            )}
          </div>
        </div>
      )}

      {preview && !preview.alreadyMember && (
        <p className="text-[10.5px] mt-3 leading-relaxed" style={{ color: 'var(--faint)' }}>
          Joining shares your workout count, active days, training volume, streak and number of personal
          records with this community. Individual workouts and records are shared only when you choose to.
          Sleep, recovery, body weight and nutrition are never shared.
        </p>
      )}

      {err && <div className="text-[12px] mt-3 leading-relaxed" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}
