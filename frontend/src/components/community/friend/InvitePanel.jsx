/**
 * INVITING PEOPLE — the two ways in, in one panel.
 *
 *   A CODE, for anyone. Friends at other gyms, or at no gym, cannot be
 *   searched for (see below), so the code — and the link and QR that carry
 *   it — is how they get in. It is shown ONCE, because the server keeps only
 *   a keyed hash of it; if it is lost, make another. Several can be live at
 *   once, so handing a new code to a late friend never breaks the one that
 *   was sent last week.
 *
 *   A DIRECT INVITE, for people you already train with. The search can only
 *   find members of your own gym community and people already in your other
 *   communities. There is deliberately no way to search every SK OS account:
 *   a private group is not a reason to expose a directory of strangers.
 *
 * Used both in the create flow (step two) and from the community itself, so
 * the invitation experience is the same wherever it starts.
 */
import { useState, useCallback, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../../api.js';

const EXPIRY_LABEL = { 1: '1 day', 7: '7 days', 30: '30 days' };

export default function InvitePanel({ communityId, communityName, onToast, onChanged }) {
  const [invites, setInvites] = useState(null);
  const [fresh, setFresh] = useState(null);          // the code just made, shown once
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [maxUses, setMaxUses] = useState(25);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setInvites(await api(`/communities/${communityId}/invites`));
    } catch (e) {
      setErr(e.message || 'Could not load invitations');
      setInvites({ codes: [], direct: [] });
    }
  }, [communityId]);

  useEffect(() => { load(); }, [load]);

  const makeCode = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api(`/communities/${communityId}/codes`, {
        method: 'POST',
        body: JSON.stringify({ expires_in_days: expiresInDays, max_uses: maxUses }),
      });
      setFresh(res);
      load();
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not create an invite code');
    }
    setBusy(false);
  };

  const link = fresh ? `${window.location.origin}/invite/${fresh.code}` : '';

  const copy = async (what, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      onToast?.('Copying is not available in this browser');
    }
  };

  const shareInvite = async () => {
    const text = `Join ${communityName} on Barbell. Invite code: ${fresh.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Join ${communityName}`, text, url: link });
        return;
      } catch { /* the person closed the share sheet */ }
    }
    copy('link', link);
  };

  // Searching runs against "people you already train with", so it is bounded
  // and cheap; debounced only so a fast typist does not fire one request per
  // keystroke.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setPeople([]); return undefined; }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api(`/communities/${communityId}/candidates?q=${encodeURIComponent(term)}`);
        if (alive) setPeople(res.people || []);
      } catch {
        if (alive) setPeople([]);
      } finally {
        if (alive) setSearching(false);
      }
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, communityId]);

  const invitePerson = async (person) => {
    setBusy(true);
    try {
      await api(`/communities/${communityId}/invites`, {
        method: 'POST', body: JSON.stringify({ client_id: person.clientId }),
      });
      setPeople((prev) => prev.map((p) => (p.clientId === person.clientId ? { ...p, invited: true } : p)));
      onToast?.(`Invitation sent to ${person.name}`);
      load();
      onChanged?.();
    } catch (e) {
      onToast?.(e.message || 'Could not send that invitation');
    }
    setBusy(false);
  };

  const revoke = async (inviteId, label) => {
    try {
      await api(`/communities/${communityId}/invites/${inviteId}`, { method: 'DELETE' });
      onToast?.(label);
      load();
      onChanged?.();
    } catch (e) {
      onToast?.(e.message || 'Could not do that');
    }
  };

  return (
    <div className="space-y-5">
      {/* ── code ── */}
      <section>
        <SectionTitle>Invite with a code</SectionTitle>
        <p className="text-[11.5px] leading-relaxed mb-3" style={{ color: 'var(--mute)' }}>
          Works for anyone on Barbell, including friends at other gyms. Share the code, the link or the QR.
        </p>

        {fresh ? (
          <div className="rounded-2xl p-4" style={{ background: 'var(--panel2)', border: '1px solid var(--accent)' }}>
            <div className="text-[10px] uppercase tracking-[.14em] font-semibold" style={{ color: 'var(--mute)' }}>
              Invite code
            </div>
            <div
              className="font-black tabular-nums mt-1.5 select-all"
              style={{ fontSize: 30, letterSpacing: '.12em', color: 'var(--ink)' }}
            >
              {fresh.code}
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--faint)' }}>
              Up to {fresh.maxUses} {fresh.maxUses === 1 ? 'use' : 'uses'} · expires{' '}
              {new Date(fresh.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </div>

            <div className="flex justify-center my-4">
              <div className="rounded-xl p-3" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                <QRCodeSVG value={link} size={132} bgColor="transparent" fgColor="var(--ink)" />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <SmallButton onClick={() => copy('code', fresh.code)}>{copied === 'code' ? 'Copied' : 'Copy code'}</SmallButton>
              <SmallButton onClick={() => copy('link', link)}>{copied === 'link' ? 'Copied' : 'Copy link'}</SmallButton>
              <SmallButton onClick={shareInvite} primary>Share</SmallButton>
            </div>
            <p className="text-[10.5px] mt-3 leading-relaxed" style={{ color: 'var(--faint)' }}>
              Save it now — for security this code is shown only once. You can always create another,
              and old codes keep working until they expire or you turn them off.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl p-3.5" style={{ background: 'var(--panel2)', border: '1px solid var(--line)' }}>
            <Choice
              label="Expires after"
              options={[1, 7, 30]}
              value={expiresInDays}
              onChange={setExpiresInDays}
              render={(v) => EXPIRY_LABEL[v]}
            />
            <div className="h-3" />
            <Choice
              label="Can be used"
              options={[1, 5, 10, 25, 50]}
              value={maxUses}
              onChange={setMaxUses}
              render={(v) => (v === 1 ? 'once' : `${v}×`)}
            />
            <button
              type="button"
              onClick={makeCode}
              disabled={busy}
              className="w-full mt-3.5 rounded-xl font-semibold text-[12.5px]"
              style={{ minHeight: 46, background: 'var(--accent)', color: 'var(--accent-contrast)' }}
            >
              {busy ? 'Creating…' : 'Create invite code'}
            </button>
          </div>
        )}

        {invites?.codes?.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[10px] uppercase tracking-[.13em]" style={{ color: 'var(--faint)' }}>
              Live codes
            </div>
            {invites.codes.map((c) => (
              <Row key={c.id}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px]" style={{ color: 'var(--ink)' }}>
                    {c.useCount} of {c.maxUses} used
                  </span>
                  <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>
                    {c.yours ? 'Created by you' : `Created by ${c.createdBy || 'an admin'}`} · expires{' '}
                    {new Date(c.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </span>
                </span>
                <RowAction onClick={() => revoke(c.id, 'Code turned off')}>Turn off</RowAction>
              </Row>
            ))}
          </div>
        )}
      </section>

      {/* ── people ── */}
      <section>
        <SectionTitle>Invite people you train with</SectionTitle>
        <p className="text-[11.5px] leading-relaxed mb-2.5" style={{ color: 'var(--mute)' }}>
          Members of your gym community and people from your other communities. Everyone else joins with a code.
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          aria-label="Search people you train with"
          className="w-full rounded-xl px-3 text-[12.5px]"
          style={{ minHeight: 44, background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--ink)' }}
        />
        <div className="mt-2 space-y-1.5">
          {searching && <div className="text-[11.5px] px-1" style={{ color: 'var(--faint)' }}>Searching…</div>}
          {!searching && query.trim().length >= 2 && people.length === 0 && (
            <div className="text-[11.5px] px-1 leading-relaxed" style={{ color: 'var(--mute)' }}>
              Nobody you train with matches “{query.trim()}”. Share an invite code instead.
            </div>
          )}
          {people.map((p) => (
            <Row key={p.clientId}>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{p.name}</span>
                <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--faint)' }}>{p.via}</span>
              </span>
              {p.invited ? (
                <span className="text-[11.5px] shrink-0" style={{ color: 'var(--mute)' }}>Invited</span>
              ) : (
                <RowAction onClick={() => invitePerson(p)} primary disabled={busy}>Invite</RowAction>
              )}
            </Row>
          ))}
        </div>

        {invites?.direct?.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[10px] uppercase tracking-[.13em]" style={{ color: 'var(--faint)' }}>
              Waiting to reply
            </div>
            {invites.direct.map((d) => (
              <Row key={d.id}>
                <span className="min-w-0 flex-1 text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{d.name}</span>
                <RowAction onClick={() => revoke(d.id, `Invitation to ${d.name} withdrawn`)}>Withdraw</RowAction>
              </Row>
            ))}
          </div>
        )}
      </section>

      {err && <div className="text-[11.5px]" style={{ color: 'var(--bad)' }}>{err}</div>}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h3 className="text-[11px] font-bold uppercase tracking-[.14em] mb-1.5" style={{ color: 'var(--mute)' }}>
      {children}
    </h3>
  );
}

