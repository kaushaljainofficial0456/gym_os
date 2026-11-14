// ============================================================
// AI COMMUNICATION 2.0 -- interactive AI calls, scheduled call backs,
// conversation summaries, owner controls, isolation.
//
// The AI side runs in TEST mode: simulator.js plays a member against the
// SAME server tools a live agent calls (when.js resolves the time, a real
// call back row is booked, a real opt-out is recorded). What the live model
// says is not tested here -- that needs a provider account (see
// docs/AI_COMMUNICATION_TEST_REPORT.md).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { memDb } from './helpers/followupsDb.js';
import { seedGym, addMember, enableGym, voiceCampaign, owner, startApi, today, noon, K } from './helpers/followupsSeed.js';

const wallet = await import('../src/services/followups/wallet.js');
const engine = await import('../src/services/followups/engine.js');
const conv = await import('../src/services/followups/conversations.js');
const cbs = await import('../src/services/followups/callbacks.js');
const { simulateConversation } = await import('../src/services/followups/simulator.js');
const { saveAgent, agentPrompt } = await import('../src/services/followups/studio.js');
const { elevenTools } = await import('../src/services/followups/providers/elevenlabs.js');
const { jobToken, toolKey } = await import('../src/services/followups/config.js');
const { localToUtc } = await import('../src/services/followups/when.js');

const TZ = 'Asia/Kolkata';
const weekday = (k) => (new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7;
const nextMonday = (() => { const d = (0 - weekday(today) + 7) % 7 || 7; return K(d); })();
const num = (v) => Number(v || 0);
let n = 0;

async function aiGym(db, org, { endIn = 5, plans = [], agentExtra = {} } = {}) {
  await seedGym(db, org);
  await enableGym(db, org);                                     // 09:00-21:00, every day
  await wallet.creditUnits(db, org, { 'agent:standard': 100 }, { reason: 'purchase' });
  const agent = await saveAgent(db, org, `owner_${org}`, { name: 'Renewals helper', language: 'en', purpose: 'Remind members to renew and answer their questions.', knowledge: 'Open 6 am to 10 pm.', ...agentExtra });
  const rid = await voiceCampaign(db, org, { kind: 'membership_ending', sequence: [{ channel: 'agent' }], extra: { agent_id: agent.id, agent_tier: 'standard' } });
  const m = await addMember(db, org, { name: 'Rahul Sharma', endIn, lastVisit: 1 });
  for (const p of plans) await db.run('INSERT INTO packages (id, org_id, name, amount, period_days) VALUES (?, ?, ?, ?, ?)', [`pk_${org}_${++n}`, org, p.name, p.amount, p.days]);
  return { org, agent, rid, m };
}

async function aiJob(db, g, { kind = 'membership_ending' } = {}) {
  const jid = `fj_ai_${g.org}_${++n}`;
  const ts = new Date().toISOString();
  await db.run(
    `INSERT INTO followup_jobs (id, org_id, rule_id, client_id, channel, dedupe_key, cycle_key, step_key, day_key, attempt, language, status, to_number, unit, variables_json, created_at, dialed_at, updated_at)
     VALUES (?, ?, ?, ?, 'agent', ?, ?, 'b3', ?, 1, 'en', 'dialing', ?, 'agent:standard', ?, ?, ?, ?)`,
    [jid, g.org, g.rid, g.m.cid, jid, `s:s_${g.m.cid}`, today, g.m.phone, JSON.stringify({ name: 'Rahul', gym: `Gym ${g.org}`, end_date: K(5) }), ts, ts, ts]);
  await wallet.holdUnits(db, g.org, 'agent:standard', 3, { jobId: jid, ruleId: g.rid });
  await db.run('UPDATE followup_jobs SET units_held = 3 WHERE id = ?', [jid]);
  const job = await db.q1('SELECT * FROM followup_jobs WHERE id = ?', [jid]);
  await conv.ensureConversation(db, job, { agentId: g.agent.id, provider: 'test', simulated: true });
  void kind;
  return job;
}

/** One simulated AI call with a chosen member script; returns the job, conversation and result. */
async function talk(db, g, scenario, { at = noon } = {}) {
  const job = await aiJob(db, g);
  const plans = await engine.gymPlans(db, g.org);
  const result = await simulateConversation(db, job, { kind: 'membership_ending', scenario, at, plans });
  await engine.applyAgentResult(db, job, result);
  return {
    job: await db.q1('SELECT * FROM followup_jobs WHERE id = ?', [job.id]),
    conv: await db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [job.id]),
    result,
  };
}

