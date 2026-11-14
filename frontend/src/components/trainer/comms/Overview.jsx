/**
 * OVERVIEW -- is it working, what happened today, what is left to spend,
 * and what to do next. A first-time owner sees a short setup checklist.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, PageSkeleton, Toast } from '../../UI.jsx';
import Icon from '../../Icon.jsx';
import { CHANNEL, KIND, PRODUCT_HUE, Tile, Tag, SectionHead, num, useApi } from './shared.jsx';

export function ModeBanner({ setup }) {
  if (!setup || setup.mode === 'live') return null;
  const test = setup.mode === 'test';
  return (
    <div className="rounded-2xl p-4 flex gap-3 items-start" style={{ background: test ? 'var(--m-training-bg)' : 'var(--m-strength-bg)', border: '1px solid var(--line)' }} role="status">
      <Icon name={test ? 'sparkle' : 'clock'} size={18} style={{ color: test ? 'var(--m-training)' : 'var(--m-strength)', marginTop: 2 }} />
      <div className="text-[14px]" style={{ color: 'var(--ink)' }}>
        {test
          ? <><b>Test mode.</b> Calls and messages are simulated with realistic results, and nothing reaches a real phone. Everything else works for real.</>
          : <><b>Not live yet.</b> You can set everything up now. Sending starts once Barbell connects the phone and WhatsApp providers.</>}
      </div>
    </div>
  );
}

const CHANNEL_NAMES = { call: 'voice calls', agent: 'AI conversations', sms: 'SMS', whatsapp: 'WhatsApp' };

/** Barbell paused sending for every gym (or one channel) from the admin console. */
export function PlatformBanner({ platform }) {
  if (!platform || (!platform.paused && !platform.channels?.length)) return null;
  const what = platform.paused ? 'all automated calls and messages' : platform.channels.map((c) => CHANNEL_NAMES[c] || c).join(', ');
  return (
    <div className="rounded-2xl p-4 flex gap-3 items-start" style={{ background: 'var(--m-strength-bg)', border: '1px solid var(--line)' }} role="status">
      <Icon name="clock" size={18} style={{ color: 'var(--m-strength)', marginTop: 2 }} />
      <div className="text-[14px]" style={{ color: 'var(--ink)' }}>
        <b>Paused by Barbell.</b> Sending {what} is on hold for every gym for now. Nothing is lost: your campaigns, settings and balance stay as they are and pick up again when it resumes.
      </div>
    </div>
  );
}

