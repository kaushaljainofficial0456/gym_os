/**
 * CREATE A COMMUNITY — two steps, and the second one is the point.
 *
 * Naming it takes ten seconds; a community with one member in it is not yet
 * a community. So creating drops straight into inviting, with the code
 * already available to share, rather than leaving someone on an empty
 * dashboard to work out what to do next.
 *
 * The identity is chosen here and previewed live, because a group that looks
 * like itself from the first screen is one people come back to.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';
import { IdentityMark, THEME_KEYS, themeOf } from '../identity.jsx';
import InvitePanel from './InvitePanel.jsx';

// Kept in step with the server's own allow-list (friendCommunities/core.js).
const MARKS = ['🔥', '⚡', '💪', '🏋️', '🏃', '🚴', '🥇', '🎯', '⛰️', '🌅'];
const NAME_MAX = 40;
const DESCRIPTION_MAX = 160;

export default function CreateCommunitySheet({ onClose, onCreated, toast }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [theme, setTheme] = useState('ember');
  const [mark, setMark] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);

  const tone = themeOf(theme).fg;
  const trimmed = name.trim();

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api('/communities', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, description: description.trim() || null, theme, mark }),
      });
      setCreated({ id: res.id, name: trimmed });
    } catch (e) {
      setErr(e.message || 'Could not create that community');
    }
    setBusy(false);
  };

  if (created) {
    return (
      <Modal
        open
        onClose={() => onCreated(created.id)}
        title={created.name}
        sub="Now bring your people in"
        footer={(
          <button
            type="button"
            onClick={() => onCreated(created.id)}
            className="w-full rounded-xl font-semibold text-[13px]"
            style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Open {created.name}
          </button>
        )}
      >
        <InvitePanel communityId={created.id} communityName={created.name} onToast={toast} />
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a community"
      sub="Private, invite only"
      footer={(
        <button
          type="button"
          onClick={create}
          disabled={busy || trimmed.length < 2}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{
            minHeight: 46,
            background: trimmed.length < 2 ? 'var(--line)' : 'var(--accent)',
            color: trimmed.length < 2 ? 'var(--mute)' : 'var(--accent-contrast)',
          }}
        >
          {busy ? 'Creating…' : 'Create community'}
        </button>
      )}
    >
      {/* Live preview: what the group will look like in everyone's list. */}
      <div
        className="rounded-2xl p-3.5 flex items-center gap-3.5 mb-4"
        style={{ background: 'var(--panel2)', border: `1px solid color-mix(in srgb, ${tone} 30%, var(--line))` }}
      >
        <IdentityMark name={trimmed || 'Your community'} theme={theme} mark={mark} size={48} />
        <div className="min-w-0">
          <div className="font-bold text-[14px] truncate" style={{ color: 'var(--ink)' }}>
            {trimmed || 'Your community'}
          </div>
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--mute)' }}>Private · 1 member</div>
        </div>
      </div>

      <Field label="Name" hint={`${[...trimmed].length}/${NAME_MAX}`}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, NAME_MAX + 10))}
          placeholder="Beast Squad"
          aria-label="Community name"
          autoFocus
          className="w-full rounded-xl px-3 text-[13px]"
          style={{ minHeight: 46, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
        />
      </Field>

      <Field label="Description" hint="Optional">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
          placeholder="Train hard. Stay consistent."
          aria-label="Community description"
          className="w-full rounded-xl px-3 text-[12.5px]"
          style={{ minHeight: 44, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
        />
      </Field>

      <Field label="Colour">
        <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Community colour">
          {THEME_KEYS.map((key) => {
            const t = themeOf(key);
            const on = key === theme;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={t.label}
                onClick={() => setTheme(key)}
                className="rounded-xl transition-transform active:scale-95"
                style={{
                  width: 44,
                  height: 44,
                  background: `linear-gradient(135deg, color-mix(in srgb, ${t.fg} 60%, transparent), color-mix(in srgb, ${t.fg} 18%, transparent))`,
                  border: `2px solid ${on ? t.fg : 'transparent'}`,
                  boxShadow: on ? `0 0 0 3px color-mix(in srgb, ${t.fg} 18%, transparent)` : 'none',
                }}
              />
            );
          })}
        </div>
      </Field>

      <Field label="Mark" hint="Optional — initials are used otherwise">
        <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="Community mark">
          <MarkButton on={mark === null} onClick={() => setMark(null)}>
            <span className="text-[11px] font-bold" style={{ color: 'var(--mute)' }}>Aa</span>
          </MarkButton>
          {MARKS.map((m) => (
            <MarkButton key={m} on={mark === m} onClick={() => setMark(m)}>
              <span className="text-[17px]" aria-hidden="true">{m}</span>
            </MarkButton>
          ))}
        </div>
      </Field>

      <p className="text-[11px] leading-relaxed mt-1" style={{ color: 'var(--faint)' }}>
        Only people you invite can see this community. Your workouts and records stay private until
        you choose to share them, and health data is never shared.
      </p>

      {err && <div className="text-[12px] mt-3" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-[.13em]" style={{ color: 'var(--mute)' }}>{label}</span>
        {hint && <span className="text-[10.5px] tabular-nums" style={{ color: 'var(--faint)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function MarkButton({ on, onClick, children }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className="rounded-xl grid place-items-center transition-transform active:scale-95"
      style={{
        width: 42,
        height: 42,
        background: on ? 'var(--accent-soft)' : 'var(--panel2)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
      }}
    >
      {children}
    </button>
  );
}