const sentences = (s) => String(s).split(/(?<=[.!?])\s+(?=[A-Z"])/).filter(Boolean).length;
const autoCallbacks = (db, cid) => db.q(`SELECT * FROM followup_callbacks WHERE client_id = ? AND mode != 'human' ORDER BY created_at`, [cid]);
const staffCallbacks = (db, cid) => db.q(`SELECT * FROM followup_callbacks WHERE client_id = ? AND mode = 'human'`, [cid]);

/* ═══════════════════════ the 18 conversations ═══════════════════════ */

test('AI 1: the member agrees to renew -- outcome, renewal interest, owner action, billed by the minute', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r1');
  const { job, conv: c, result } = await talk(db, g, 'renew_yes');
  assert.equal(c.status, 'completed');
  assert.equal(c.outcome, 'renewing');
  assert.equal(c.intent, 'renew');
  assert.equal(c.renewal_interest, 'yes');
  assert.equal(num(c.owner_action_required), 1);
  assert.match(c.owner_action, /Collect the payment/);
  assert.match(c.summary, /^Agreed to renew/);
  assert.equal(job.outcome, 'renewing');
  assert.equal(num(job.units), Math.ceil(result.duration / 60), 'charged the minutes talked');
  assert.equal((await wallet.getWallet(db, 'r1'))['agent:standard'], 100 - Math.ceil(result.duration / 60), 'hold settled, the rest given back');
});

test('AI 2: the member declines -- the reason is kept, no call back, no owner action', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r2');
  const { conv: c, job } = await talk(db, g, 'decline');
  assert.equal(c.outcome, 'declined');
  assert.equal(c.renewal_interest, 'no');
  assert.equal(c.summary, 'Declined renewal: "Moved to another area". No call back requested.');
  assert.equal(num(c.owner_action_required), 0);
  assert.equal(job.outcome, 'not_interested', 'the campaign stops for this membership');
  assert.equal((await autoCallbacks(db, g.m.cid)).length, 0);
  // The transcript shows the AI asked for a reason without pressing.
  assert.match(c.transcript_json, /May I ask why/);
});

test('AI 3+5: busy -> "call me next Monday" -> the AI asks the time -> "6 PM" -> a real call back is booked and confirmed', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r3');
  const { conv: c } = await talk(db, g, 'busy_callback');
  const [cb] = await autoCallbacks(db, g.m.cid);
  assert.ok(cb, 'a call back row exists');
  assert.equal(cb.mode, 'agent', 'the call back keeps the calling mode: the AI calls back');
  assert.equal(cb.status, 'scheduled');
  assert.equal(cb.scheduled_local, `${nextMonday} 18:00`);
  assert.equal(cb.scheduled_for, localToUtc(nextMonday, 18 * 60, TZ).toISOString());
  assert.equal(cb.agent_id, g.agent.id);
  assert.equal(cb.conversation_id, c.id);
  assert.equal(cb.timezone, TZ);
  const transcript = JSON.parse(c.transcript_json);
  assert.ok(transcript.some((t) => t.role === 'agent' && /What time on Monday/.test(t.text)), 'the AI asked for the time first');
  assert.ok(transcript.some((t) => t.role === 'agent' && /I'll call you Monday .* at 6 PM/.test(t.text)), 'and confirmed the booked time');
  const tools = JSON.parse(c.tools_json);
  assert.deepEqual(tools.map((t) => t.result), ['need_more', 'scheduled'], 'the confirmation came only after the booking returned "scheduled"');
  assert.equal(c.outcome, 'callback_scheduled');
  assert.equal(num(c.callback_requested), 1);
  assert.match(c.summary, /^Interested in renewing but could not talk then\. Call back booked for Monday \d+ \w+ at 6 PM\.$/);
});

test('AI 4: "can you call me tomorrow evening?" books tomorrow around 6 PM', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r4');
  const { conv: c } = await talk(db, g, 'callback_tomorrow');
  const [cb] = await autoCallbacks(db, g.m.cid);
  assert.equal(cb.scheduled_local, `${K(1)} 18:00`);
  // A stored summary names the date itself: "tomorrow" would be wrong by tomorrow.
  const d = new Date(`${K(1)}T00:00:00Z`);
  const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  assert.match(c.summary, new RegExp(`Call back booked for ${dayName} ${d.getUTCDate()} \\w+ at 6 PM\\.$`));
});

test('AI 6+7: "after five days" asks the time; "in the evening" means today; the tool answers the agent exactly', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r6');
  const job = await aiJob(db, g);
  const token = jobToken(job.id);
  const ask = await conv.handleTool(db, { tool: 'schedule_callback', token, args: { when_text: 'call me after five days' }, at: noon });
  assert.equal(ask.status, 'need_more');
  assert.equal(ask.need, 'time');
  assert.match(ask.ask, /What time on/);
  const ok = await conv.handleTool(db, { tool: 'schedule_callback', token, args: { when_text: 'after five days at 11 am' }, at: noon });
  assert.equal(ok.status, 'scheduled');
  assert.equal((await autoCallbacks(db, g.m.cid))[0].scheduled_local, `${K(5)} 11:00`);
  // The same call booking again moves its own booking rather than adding one.
  const evening = await conv.handleTool(db, { tool: 'schedule_callback', token, args: { when_text: 'actually, in the evening' }, at: noon });
  assert.equal(evening.status, 'scheduled');
  assert.match(evening.when, /^today .* at around 6 PM$/);
  const rows = await autoCallbacks(db, g.m.cid);
  assert.equal(rows.length, 1, 'rebooked, not duplicated');
  assert.equal(rows[0].scheduled_local, `${today} 18:00`);
  assert.equal(JSON.parse(rows[0].events_json).at(-1).event, 'rescheduled');
});

