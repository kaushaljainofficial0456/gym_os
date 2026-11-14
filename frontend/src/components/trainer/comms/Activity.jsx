/**
 * HISTORY -- every call and message, as the provider reported it. A call
 * that was placed but not answered says "No answer", never "Connected";
 * a message is "Delivered" only when the provider confirmed it.
 * Plus the next seven days: who each running campaign is due to contact.
 */
import { useState } from 'react';
import { Card, ErrorState, PageSkeleton, Seg } from '../../UI.jsx';
import { CHANNEL, OUTCOME, STATUS, Pill, SectionHead, Tag, Tile, statusTone, when, num, useApi } from './shared.jsx';

export default function Activity() {
  const [view, setView] = useState('history');
  return (
    <div className="space-y-5">
      <div className="max-w-sm"><Seg value={view} onChange={setView} options={[{ value: 'history', label: 'What happened' }, { value: 'calendar', label: 'Coming up' }]} /></div>
      {view === 'history' ? <History /> : <Calendar />}
    </div>
  );
}

function History() {
  const [channel, setChannel] = useState('');
  const [responses, setResponses] = useState(false);
  const [open, setOpen] = useState(null);
  const a = useApi(`/followups/activity?${channel ? `channel=${channel}&` : ''}${responses ? 'outcome=responses' : ''}`);
  return (
    <>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
        <Pill on={!channel && !responses} onClick={() => { setChannel(''); setResponses(false); }}>Everything</Pill>
        {Object.entries(CHANNEL).map(([k, v]) => <Pill key={k} on={channel === k} onClick={() => setChannel(channel === k ? '' : k)}>{v.label}</Pill>)}
        <Pill on={responses} onClick={() => setResponses(!responses)}>Replies only</Pill>
      </div>
      {a.loading ? <PageSkeleton label="Loading history" /> : a.error ? <ErrorState error={a.error} onRetry={a.reload} /> : a.data.items.length === 0 ? (
        <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>Nothing yet. Calls and messages appear here as campaigns run.</Card>
      ) : (
        <Card>
          {a.data.items.map((j) => (
            <div key={j.id}>
              <button type="button" className="cm-row w-full text-left" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
                <Tile icon={CHANNEL[j.channel]?.icon || 'chat'} tone={CHANNEL[j.channel]?.hue || 'training'} size={36} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate" style={{ color: 'var(--ink)' }}>{j.is_test ? 'Test to your phone' : j.member_name || 'Member'}</div>
                  <div className="text-[13px] truncate" style={{ color: 'var(--mute)' }}>{when(j.created_at)}{j.campaign ? ` · ${j.campaign}` : ''}{j.duration_secs ? ` · ${j.duration_secs}s` : ''}{j.segments ? ` · ${j.segments} SMS part${j.segments > 1 ? 's' : ''}` : ''}</div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Tag tone={statusTone(j.status)}>{STATUS[j.status] || j.status}</Tag>
                  {j.outcome && <Tag tone="good">{OUTCOME[j.outcome] || j.outcome}</Tag>}
                </div>
              </button>
              {open === j.id && (
                <div className="px-4 pb-4 -mt-1 space-y-2 text-[14px]" style={{ color: 'var(--ink)' }}>
                  {j.summary && <p><b>Summary:</b> {j.summary}</p>}
                  {j.message_text && <p className="leading-relaxed" style={{ color: 'var(--mute)' }}>“{j.message_text}”</p>}
                  {j.digits && <p>Pressed {j.digits}</p>}
                  {j.error && <p style={{ color: 'var(--m-energy)' }}>{j.error}</p>}
                  <p className="text-[13px]" style={{ color: 'var(--faint)' }}>{j.from_number ? `From ${j.from_number} · ` : ''}{j.units ? `Used ${num(j.units)} ${j.unit === 'sms' ? 'SMS' : j.unit === 'whatsapp' ? 'message' : 'minute'}${j.units > 1 ? 's' : ''}` : 'Nothing used'}</p>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

function Calendar() {
  const c = useApi('/followups/calendar');
  if (c.loading) return <PageSkeleton label="Working out the week" />;
  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  return (
    <>
      <SectionHead title="The next seven days" />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>Who running campaigns are due to contact each day, if nothing changes (a visit, a renewal or a reply takes a member off the list).</p>
      <Card>
        {c.data.days.map((d) => (
          <div key={d.day} className="cm-row">
            <div className="w-28 shrink-0">
              <div className="font-semibold" style={{ color: 'var(--ink)' }}>{new Date(`${d.day}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
            </div>
            <div className="flex-1 flex flex-wrap gap-1.5">
              {d.campaigns.length === 0 ? <span className="text-[14px]" style={{ color: 'var(--faint)' }}>Nobody</span> : d.campaigns.map((x) => <Tag key={x.id}>{x.name} · {x.count}</Tag>)}
            </div>
            <div className="text-[18px] font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{d.count}</div>
          </div>
        ))}
      </Card>
    </>
  );
}