function Choice({ label, options, value, onChange, render }) {
  return (
    <div>
      <div className="text-[10.5px] mb-1.5" style={{ color: 'var(--faint)' }}>{label}</div>
      <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const on = option === value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(option)}
              className="rounded-lg px-3 text-[11.5px] font-semibold"
              style={{
                minHeight: 36,
                background: on ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                color: on ? 'var(--accent)' : 'var(--mute)',
              }}
            >
              {render(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Row({ children }) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2.5"
      style={{ background: 'var(--panel2)', border: '1px solid var(--line)', minHeight: 52 }}
    >
      {children}
    </div>
  );
}

function RowAction({ children, onClick, primary, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded-lg px-3 text-[11.5px] font-semibold"
      style={{
        minHeight: 36,
        background: primary ? 'var(--accent-soft)' : 'transparent',
        border: `1px solid ${primary ? 'var(--accent)' : 'var(--line)'}`,
        color: primary ? 'var(--accent)' : 'var(--mute)',
      }}
    >
      {children}
    </button>
  );
}

function SmallButton({ children, onClick, primary }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl text-[11.5px] font-semibold"
      style={{
        minHeight: 42,
        background: primary ? 'var(--accent)' : 'transparent',
        border: `1px solid ${primary ? 'var(--accent)' : 'var(--line)'}`,
        color: primary ? 'var(--accent-contrast)' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );
}