test('AI 8: an ambiguous date ("next week") books nothing and asks which day', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r8');
  const job = await aiJob(db, g);
  const r = await conv.handleTool(db, { tool: 'schedule_callback', token: jobToken(job.id), args: { when_text: 'sometime next week' }, at: noon });
  assert.deepEqual({ status: r.status, ask: r.ask }, { status: 'need_more', ask: 'Which day next week suits you?' });
  assert.equal((await autoCallbacks(db, g.m.cid)).length, 0);
  assert.equal(num((await db.q1('SELECT callback_requested FROM followup_conversations WHERE job_id = ?', [job.id])).callback_requested), 1);
});

test('AI 9: plan prices come only from the gym\'s own plans; without them the question goes to the owner', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r9', { plans: [{ name: 'Monthly', amount: 1500, days: 30 }, { name: 'Quarterly', amount: 4000, days: 90 }] });
  const priced = await talk(db, g, 'price_question');
  assert.match(priced.conv.transcript_json, /Monthly at ₹1500, Quarterly at ₹4000/);
  assert.equal(num(priced.conv.owner_action_required), 0);
  assert.doesNotMatch(priced.conv.summary, /^Call completed/);

  const db2 = await memDb();
  const g2 = await aiGym(db2, 'r9b');
  const unpriced = await talk(db2, g2, 'price_question');
  assert.match(unpriced.conv.transcript_json, /I don't have the latest plan prices/);
  assert.equal(unpriced.conv.outcome, 'question_open');
  assert.match(unpriced.conv.summary, /could not confirm from your information/);
  assert.match(unpriced.conv.owner_action, /Answer their question: What are your membership plans\?/);
  // And the prompt itself refuses to quote prices it was not given.
  assert.match(agentPrompt(g2.agent, 'membership_ending', { plans: [] }), /do not quote any/);
  assert.match(agentPrompt(g.agent, 'membership_ending', { plans: await engine.gymPlans(db, 'r9') }), /- Monthly: ₹1500 for 30 days/);
});

test('AI 10: an unavailable discount is not promised -- the question goes to a person', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r10');
  const { conv: c } = await talk(db, g, 'discount_question');
  assert.match(c.transcript_json, /I cannot confirm any discount/);
  assert.equal(c.outcome, 'person_requested');
  assert.match(c.summary, /^Asked "Can I get a discount if I renew today\?", which the AI could not confirm/);
  assert.equal((await staffCallbacks(db, g.m.cid)).length, 1);
});

test('AI 11: the member asks for the owner -- a staff call back, an owner action, no more selling', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r11');
  const { conv: c, job } = await talk(db, g, 'wants_person');
  const staff = await staffCallbacks(db, g.m.cid);
  assert.equal(staff.length, 1);
  assert.equal(staff[0].status, 'assigned', 'goes to the member\'s trainer');
  assert.equal(staff[0].priority, 'high');
  assert.equal(staff[0].conversation_id, c.id);
  assert.equal(c.summary, 'Asked to speak to a person about membership charges. A staff call back was created.');
  assert.equal(num(c.human_escalation), 1);
  assert.equal(job.outcome, 'callback');
  // Automated contact pauses while a person is to call (existing rule).
  const plan = await engine.planOrg(db, 'r11', { at: noon });
  assert.equal(plan.queued, 0);
});

test('AI 12: wrong number -- suppressed at once, never called again', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r12');
  const { conv: c, job } = await talk(db, g, 'wrong_number');
  assert.equal(job.outcome, 'wrong_number');
  assert.equal(c.outcome, 'wrong_number');
  assert.match(c.summary, /^Wrong number/);
  const plan = await engine.planOrg(db, 'r12', { at: noon });
  assert.equal(plan.queued, 0);
  assert.equal(plan.skipped.wrong_number, 1);
});

test('AI 13: "stop calling me" -- opted out DURING the call, booked call backs cancelled, logged as the member\'s own request', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r13');
  await talk(db, g, 'busy_callback');
  assert.equal((await autoCallbacks(db, g.m.cid))[0].status, 'scheduled');
  const { conv: c } = await talk(db, g, 'stop');
  const prefs = await db.q1('SELECT * FROM followup_member_prefs WHERE client_id = ?', [g.m.cid]);
  assert.ok(prefs.call_opted_out_at, 'opted out');
  const log = await db.q1(`SELECT * FROM followup_consent_log WHERE client_id = ? AND action = 'opted_out'`, [g.m.cid]);
  assert.equal(log.source, 'agent');
  assert.equal((await autoCallbacks(db, g.m.cid))[0].status, 'cancelled', 'the booked call back is gone too');
  assert.equal(c.summary, 'Asked not to be called again. Calls to this member are stopped.');
});

test('AI 14: the member hangs up at once -- incomplete, never "successful", one minute charged', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r14');
  const { conv: c, job } = await talk(db, g, 'hangup');
  assert.equal(c.status, 'incomplete');
  assert.equal(c.outcome, 'incomplete');
  assert.equal(c.summary, 'The call connected but ended after 6 seconds, before any answer. Nothing was agreed.');
  assert.equal(job.outcome, null, 'no response recorded for the campaign');
  assert.equal(num(job.units), 1);
});