export default function Overview({ go }) {
  const { data, loading, error, reload } = useApi('/followups/overview');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');
  if (loading) return <PageSkeleton label="Loading AI Communication" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const d = data;

  const toggle = async (c) => {
    setBusy(c.id);
    try {
      await api(`/followups/rules/${c.id}/status`, { method: 'POST', body: JSON.stringify({ status: c.status === 'active' ? 'paused' : 'active' }) });
      await reload();
    } catch (e) {
      setToast(e.message);
      if (/compliance/i.test(e.message)) go('settings');
    } finally { setBusy(''); }
  };

  const paid = d.purchases > 0;
  const reachable = Math.max(d.reach.call, d.reach.sms, d.reach.whatsapp);
  const steps = [
    { done: paid, label: 'Buy calls or messages', tab: 'plans' },
    { done: reachable > 0, label: 'Record which members agreed to be contacted', tab: 'members' },
    { done: d.campaigns.length > 0, label: 'Create your first campaign', tab: 'campaigns' },
    { done: !!d.settings.compliance?.accepted_terms && d.settings.enabled, label: 'Confirm the checklist and switch on', tab: 'settings' },
  ];
  const setupLeft = steps.filter((s) => !s.done).length;

  return (
    <div className="space-y-6">
      <ModeBanner setup={d.setup} />
      <PlatformBanner platform={d.platform} />

      {setupLeft > 0 && (
        <Card className="p-5">
          <SectionHead title="Get set up" action={<span className="text-[13px]" style={{ color: 'var(--mute)' }}>{steps.length - setupLeft} of {steps.length} done</span>} />
          <ol className="space-y-1">
            {steps.map((s, i) => (
              <li key={s.label}>
                <button type="button" onClick={() => go(s.tab)} className="w-full flex items-center gap-3 py-2.5 text-left rounded-xl">
                  <span className="w-7 h-7 rounded-full grid place-items-center text-[13px] font-bold shrink-0"
                    style={s.done ? { background: 'var(--m-body-bg)', color: 'var(--m-body)' } : { background: 'rgb(var(--tint-rgb) / .07)', color: 'var(--mute)' }}>
                    {s.done ? <Icon name="check" size={14} /> : i + 1}
                  </span>
                  <span className="flex-1 text-[15px]" style={{ color: s.done ? 'var(--mute)' : 'var(--ink)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
                  {!s.done && <Icon name="play" size={12} style={{ color: 'var(--faint)' }} />}
                </button>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {!d.settings.enabled && setupLeft === 0 && (
        <Card className="p-5 flex items-center justify-between gap-3 flex-wrap">
          <div><div className="font-semibold" style={{ color: 'var(--ink)' }}>AI Communication is switched off</div><div className="text-[14px]" style={{ color: 'var(--mute)' }}>Nothing is sent until you switch it on.</div></div>
          <button type="button" className="btn-primary" onClick={() => go('settings')}>Open settings</button>
        </Card>
      )}

      <section>
        <SectionHead title="Today" action={<span className="text-[13px]" style={{ color: 'var(--mute)' }}>{d.in_hours ? 'Calling hours now' : 'Outside calling hours'}</span>} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <TodayTile icon="phone" tone="training" label="Calls connected" value={d.today.connected} sub={`${num(d.today.calls)} placed`} />
          <TodayTile icon="chat" tone="body" label="Messages delivered" value={d.today.delivered} sub={`${num(d.today.messages)} sent`} />
          <TodayTile icon="check" tone="recovery" label="Replies" value={d.today.responses} sub={d.today.queued ? `${d.today.queued} in progress` : 'Key presses and replies'} />
          <button type="button" className="text-left" onClick={() => go('callbacks')}>
            <TodayTile icon="bell" tone="energy" label="Waiting for a call back" value={d.callbacks_open} sub="Members who asked for a person" />
          </button>
        </div>
      </section>

      <section>
        <SectionHead title="What you have left" action={<button type="button" className="btn btn-sm" onClick={() => go('plans')}>Buy more</button>} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {(d.products || []).filter((p) => p.available || (d.wallet[p.key] || 0) > 0).map((p) => {
            const left = d.wallet[p.key] || 0;
            return (
              <Card key={p.key} className="p-4">
                <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: `var(--m-${PRODUCT_HUE[p.product]})` }} /><span className="text-[13px] leading-tight" style={{ color: 'var(--mute)' }}>{p.name}</span></div>
                <div className="text-[26px] font-bold tabular-nums mt-0.5" style={{ color: left > 0 ? 'var(--ink)' : 'var(--faint)' }}>{num(left)}</div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{p.short} left{d.holds?.[p.key] ? ` · ${num(d.holds[p.key])} on hold` : ''}</div>
              </Card>
            );
          })}
        </div>
        <div className="text-[13px] mt-2" style={{ color: 'var(--mute)' }}>
          {d.lines.lines > 0 ? `${d.lines.lines} number${d.lines.lines > 1 ? 's' : ''} of your own until ${new Date(d.lines.until).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.` : 'Calls go out from Barbell’s shared business line. Your own number is in Plans.'}
        </div>
      </section>

      <section>
        <SectionHead title="Campaigns" action={<button type="button" className="btn btn-sm" onClick={() => go('campaigns')}>+ New campaign</button>} />
        {d.campaigns.length === 0 ? (
          <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>
            No campaigns yet. A campaign decides who is contacted, when, and how, for example a call 7 days after a member stops coming.
          </Card>
        ) : (
          <Card className="divide-y" style={{ '--tw-divide-opacity': 1 }}>
            {d.campaigns.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-4" style={{ borderColor: 'var(--line)' }}>
                <Tile icon={KIND[c.kind].icon} tone={KIND[c.kind].hue} size={40} />
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => go('campaigns')}>
                  <div className="font-semibold truncate" style={{ color: 'var(--ink)' }}>{c.name}</div>
                  <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{c.sequence.map((s) => CHANNEL[s.channel].short).join(' → ')} · {c.schedule}</div>
                </button>
                <button type="button" role="switch" aria-checked={c.status === 'active'} aria-label={`${c.name} ${c.status === 'active' ? 'on' : 'off'}`}
                  disabled={busy === c.id} onClick={() => toggle(c)} className="cm-switch" data-on={c.status === 'active'} />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section>
        <SectionHead title="Who you can reach" action={<button type="button" className="btn btn-sm" onClick={() => go('members')}>Members</button>} />
        <Card className="p-5 space-y-3">
          {[['call', 'Calls'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']].map(([k, label]) => (
            <div key={k}>
              <div className="flex justify-between text-[14px] mb-1"><span style={{ color: 'var(--ink)' }}>{label}</span><span className="tabular-nums" style={{ color: 'var(--mute)' }}>{num(d.reach[k])} of {num(d.reach.total)}</span></div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgb(var(--tint-rgb) / .08)' }}>
                <div className="h-full rounded-full" style={{ width: `${d.reach.total ? (d.reach[k] / d.reach.total) * 100 : 0}%`, background: `var(--m-${CHANNEL[k === 'call' ? 'call' : k].hue})` }} />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            {d.reach.no_permission > 0 && <Tag tone="warn">{num(d.reach.no_permission)} without permission</Tag>}
            {d.reach.opted_out > 0 && <Tag>{num(d.reach.opted_out)} asked to stop</Tag>}
            {d.reach.no_phone > 0 && <Tag>{num(d.reach.no_phone)} without a mobile number</Tag>}
          </div>
        </Card>
      </section>
      {toast && <Toast message={toast} tone="error" onDone={() => setToast('')} />}
    </div>
  );
}

function TodayTile({ icon, tone, label, value, sub }) {
  return (
    <Card className="p-4 h-full">
      <div className="flex items-center gap-2.5">
        <Tile icon={icon} tone={tone} size={32} />
        <div className="text-[13px] leading-tight" style={{ color: 'var(--mute)' }}>{label}</div>
      </div>
      <div className="text-[26px] font-bold tabular-nums mt-2" style={{ color: 'var(--ink)' }}>{num(value)}</div>
      <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{sub}</div>
    </Card>
  );
}
