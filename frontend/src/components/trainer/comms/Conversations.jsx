/**
 * CONVERSATIONS -- what every AI call came to, without listening to it.
 *
 * Each row is one AI conversation: the member, how it ended, a call back if
 * one was booked, and what (if anything) you need to do. Opening one shows the
 * one-to-two-line summary the server wrote from what actually happened, the
 * facts behind it, and the transcript while your gym keeps transcripts.
 */
import { useState } from 'react';
import { api } from '../../../api.js';
import { Card, ErrorState, Modal, PageSkeleton, Toast } from '../../UI.jsx';
import { CONV_OUTCOME, CONV_STATUS, CALLBACK_STATUS, Pill, SectionHead, Tag, when, useApi } from './shared.jsx';

const FILTERS = [['all', 'All'], ['action', 'Needs you'], ['callbacks', 'Call backs booked'], ['completed', 'Completed']];

function Outcome({ c }) {
  if (!c.outcome) return <Tag tone={c.status === 'failed' ? 'bad' : 'warn'}>{CONV_STATUS[c.status] || c.status}</Tag>;
  const [label, tone] = CONV_OUTCOME[c.outcome] || [c.outcome, 'mute'];
  return <Tag tone={tone}>{label}</Tag>;
}

export default function Conversations() {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const [toast, setToast] = useState({ msg: '' });
  const list = useApi(`/followups/conversations${filter === 'all' ? '' : `?filter=${filter}`}`);
  return (
    <div className="space-y-4">
      <SectionHead title="Conversations" />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>
        Every AI call, summed up in a line or two: what the member said, what was agreed, and what you need to do.
      </p>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar">{FILTERS.map(([k, l]) => <Pill key={k} on={filter === k} onClick={() => setFilter(k)}>{l}</Pill>)}</div>
      {list.loading ? <PageSkeleton label="Loading conversations" /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
        (list.data.conversations || []).length === 0 ? (
          <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>
            {filter === 'action' ? 'Nothing needs you right now.' : 'No AI conversations yet. They appear here when a campaign uses an Interactive AI conversation.'}
          </Card>
        ) : (
          <Card>
            <div className="cm-conv-head" aria-hidden="true">
              <span>Member</span><span>What happened</span><span>Call back</span><span>Status</span>
            </div>
            {list.data.conversations.map((c) => (
              <button key={c.id} type="button" onClick={() => setOpen(c.id)} className="cm-row cm-conv w-full text-left">
                <span className="min-w-0">
                  <span className="block font-semibold truncate" style={{ color: 'var(--ink)' }}>{c.member_name || 'Test call'}</span>
                  <span className="block text-[12px]" style={{ color: 'var(--faint)' }}>{when(c.created_at)}{c.campaign ? ` · ${c.campaign}` : ''}</span>
                </span>
                <span className="min-w-0 text-[14px]" style={{ color: 'var(--ink)' }}>
                  <span className="flex gap-1.5 flex-wrap mb-1"><Outcome c={c} />{Number(c.simulated) === 1 && <Tag>Test mode</Tag>}{c.from_callback_id && <Tag>Call back</Tag>}</span>
                  {c.summary || 'On the call now.'}
                </span>
                <span className="text-[13px]" style={{ color: 'var(--mute)' }}>{c.callback_label || (c.callback_status ? CALLBACK_STATUS[c.callback_status]?.[0] : '—')}</span>
                <span>
                  {Number(c.owner_action_required) === 1 && !c.owner_action_done_at ? <Tag tone="warn">Needs you</Tag>
                    : c.callback_status === 'scheduled' ? <Tag tone="good">Call back booked</Tag>
                      : <Tag>{CONV_STATUS[c.status] || c.status}</Tag>}
                </span>
              </button>
            ))}
          </Card>
        )
      )}
      {open && <Detail id={open} onClose={() => setOpen(null)} onChanged={() => { list.reload(); setToast({ msg: 'Marked as done' }); }} />}
      {toast.msg && <Toast message={toast.msg} onDone={() => setToast({ msg: '' })} />}
    </div>
  );
}

const INTEREST = { yes: 'Wants to continue', maybe: 'Maybe', no: 'Does not want to continue', unknown: 'Not said' };
const INTENT = {
  renew: 'Renew', pay: 'Pay', return: 'Come back', callback: 'Be called later', speak_to_person: 'Talk to a person', decline: 'Not continue',
  ask_question: 'Ask a question', stop: 'Stop calls', wrong_person: 'Wrong person', unclear: 'Unclear', other: 'Other',
};
const TOOL = { schedule_callback: 'Book a call back', request_person: 'Ask for a person', stop_calls: 'Stop calls', wrong_number: 'Wrong number' };
const TOOL_RESULT = { scheduled: 'booked', need_more: 'asked for more detail', recorded: 'recorded', done: 'done', not_allowed: 'not allowed', not_offered: 'switched off', error: 'refused' };