test('AI 15: the AI cannot understand -- marked as such, owner asked to call', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r15');
  const { conv: c } = await talk(db, g, 'not_understood');
  assert.equal(c.status, 'incomplete');
  assert.equal(c.outcome, 'not_understood');
  assert.match(c.summary, /could not understand/);
  assert.equal(c.owner_action, 'Call the member yourself');
});

test('AI 16: the provider fails during the call, or never reports -- failed, nothing charged, no fake outcome', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'r16');
  const job = await aiJob(db, g);
  await engine.applyAgentResult(db, job, { status: 'failed', duration: 0 });
  const c = await db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [job.id]);
  assert.equal(c.status, 'failed');
  assert.equal(c.outcome, null);
  assert.match(c.summary, /could not be completed/);
  assert.equal((await wallet.getWallet(db, 'r16'))['agent:standard'], 100, 'the hold is released');

  // Silence from the provider: the sweep closes it honestly.
  const lost = await aiJob(db, g);
  await db.run('UPDATE followup_jobs SET dialed_at = ? WHERE id = ?', [new Date(Date.now() - 40 * 60_000).toISOString(), lost.id]);
  await engine.sweep(db, 'r16');
  const c2 = await db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [lost.id]);
  assert.equal(c2.status, 'failed');
  assert.match(c2.summary, /provider never reported/);
  assert.equal((await wallet.getWallet(db, 'r16'))['agent:standard'], 100);
});

/* ═══════════════════════ the call-back engine ═══════════════════════ */

async function bookedCallback(db, org) {
  const g = await aiGym(db, org);
  await talk(db, g, 'busy_callback');
  const [cb] = await autoCallbacks(db, g.m.cid);
  return { g, cb, at: new Date(cb.scheduled_for) };
}

test('call back: due -> queued once as an AI call with the same agent and the original situation -> completed', async () => {
  const db = await memDb();
  const { g, cb, at } = await bookedCallback(db, 'cb1');
  assert.deepEqual(await cbs.queueDueCallbacks(db, 'cb1', { at: new Date(at.getTime() - 60_000) }), { expired: 0, queued: 0, cancelled: 0, handed_to_staff: 0, failed: 0 }, 'not before its time');
  const out = await cbs.queueDueCallbacks(db, 'cb1', { at });
  assert.equal(out.queued, 1);
  const jobs = await db.q('SELECT * FROM followup_jobs WHERE callback_id = ?', [cb.id]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].channel, 'agent');
  assert.equal(jobs[0].dedupe_key, `cb:${cb.id}:1`);
  assert.equal(jobs[0].cycle_key, `s:s_${g.m.cid}`, 'carries the situation it was booked about');
  assert.match(JSON.parse(jobs[0].variables_json).callback_context, /asked to be called back Monday/);
  assert.equal((await cbs.getCallback(db, 'cb1', cb.id)).status, 'processing');
  assert.equal((await cbs.queueDueCallbacks(db, 'cb1', { at })).queued, 0, 'a second tick finds nothing to do');

  await db.run(`UPDATE followup_jobs SET status = 'dialing', units_held = 3 WHERE id = ?`, [jobs[0].id]);
  await wallet.holdUnits(db, 'cb1', 'agent:standard', 3, { jobId: jobs[0].id });
  await engine.applyAgentResult(db, jobs[0], { status: 'completed', duration: 70, outcome: 'renewing', summary: 'Will renew today' });
  const done = await cbs.getCallback(db, 'cb1', cb.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at);
  const c = await db.q1('SELECT * FROM followup_conversations WHERE job_id = ?', [jobs[0].id]);
  assert.equal(c.from_callback_id, cb.id, 'the conversation knows it was the call back');
});

test('call back: dispatch places it even if the campaign was paused, and drops it once the member renewed', async () => {
  const db = await memDb();
  const { g, cb, at } = await bookedCallback(db, 'cb2');
  await db.run(`UPDATE followup_rules SET status = 'paused' WHERE id = ?`, [g.rid]);
  await cbs.queueDueCallbacks(db, 'cb2', { at });
  const r = await engine.dispatchOrg(db, 'cb2', { at });
  assert.equal(r.placed, 1, 'the member asked for it: a paused campaign does not cancel it');
  const placed = await db.q1('SELECT * FROM followup_jobs WHERE callback_id = ?', [cb.id]);
  assert.notEqual(placed.status, 'skipped');

  // A second gym, same story, but the member renews before Monday.
  const db2 = await memDb();
  const b = await bookedCallback(db2, 'cb2b');
  await db2.run(`UPDATE subscriptions SET end_date = ? WHERE client_id = ?`, [K(120), b.g.m.cid]);
  await cbs.queueDueCallbacks(db2, 'cb2b', { at: b.at });
  await engine.dispatchOrg(db2, 'cb2b', { at: b.at });
  const skipped = await db2.q1('SELECT * FROM followup_jobs WHERE callback_id = ?', [b.cb.id]);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /No longer due/);
  assert.equal((await cbs.getCallback(db2, 'cb2b', b.cb.id)).status, 'cancelled');
});

