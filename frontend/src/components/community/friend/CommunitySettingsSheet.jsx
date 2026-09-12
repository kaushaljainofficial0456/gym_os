/**
 * COMMUNITY SETTINGS — what you share, and (if it is yours) what it is.
 *
 * The sharing controls come FIRST, and they are the same three facts that
 * were disclosed at the moment of joining. Privacy that lives three taps
 * deeper than the thing it governs is privacy nobody finds.
 *
 * Only controls the viewer can actually use are rendered, and every one of
 * them is re-checked on the server: a member never sees a Delete button that
 * would fail, and never gets one by editing the page.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../UI.jsx';
import { IdentityMark, THEME_KEYS, themeOf } from '../identity.jsx';

const MARKS = ['🔥', '⚡', '💪', '🏋️', '🏃', '🚴', '🥇', '🎯', '⛰️', '🌅'];

export default function CommunitySettingsSheet({ community, members = [], onClose, onChanged, onGone, toast }) {
  const you = community.you;
  const can = you?.permissions || {};
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description || '');
  const [theme, setTheme] = useState(community.theme);
  const [mark, setMark] = useState(community.mark);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);       // 'leave' | 'delete' | 'transfer'
  const [typedName, setTypedName] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [err, setErr] = useState('');

  const dirty = can.edit && (
    name.trim() !== community.name
    || (description.trim() || '') !== (community.description || '')
    || theme !== community.theme
    || (mark || null) !== (community.mark || null)
  );

  const setMine = async (patch, message) => {
    try {
      await api(`/communities/${community.id}/me`, { method: 'PATCH', body: JSON.stringify(patch) });
      toast?.(message);
      onChanged?.();
    } catch (e) {
      toast?.(e.message || 'Could not change that');
    }
  };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      await api(`/communities/${community.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, theme, mark }),
      });
      toast?.('Community updated');
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not save those changes');
    }
    setSaving(false);
  };

  const leave = async () => {
    try {
      const res = await api(`/communities/${community.id}/leave`, { method: 'POST' });
      toast?.(res.deleted ? `${community.name} was deleted` : `You left ${community.name}`);
      onGone?.();
    } catch (e) {
      setErr(e.message || 'Could not leave');
      setConfirm(null);
    }
  };

  const remove = async () => {
    try {
      await api(`/communities/${community.id}`, {
        method: 'DELETE', body: JSON.stringify({ confirm_name: typedName }),
      });
      toast?.(`${community.name} was deleted`);
      onGone?.();
    } catch (e) {
      setErr(e.message || 'Could not delete this community');
    }
  };

  const transfer = async () => {
    try {
      await api(`/communities/${community.id}/transfer`, {
        method: 'POST', body: JSON.stringify({ client_id: transferTo }),
      });
      toast?.('Ownership handed over');
      setConfirm(null);
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not hand over ownership');
    }
  };

  const others = members.filter((m) => !m.isYou);

  return (
    <Modal
      open
      onClose={onClose}
      title="Community settings"
      sub={community.name}
      footer={dirty ? (
        <button
          type="button"
          onClick={save}
          disabled={saving || name.trim().length < 2}
          className="w-full rounded-xl font-semibold text-[13px]"
          style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      ) : null}
    >
      {/* ── what you share ── */}
      <Section title="What you share here">
        <Switch
          on={you.shareStats}
          label="Training stats"
          hint="Your workout count, active days, volume, streak and number of records appear on this community's boards and totals."
          onChange={(next) => setMine({ share_stats: next }, next ? 'Your stats are shared here' : 'Your stats are hidden here')}
        />
        <Switch
          on={you.showGym}
          label="Show my gym"
          hint="Shows which gym you train at beside your name in this community."
          onChange={(next) => setMine({ show_gym: next }, next ? 'Your gym is shown' : 'Your gym is hidden')}
        />
        <Switch
          on={you.muted}
          label="Mute notifications"
          hint="Stops reactions, comments and new challenges from this community reaching your notifications."
          onChange={(next) => setMine({ muted: next }, next ? 'Muted' : 'Unmuted')}
        />
        <p className="text-[10.5px] leading-relaxed mt-2" style={{ color: 'var(--faint)' }}>
          Individual workouts and records are only ever shared when you choose to share them.
          Sleep, recovery, body weight and nutrition are never shared with any community.
        </p>
      </Section>

      {/* ── identity (owner) ── */}
      {can.edit && (
        <Section title="Identity">
          <div
            className="rounded-2xl p-3 flex items-center gap-3 mb-3"
            style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}
          >
            <IdentityMark name={name} theme={theme} mark={mark} size={44} />
            <div className="min-w-0 text-[13px] font-bold truncate" style={{ color: 'var(--ink)' }}>{name || community.name}</div>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 50))}
            aria-label="Community name"
            className="w-full rounded-xl px-3 text-[13px] mb-2"
            style={{ minHeight: 44, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 160))}
            placeholder="Description (optional)"
            aria-label="Community description"
            className="w-full rounded-xl px-3 text-[12.5px] mb-3"
            style={{ minHeight: 42, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
          />
          <div className="flex gap-2 flex-wrap mb-3" role="radiogroup" aria-label="Community colour">
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
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: `linear-gradient(135deg, color-mix(in srgb, ${t.fg} 60%, transparent), color-mix(in srgb, ${t.fg} 18%, transparent))`,
                    border: `2px solid ${on ? t.fg : 'transparent'}`,
                  }}
                />
              );
            })}
          </div>
          <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="Community mark">
            <MarkButton on={!mark} onClick={() => setMark(null)}><span className="text-[11px] font-bold" style={{ color: 'var(--mute)' }}>Aa</span></MarkButton>
            {MARKS.map((m) => (
              <MarkButton key={m} on={mark === m} onClick={() => setMark(m)}><span className="text-[16px]">{m}</span></MarkButton>
            ))}
          </div>
        </Section>
      )}

      {/* ── ending things ── */}
      <Section title={can.delete ? 'Owner controls' : 'Leaving'}>
        {can.transfer && others.length > 0 && (
          confirm === 'transfer' ? (
            <div className="rounded-xl p-3 mb-2" style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}>
              <div className="text-[12px] mb-2" style={{ color: 'var(--ink)' }}>Who should own {community.name}?</div>
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                aria-label="New owner"
                className="w-full rounded-xl px-3 text-[12.5px] mb-2"
                style={{ minHeight: 44, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
              >
                <option value="">Choose a member…</option>
                {others.map((m) => <option key={m.clientId} value={m.clientId}>{m.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <GhostButton onClick={() => setConfirm(null)}>Cancel</GhostButton>
                <DangerButton onClick={transfer} disabled={!transferTo}>Hand over</DangerButton>
              </div>
            </div>
          ) : (
            <RowButton onClick={() => setConfirm('transfer')}>Make someone else the owner</RowButton>
          )
        )}

        {confirm === 'leave' ? (
          <Confirm
            title={`Leave ${community.name}?`}
            body="You will stop seeing this community's activity, boards and challenges, and the workouts you shared here will be removed from it. Your own training history is not affected."
            cancel={() => setConfirm(null)}
            confirm={leave}
            confirmLabel="Leave"
          />
        ) : (
          <RowButton onClick={() => setConfirm('leave')} danger>Leave community</RowButton>
        )}

        {can.delete && (
          confirm === 'delete' ? (
            <div className="rounded-xl p-3 mt-2" style={{ background: 'rgb(var(--bad-rgb) / .08)', border: '1px solid rgb(var(--bad-rgb) / .4)' }}>
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>Delete {community.name}?</div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>
                This removes the community, its members, its posts and its challenges for everyone.
                Nobody&apos;s workouts, records or profiles are touched. It cannot be undone.
              </p>
              <input
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={`Type "${community.name}" to confirm`}
                aria-label="Type the community name to confirm"
                className="w-full rounded-xl px-3 text-[12.5px] mt-2.5"
                style={{ minHeight: 44, background: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' }}
              />
              <div className="grid grid-cols-2 gap-2 mt-2">
                <GhostButton onClick={() => { setConfirm(null); setTypedName(''); }}>Cancel</GhostButton>
                <DangerButton
                  onClick={remove}
                  disabled={typedName.trim().toLowerCase() !== community.name.trim().toLowerCase()}
                >
                  Delete
                </DangerButton>
              </div>
            </div>
          ) : (
            <RowButton onClick={() => setConfirm('delete')} danger>Delete community</RowButton>
          )
        )}
      </Section>

      {err && <div className="text-[12px]" style={{ color: 'var(--bad)' }}>{err}</div>}
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-5">
      <h3 className="text-[11px] font-bold uppercase tracking-[.14em] mb-2" style={{ color: 'var(--mute)' }}>{title}</h3>
      {children}
    </section>
  );
}

function Switch({ on, label, hint, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="w-full flex items-start gap-3 rounded-xl px-3 py-3 text-left mb-1.5"
      style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>{label}</span>
        <span className="block text-[10.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--mute)' }}>{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full transition-colors"
        style={{
          width: 40, height: 24, marginTop: 2,
          background: on ? 'var(--accent)' : 'var(--line)',
          position: 'relative',
        }}
      >
        <span
          className="absolute rounded-full transition-all"
          style={{
            width: 18, height: 18, top: 3, left: on ? 19 : 3,
            background: on ? 'var(--accent-contrast)' : 'var(--mute)',
          }}
        />
      </span>
    </button>
  );
}

function RowButton({ children, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl px-3 text-left text-[12.5px] font-semibold mt-1.5"
      style={{
        minHeight: 46,
        background: 'var(--panel2)',
        border: '1px solid var(--line)',
        color: danger ? 'rgb(var(--bad-rgb))' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );
}

function Confirm({ title, body, cancel, confirm, confirmLabel }) {
  return (
    <div className="rounded-xl p-3 mt-1.5" style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}>
      <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</div>
      <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--mute)' }}>{body}</p>
      <div className="grid grid-cols-2 gap-2 mt-2.5">
        <GhostButton onClick={cancel}>Cancel</GhostButton>
        <DangerButton onClick={confirm}>{confirmLabel}</DangerButton>
      </div>
    </div>
  );
}

function GhostButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl text-[12.5px] font-semibold"
      style={{ minHeight: 44, border: '1px solid var(--line)', color: 'var(--mute)' }}>
      {children}
    </button>
  );
}

function DangerButton({ children, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-xl text-[12.5px] font-semibold"
      style={{
        minHeight: 44,
        background: disabled ? 'var(--line)' : 'rgb(var(--bad-rgb))',
        color: disabled ? 'var(--mute)' : '#fff',
      }}>
      {children}
    </button>
  );
}

function MarkButton({ on, onClick, children }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className="rounded-xl grid place-items-center"
      style={{
        width: 38, height: 38,
        background: on ? 'var(--accent-soft)' : 'var(--panel2)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
      }}
    >
      {children}
    </button>
  );
}