function Detail({ id, onClose, onChanged }) {
  const d = useApi(`/followups/conversations/${id}`);
  const [busy, setBusy] = useState(false);
  const c = d.data?.conversation;
  const done = async () => {
    setBusy(true);
    try { await api(`/followups/conversations/${id}/done`, { method: 'POST' }); d.reload(); onChanged(); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={c ? `${c.member_name || 'Test call'} · ${when(c.created_at)}` : 'Conversation'} wide>
      {d.loading || !c ? <PageSkeleton label="Loading" /> : (
        <div className="space-y-5">
          <div className="rounded-2xl p-4" style={{ background: 'rgb(var(--tint-rgb) / .05)' }}>
            <div className="flex gap-1.5 flex-wrap mb-2"><Outcome c={c} />{Number(c.simulated) === 1 && <Tag>Test mode: simulated call</Tag>}</div>
            <p className="text-[16px] leading-snug" style={{ color: 'var(--ink)' }}>{c.summary || 'The call is still going on.'}</p>
          </div>
          {Number(c.owner_action_required) === 1 && (
            <div className="flex items-center justify-between gap-3 flex-wrap rounded-2xl p-4" style={{ border: '1.5px solid var(--line)' }}>
              <div>
                <div className="text-[13px] font-semibold" style={{ color: 'var(--mute)' }}>For you to do</div>
                <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>{c.owner_action}</div>
              </div>
              {c.owner_action_done_at ? <Tag tone="good">Done {when(c.owner_action_done_at)}</Tag>
                : <button type="button" className="btn-primary" disabled={busy} onClick={done}>Mark as done</button>}
            </div>
          )}
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-[14px]">
            {[
              ['Calling mode', 'Interactive AI conversation'],
              ['Length', c.duration_secs ? `${Math.floor(c.duration_secs / 60)}m ${c.duration_secs % 60}s` : '—'],
              ['Campaign', c.campaign || (c.from_callback_id ? 'A call back' : '—')],
              ['AI agent', c.agent_name || '—'],
              ['What they wanted', c.intent ? INTENT[c.intent] || c.intent : '—'],
              ['Wants to continue', c.renewal_interest ? INTEREST[c.renewal_interest] : '—'],
              ['Questions', c.questions || '—'],
              ['Objection', c.objections || '—'],
              ['Call back', c.callback ? `${c.callback.when_label || ''} · ${CALLBACK_STATUS[c.callback.status]?.[0] || c.callback.status}` : 'None'],
              ['Asked for a person', Number(c.human_escalation) ? 'Yes' : 'No'],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[12px] font-semibold" style={{ color: 'var(--faint)' }}>{k}</dt>
                <dd className="m-0" style={{ color: 'var(--ink)' }}>{v}</dd>
              </div>
            ))}
          </dl>
          {c.tools?.length > 0 && (
            <section>
              <div className="font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>What the AI did during the call</div>
              <ol className="text-[13px] space-y-1" style={{ color: 'var(--mute)' }}>
                {c.tools.map((t, i) => <li key={i}>{TOOL[t.tool] || t.tool}{t.args?.when_text ? ` (“${t.args.when_text}”)` : t.args?.reason ? ` (${t.args.reason})` : ''}: {TOOL_RESULT[t.result] || t.result}{t.when ? ` for ${t.when}` : ''}</li>)}
              </ol>
            </section>
          )}
          <section>
            <div className="font-semibold mb-1.5" style={{ color: 'var(--ink)' }}>Transcript</div>
            {c.transcript?.length ? (
              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {c.transcript.map((t, i) => (
                  <div key={i} className="flex gap-2 text-[14px]">
                    <span className="shrink-0 w-16 font-semibold" style={{ color: t.role === 'agent' ? 'var(--m-nutrition)' : 'var(--ink)' }}>{t.role === 'agent' ? 'AI' : 'Member'}</span>
                    <span style={{ color: 'var(--ink)' }}>{t.text}</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-[14px]" style={{ color: 'var(--mute)' }}>{c.transcript_expires_at === null && c.status !== 'in_progress' ? 'Not kept. Transcripts are off, past their keeping period, or the call did not connect.' : 'No transcript.'}</p>}
            {c.transcript?.length > 0 && c.transcript_expires_at && <p className="text-[12px] mt-2" style={{ color: 'var(--faint)' }}>Deleted automatically on {new Date(c.transcript_expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. The summary stays.</p>}
          </section>
        </div>
      )}
    </Modal>
  );
}