test('AI 17: a call back that is not answered is retried an hour later, then failed with a reason the owner can act on', async () => {
  const db = await memDb();
  const { cb, at } = await bookedCallback(db, 'cb3');
  await cbs.queueDueCallbacks(db, 'cb3', { at });
  const j1 = await db.q1('SELECT * FROM followup_jobs WHERE callback_id = ?', [cb.id]);
  await engine.applyAgentResult(db, j1, { status: 'no_answer', duration: 0 });
  const retry = await cbs.getCallback(db, 'cb3', cb.id);
  assert.equal(retry.status, 'scheduled');
  assert.equal(retry.last_error, 'No answer');
  // The retry is timed from when the "no answer" arrived (now): an hour later,
  // or -- if that is outside calling hours -- the asked time on the next open day.
  assert.ok(Date.parse(retry.scheduled_for) >= Date.now() + 59 * 60_000 - 5_000, 'at least an hour after the failed attempt');
  await cbs.queueDueCallbacks(db, 'cb3', { at: new Date(retry.scheduled_for) });
  const j2 = await db.q1(`SELECT * FROM followup_jobs WHERE callback_id = ? AND dedupe_key = ?`, [cb.id, `cb:${cb.id}:2`]);
  assert.ok(j2, 'second attempt queued with its own key');
  await engine.applyAgentResult(db, j2, { status: 'busy', duration: 0 });
  const failed = await cbs.getCallback(db, 'cb3', cb.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /^Line busy after 2 attempts\. Call the member yourself\.$/);
  assert.deepEqual(JSON.parse(failed.events_json).map((e) => e.event), ['scheduled', 'queued', 'retry', 'queued', 'failed']);
});

test('AI 18: two workers racing for the same call back place it once', async () => {
  const db = await memDb();
  const { cb, at } = await bookedCallback(db, 'cb4');
  const results = await Promise.all([cbs.queueDueCallbacks(db, 'cb4', { at }), cbs.queueDueCallbacks(db, 'cb4', { at }), cbs.queueDueCallbacks(db, 'cb4', { at })]);
  assert.equal(results.reduce((s, r) => s + r.queued, 0), 1);
  assert.equal((await db.q('SELECT id FROM followup_jobs WHERE callback_id = ?', [cb.id])).length, 1);
  // And even if a claim were somehow repeated, the job key refuses a duplicate.
  await assert.rejects(db.run(`INSERT INTO followup_jobs (id, org_id, channel, dedupe_key, day_key, created_at, updated_at) VALUES ('dup', 'cb4', 'agent', ?, ?, 'x', 'x')`, [`cb:${cb.id}:1`, today]), /UNIQUE|duplicate/i);
});

test('call back: outside calling hours it waits; more than 2 hours late it expires instead of calling at the wrong time', async () => {
  const db = await memDb();
  const { cb } = await bookedCallback(db, 'cb5');
  const tooLate = new Date(Date.parse(cb.scheduled_for) + 3 * 3600_000);   // 21:00: past the gym's hours anyway
  const out = await cbs.queueDueCallbacks(db, 'cb5', { at: tooLate });
  assert.equal(out.expired, 1);
  assert.equal(out.queued, 0);
  const e = await cbs.getCallback(db, 'cb5', cb.id);
  assert.equal(e.status, 'expired');
  assert.match(e.last_error, /Not placed within 2 hours/);

  const db2 = await memDb();
  const b = await bookedCallback(db2, 'cb5b');
  await db2.run(`UPDATE followup_settings SET window_end = '17:00' WHERE org_id = 'cb5b'`);
  const waiting = await cbs.queueDueCallbacks(db2, 'cb5b', { at: new Date(Date.parse(b.cb.scheduled_for) + 10 * 60_000) });
  assert.equal(waiting.queued, 0);
  assert.equal((await cbs.getCallback(db2, 'cb5b', b.cb.id)).status, 'scheduled', 'still booked: it is only 10 minutes late');
});

test('call back: campaigns leave the member alone while one is booked; a person-only member gets a person instead', async () => {
  const db = await memDb();
  const { g, cb, at } = await bookedCallback(db, 'cb6');
  const plan = await engine.planOrg(db, 'cb6', { at: noon });
  assert.equal(plan.skipped.callback_scheduled, 1);
  await db.run('UPDATE followup_member_prefs SET human_only = 1 WHERE client_id = ?', [g.m.cid]);
  const out = await cbs.queueDueCallbacks(db, 'cb6', { at });
  assert.equal(out.handed_to_staff, 1);
  const now = await cbs.getCallback(db, 'cb6', cb.id);
  assert.deepEqual({ mode: now.mode, status: now.status }, { mode: 'human', status: 'new' });
});

test('owner controls: reschedule, change who calls, cancel, call now -- validated, logged, audited', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    const { g, cb } = await bookedCallback(db, 'oc');
    const me = owner('oc');
    const list = await api.call('GET', '/api/followups/callbacks?view=scheduled', me);
    assert.equal(list.status, 200);
    assert.equal(list.json.callbacks.length, 1);
    assert.match(list.json.callbacks[0].when_label, /Monday .* at 6 PM/);
    assert.equal(list.json.callbacks[0].phone, undefined, 'phone numbers are not sent to the screen');

    const bad = await api.call('PUT', `/api/followups/callbacks/${cb.id}/schedule`, me, { date: K(2), time: '22:30' });
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /only call between/);
    const moved = await api.call('PUT', `/api/followups/callbacks/${cb.id}/schedule`, me, { date: K(2), time: '11:00' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.callback.scheduled_local, `${K(2)} 11:00`);

    const staff = await api.call('PUT', `/api/followups/callbacks/${cb.id}/mode`, me, { mode: 'human' });
    assert.equal(staff.json.callback.mode, 'human');
    assert.equal((await api.call('GET', '/api/followups/callbacks', me)).json.callbacks.length, 1, 'now in the staff list');
    const back = await api.call('PUT', `/api/followups/callbacks/${cb.id}/mode`, me, { mode: 'agent', agent_id: g.agent.id });
    assert.equal(back.json.callback.status, 'scheduled');
    assert.equal(back.json.callback.mode, 'agent');
    assert.equal((await api.call('PUT', `/api/followups/callbacks/${cb.id}`, me, { status: 'completed' })).status, 422, 'an automated call back is not closed by hand');

    const cancelled = await api.call('POST', `/api/followups/callbacks/${cb.id}/cancel`, me, { note: 'Member came in' });
    assert.equal(cancelled.json.callback.status, 'cancelled');
    const events = (await cbs.getCallback(db, 'oc', cb.id)).events_json;
    assert.deepEqual(JSON.parse(events).map((e) => e.event), ['scheduled', 'rescheduled', 'handed_to_staff', 'mode_changed', 'cancelled']);
    const audit = await db.q(`SELECT action FROM followup_audit WHERE org_id = 'oc' AND entity_type = 'followup_callbacks' ORDER BY created_at`);
    assert.deepEqual(audit.map((a) => a.action), ['callback_rescheduled', 'callback_mode_changed', 'callback_mode_changed', 'callback_cancelled']);

    // Call now (inside hours) makes it due at once; the queue picks it up.
    const due = noon;
    await cbs.rescheduleCallback(db, 'oc', cb.id, { date: K(3), time: '11:00' }, 'owner_oc');
    await cbs.callNow(db, 'oc', cb.id, 'owner_oc', due);
    assert.equal((await cbs.queueDueCallbacks(db, 'oc', { at: due })).queued, 1);

    // Booking one yourself: needs the member's call permission.
    const m2 = await addMember(db, 'oc', { name: 'No Permission', consent: [] });
    const refused = await api.call('POST', '/api/followups/callbacks', me, { client_id: m2.cid, date: K(2), time: '11:00', mode: 'agent', agent_id: g.agent.id });
    assert.equal(refused.status, 422);
    assert.match(refused.json.error, /not given permission/);
  } finally { await api.close(); }
});

/* ═══════════════════════ security & isolation ═══════════════════════ */

test('tools: the key AND the call\'s own signed token are required; a tool acts only on that call\'s member', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    const a = await aiGym(db, 'ta');
    const b = await aiGym(db, 'tb');
    const jobA = await aiJob(db, a);
    const post = (tool, body, key = toolKey()) => fetch(`http://127.0.0.1:${api.port}/api/followups/hooks/tools/${tool}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Barbell-Tool-Key': key } : {}) }, body: JSON.stringify(body),
    });
    assert.equal((await post('stop_calls', { followup_job: jobToken(jobA.id) }, null)).status, 401, 'no key');
    assert.equal((await post('stop_calls', { followup_job: jobToken(jobA.id) }, 'wrong')).status, 401, 'wrong key');
    assert.equal((await post('stop_calls', { followup_job: `${jobA.id}.forged` })).status, 400, 'forged token');
    assert.equal((await post('delete_everything', { followup_job: jobToken(jobA.id) })).status, 404);
    const ok = await post('stop_calls', { followup_job: jobToken(jobA.id) });
    assert.equal(ok.status, 200);
    assert.ok((await db.q1('SELECT call_opted_out_at FROM followup_member_prefs WHERE client_id = ?', [a.m.cid])).call_opted_out_at);
    assert.equal((await db.q1('SELECT call_opted_out_at FROM followup_member_prefs WHERE client_id = ?', [b.m.cid])).call_opted_out_at, null, 'the other gym\'s member is untouched');
    // ElevenLabs may wrap the arguments in { parameters }.
    const jobA2 = await aiJob(db, a);
    const wrapped = await post('schedule_callback', { parameters: { followup_job: jobToken(jobA2.id), when_text: 'tomorrow at 11 am' } });
    assert.equal((await wrapped.json()).status, 'not_allowed', 'and a member who said stop cannot be booked');
  } finally { await api.close(); }
});

test('isolation: gym B cannot read or change gym A\'s conversations, call backs or recordings; members and trainers cannot use the owner API', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    const a = await aiGym(db, 'ia');
    await aiGym(db, 'ib');
    const { conv: c } = await talk(db, a, 'busy_callback');
    const [cb] = await autoCallbacks(db, a.m.cid);
    const B = owner('ib');
    assert.equal((await api.call('GET', `/api/followups/conversations/${c.id}`, B)).status, 404);
    assert.equal((await api.call('GET', '/api/followups/conversations', B)).json.conversations.length, 0);
    assert.equal((await api.call('GET', '/api/followups/callbacks?view=scheduled', B)).json.callbacks.length, 0);
    assert.equal((await api.call('PUT', `/api/followups/callbacks/${cb.id}/schedule`, B, { date: K(2), time: '11:00' })).status, 404);
    assert.equal((await api.call('POST', `/api/followups/callbacks/${cb.id}/cancel`, B, {})).status, 404);
    assert.equal((await api.call('PUT', `/api/followups/callbacks/${cb.id}/mode`, B, { mode: 'human' })).status, 404);
    assert.equal((await api.call('POST', `/api/followups/conversations/${c.id}/done`, B)).status, 404);
    assert.equal((await cbs.getCallback(db, 'ia', cb.id)).status, 'scheduled', 'untouched');

    const A = owner('ia');
    assert.equal((await api.call('GET', `/api/followups/conversations/${c.id}`, A)).json.conversation.transcript.length > 0, true);
    const member = { sub: a.m.uid, role: 'CLIENT', org: 'ia' };
    assert.equal((await api.call('GET', '/api/followups/conversations', member)).status, 403);
    assert.equal((await api.call('GET', '/api/followups/callbacks?view=scheduled', member)).status, 403);
    const trainer = { sub: 'trainer_ia', role: 'TRAINER', org: 'ia' };
    assert.equal((await api.call('POST', '/api/followups/rules', trainer, { name: 'x', kind: 'missed_visits', sequence: [{ channel: 'call' }] })).status, 403);
    assert.equal((await api.call('PUT', '/api/followups/settings', trainer, { enabled: false })).status, 403);
  } finally { await api.close(); }
});

/* ═══════════════════════ summaries, transcripts, prompts ═══════════════════════ */

test('summaries: every finished conversation has one or two specific lines; incomplete is never called completed', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'sm', { plans: [{ name: 'Monthly', amount: 1500, days: 30 }] });
  const scenarios = ['renew_yes', 'decline', 'busy_callback', 'callback_tomorrow', 'price_question', 'discount_question', 'wants_person', 'not_understood', 'hangup', 'coming_back', 'will_pay'];
  for (const s of scenarios) {
    await db.run(`UPDATE followup_callbacks SET status = 'cancelled' WHERE client_id = ? AND status IN ('scheduled','new','assigned')`, [g.m.cid]);
    const { conv: c } = await talk(db, g, s);
    assert.ok(c.summary, `${s}: has a summary`);
    assert.ok(sentences(c.summary) <= 2, `${s}: one or two sentences -- ${c.summary}`);
    assert.doesNotMatch(c.summary, /call completed|successful/i, `${s}: not generic`);
    if (['hangup', 'not_understood'].includes(s)) assert.equal(c.status, 'incomplete', `${s}: not marked completed`);
  }
});

test('transcripts: kept for the gym\'s retention period, then deleted; switched off, none are kept', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'tr');
  const { conv: c } = await talk(db, g, 'renew_yes');
  assert.ok(c.transcript_json);
  const days = (Date.parse(c.transcript_expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 89 && days < 91, '90 days by default');
  assert.equal(await conv.pruneTranscripts(db, 'tr', new Date(Date.now() + 91 * 86_400_000)), 1);
  const after = await db.q1('SELECT transcript_json, summary FROM followup_conversations WHERE id = ?', [c.id]);
  assert.equal(after.transcript_json, null);
  assert.ok(after.summary, 'the summary stays');
  await db.run(`UPDATE followup_settings SET keep_transcripts = 0 WHERE org_id = 'tr'`);
  const { conv: c2 } = await talk(db, g, 'decline');
  assert.equal(c2.transcript_json, null);
});

test('agent setup: the AI must say it is an AI; tools follow the owner\'s switches; ElevenLabs gets authenticated webhooks and end_call', async () => {
  const db = await memDb();
  await seedGym(db, 'ag');
  await assert.rejects(saveAgent(db, 'ag', 'owner_ag', { name: 'X', language: 'en', purpose: 'Remind members to renew.', greeting: 'Hello {name}, this is the gym calling.' }), /must say that this is an AI/);
  const quiet = await saveAgent(db, 'ag', 'owner_ag', { name: 'Y', language: 'en', purpose: 'Remind members to renew.', allow_callbacks: false, max_minutes: 9, tone: 'loud' });
  assert.equal(num(quiet.max_minutes), 5, 'length limit clamped to 5 minutes');
  assert.equal(quiet.tone, 'warm', 'unknown tone falls back');
  assert.deepEqual(conv.agentTools(quiet).map((t) => t.name), ['request_person', 'stop_calls', 'wrong_number']);
  assert.match(agentPrompt(quiet, 'membership_ending'), /You cannot book call backs on this call/);
  const full = await saveAgent(db, 'ag', 'owner_ag', { name: 'Z', language: 'en', purpose: 'Remind members to renew.' });
  const prompt = agentPrompt(full, 'membership_ending');
  for (const rule of [/first sentence says you are an AI assistant/, /Check you are speaking to \{\{member_name\}\} before mentioning anything/, /Only after it returns "scheduled"/, /Never say a payment was made/, /call stop_calls at once/]) assert.match(prompt, rule);
  const tools = elevenTools(conv.agentTools(full));
  assert.equal(tools.at(-1).name, 'end_call');
  const sched = tools.find((t) => t.name === 'schedule_callback');
  assert.equal(sched.api_schema.request_headers['X-Barbell-Tool-Key'], toolKey());
  assert.equal(sched.api_schema.request_body_schema.properties.followup_job.dynamic_variable, 'followup_job', 'the call reference is never chosen by the model');
  assert.match(sched.api_schema.url, /\/api\/followups\/hooks\/tools\/schedule_callback$/);
});

test('founder usage: split by calling mode, campaign and gym; call backs counted; a retried webhook is never counted twice', async () => {
  const api = await startApi();
  try {
    const { db } = api;
    const g = await aiGym(db, 'us');
    const { job } = await talk(db, g, 'renew_yes');            // interactive, billed
    await talk(db, g, 'busy_callback');                       // books a call back
    // A prerecorded call on the same gym: one connected minute of voice.
    await wallet.creditUnits(db, 'us', { 'voice:standard': 10 }, { reason: 'purchase' });
    const ts = new Date().toISOString();
    await db.run(`INSERT INTO followup_jobs (id, org_id, rule_id, client_id, channel, dedupe_key, day_key, status, unit, created_at, dialed_at, updated_at) VALUES ('pv1', 'us', ?, ?, 'call', 'pv1', ?, 'dialing', 'voice:standard', ?, ?, ?)`, [g.rid, g.m.cid, today, ts, ts, ts]);
    await wallet.holdUnits(db, 'us', 'voice:standard', 1, { jobId: 'pv1', ruleId: g.rid });
    await db.run(`UPDATE followup_jobs SET units_held = 1 WHERE id = 'pv1'`);
    const pv = await db.q1(`SELECT * FROM followup_jobs WHERE id = 'pv1'`);
    await engine.applyCallStatus(db, pv, { status: 'completed', duration: 40 });
    await engine.applyCallStatus(db, pv, { status: 'completed', duration: 40 });       // the provider retries
    await engine.applyAgentResult(db, job, { status: 'completed', duration: 999 });    // a late duplicate of the AI result

    const r = await api.call('GET', '/api/console/communication/usage', { sub: 'founder', role: 'SUPER_ADMIN', org: null });
    assert.equal(r.status, 200);
    const { report, trend } = r.json;
    assert.equal(report.modes.prerecorded.units, 1, 'one voice minute, counted once');
    assert.equal(report.modes.prerecorded.connected, 1);
    const aiMinutes = (await db.q(`SELECT SUM(-delta) AS n FROM followup_ledger WHERE org_id = 'us' AND reason = 'usage' AND unit = 'agent:standard'`))[0].n;
    assert.equal(report.modes.interactive.units, Number(aiMinutes), 'interactive minutes = the ledger, the late duplicate ignored');
    assert.equal(report.modes.interactive.attempts, 2);
    assert.equal(report.callbacks.scheduled, 1);
    assert.equal(report.callbacks.waiting, 1);
    assert.equal(report.gyms.length, 1);
    assert.equal(report.gyms[0].name, 'Gym us');
    const camp = report.campaigns.find((c) => c.rule_id === g.rid);
    assert.deepEqual(camp.modes.sort(), ['interactive', 'prerecorded']);
    assert.equal(trend.length, 6);
    assert.equal((await api.call('GET', '/api/console/communication/usage', owner('us'))).status, 403, 'owners never see costs and margins');
    const one = await api.call('GET', `/api/console/communication/gyms/us`, { sub: 'founder', role: 'SUPER_ADMIN', org: null });
    assert.equal(one.json.usage.modes.prerecorded.units, 1);
  } finally { await api.close(); }
});

test('engine: an interactive campaign runs end to end in test mode -- conversation records, summaries and call backs, no real phone', async () => {
  const db = await memDb();
  const g = await aiGym(db, 'e2e');
  for (let i = 0; i < 11; i++) await addMember(db, 'e2e', { name: `Member ${i}`, endIn: 5, lastVisit: 1 });
  await engine.planOrg(db, 'e2e', { at: noon });
  await engine.dispatchOrg(db, 'e2e', { at: noon, max: 50 });
  const rows = await db.q(`SELECT * FROM followup_conversations WHERE org_id = 'e2e'`);
  assert.equal(rows.length, 12, 'one record per AI call');
  for (const c of rows) {
    assert.notEqual(c.status, 'in_progress');
    assert.ok(c.summary);
    assert.equal(num(c.simulated), 1, 'marked as a test-mode simulation');
  }
  const jobs = await db.q(`SELECT * FROM followup_jobs WHERE org_id = 'e2e' AND channel = 'agent'`);
  assert.ok(jobs.every((j) => j.provider === 'test'), 'only the test provider was used');
  void g;
});
