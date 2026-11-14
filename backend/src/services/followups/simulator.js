// ============================================================
// TEST MODE ONLY -- a simulated member on an AI call.
//
// In test mode no phone rings and no language model runs. Instead, a member
// script (picked deterministically from the job id, so a test can choose it)
// is played against the SAME server tools a live agent uses: a "call me next
// Monday" really goes through when.js and really books a call back; "stop
// calling me" really opts the member out. The agent's lines here are fixed
// sentences, clearly a simulation (conversations are marked simulated = 1).
// Live calls never come through this file: providers/index.js routes them to
// ElevenLabs or your own agent server.
// ============================================================
import crypto from 'node:crypto';
import { jobToken } from './config.js';
import { handleTool } from './conversations.js';

const roll = (seed, salt) => crypto.createHash('sha256').update(`${seed}:${salt}`).digest().readUInt32BE(0) / 0xffffffff;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Which member the simulator plays, by campaign kind (weights add up per kind). */
const MIX = {
  membership_ending: [['busy_callback', 3], ['renew_yes', 3], ['decline', 2], ['discount_question', 1], ['price_question', 1], ['wants_person', 1], ['callback_tomorrow', 1], ['stop', 0.5], ['wrong_number', 0.5], ['not_understood', 0.5], ['hangup', 0.5]],
  missed_visits: [['coming_back', 3], ['busy_callback', 2], ['decline', 1], ['wants_person', 1], ['callback_tomorrow', 1], ['price_question', 1], ['stop', 0.5], ['wrong_number', 0.5], ['not_understood', 0.5], ['hangup', 0.5]],
  payment_due: [['will_pay', 3], ['busy_callback', 2], ['wants_person', 2], ['decline', 1], ['stop', 0.5], ['wrong_number', 0.5], ['hangup', 0.5]],
  onboarding: [['coming_back', 3], ['callback_tomorrow', 2], ['price_question', 1], ['wants_person', 1], ['hangup', 1]],
  announcement: [['coming_back', 2], ['price_question', 2], ['wants_person', 1], ['stop', 0.5], ['hangup', 1]],
};

/** { connected: false, status } or { connected: true, scenario }. */
export function pickScenario(seed, kind) {
  const r = roll(seed, 'answer');
  if (r < 0.25) return { connected: false, status: 'no_answer' };
  if (r < 0.3) return { connected: false, status: 'busy' };
  const list = MIX[kind] || MIX.membership_ending;
  const total = list.reduce((n, [, w]) => n + w, 0);
  let x = roll(seed, 'scenario') * total;
  for (const [name, w] of list) { if ((x -= w) < 0) return { connected: true, scenario: name }; }
  return { connected: true, scenario: list[0][0] };
}

function purposeLine(kind, v) {
  switch (kind) {
    case 'membership_ending': return `Your membership ends on ${v.end_date || 'soon'}. Would you like to renew it?`;
    case 'payment_due': return `There is a pending payment of ${v.amount_due ? `₹${v.amount_due}` : 'your fees'}. Would you be able to pay it this week?`;
    case 'onboarding': return 'You joined recently but have not come in yet. Can I help you get started?';
    case 'announcement': return 'The gym has an update for members. Do you have a moment?';
    default: return `We have not seen you at the gym for ${v.days_absent || 'a few'} days. Is everything alright? Would you like to come back this week?`;
  }
}

/**
 * Run one simulated AI call for `job` (already placed, status dialing).
 * Returns a provider-shaped result for applyAgentResult.
 */
export async function simulateConversation(db, job, { kind = null, scenario = null, at = new Date(), plans = [] } = {}) {
  const pick = scenario ? { connected: true, scenario } : pickScenario(job.id, kind);
  const base = { provider: 'test', ref: `test_ai_${job.id}`, simulated: true };
  if (!pick.connected) return { ...base, status: pick.status, duration: 0, transcript: [] };

  const v = parse(job.variables_json, {});
  const name = v.name || 'there';
  const gym = v.gym || 'the gym';
  const token = jobToken(job.id);
  const t = [];
  const agent = (text) => t.push({ role: 'agent', text });
  const member = (text) => t.push({ role: 'member', text });
  const tool = (name2, args) => handleTool(db, { tool: name2, token, args, at });
  const res = { understood: true };

  agent(`Hi ${name}, I'm an AI assistant calling from ${gym}. Am I speaking with ${name}?`);
  if (pick.scenario === 'wrong_number') {
    member(`No, there is no ${name} here. Wrong number.`);
    await tool('wrong_number', {});
    agent('I am sorry for the trouble. Have a good day.');
    return finish(base, t, { ...res, outcome: 'wrong_number', reason: 'The person who answered is not the member' });
  }
  if (pick.scenario === 'hangup') {
    member('Hello?');
    return finish(base, t, { ...res, outcome: 'no_conversation' }, 6);
  }
  member('Yes, speaking.');
  agent(job.callback_id ? `You asked us to call you back at this time. ${purposeLine(kind, v)}` : purposeLine(kind, v));

  switch (pick.scenario) {
    case 'renew_yes':
      member("Yes, I'll renew. I'll do it at the front desk this week.");
      agent("Wonderful. The team will be ready for you. Thank you, and have a great day!");
      return finish(base, t, { ...res, outcome: 'renewing', renewal_interest: 'yes', reason: 'Will renew at the front desk this week' });
    case 'coming_back':
      member("I was travelling for work. I'll be back on Monday.");
      agent('Great to hear. See you on Monday!');
      return finish(base, t, { ...res, outcome: 'coming_back', renewal_interest: 'yes', reason: 'Was travelling for work; back on Monday' });
    case 'will_pay':
      member("Yes, I'll pay by UPI tonight.");
      agent('Thank you! Have a good evening.');
      return finish(base, t, { ...res, outcome: 'will_pay', renewal_interest: 'yes', reason: 'Will pay by UPI tonight' });
    case 'decline':
      member("No, I don't want to continue.");
      agent("That's alright. May I ask why, so the gym can improve? You don't have to say.");
      member("I've moved to another area.");
      agent('Thank you for letting us know. Take care!');
      return finish(base, t, { ...res, outcome: 'not_interested', renewal_interest: 'no', objection: 'Moved to another area', reason: 'Moved to another area' });
    case 'discount_question': {
      member('Can I get a discount if I renew today?');
      agent('I cannot confirm any discount. Someone from the gym team can tell you about offers. Would you like that?');
      member('Okay, let them call me.');
      await tool('request_person', { reason: 'a renewal discount' });
      agent('Done. Someone from the gym will call you back soon. Thank you!');
      return finish(base, t, { ...res, outcome: 'callback_requested', renewal_interest: 'maybe', unanswered_question: 'Can I get a discount if I renew today?', reason: 'Asked about a renewal discount' });
    }
    case 'price_question': {
      member('What are your membership plans?');
      if (plans.length) {
        agent(`We have ${plans.slice(0, 3).map((p) => `${p.name} at ₹${Math.round(p.amount)}`).join(', ')}.`);
        member("Okay, I'll think about it.");
        agent('Of course. Thank you for your time!');
        return finish(base, t, { ...res, outcome: 'other', renewal_interest: 'maybe', reason: 'Asked about plans; will think about it' });
      }
      agent("I don't have the latest plan prices. The gym team can tell you.");
      member('Okay.');
      agent('Thank you for your time!');
      return finish(base, t, { ...res, outcome: 'question_open', renewal_interest: 'maybe', unanswered_question: 'What are your membership plans?', reason: 'Asked about membership plans' });
    }
    case 'wants_person':
      member('I want to talk to the gym owner about the charges.');
      await tool('request_person', { reason: 'membership charges' });
      agent('Of course. Someone from the gym will call you back soon. Thank you!');
      return finish(base, t, { ...res, outcome: 'callback_requested', renewal_interest: 'unknown', reason: 'Wants to discuss membership charges with the owner' });
    case 'stop':
      member('Please stop calling me.');
      await tool('stop_calls', {});
      agent("I'm sorry about that. You won't get these calls again. Goodbye.");
      return finish(base, t, { ...res, outcome: 'opted_out', reason: 'Asked not to be called again' });
    case 'not_understood':
      member('[unclear]');
      agent("Sorry, I didn't catch that. Could you say it again?");
      member('[unclear]');
      agent('I will let the gym team reach you another time. Goodbye.');
      return finish(base, t, { ...res, understood: false, outcome: 'no_conversation' });
    case 'callback_tomorrow':
    case 'busy_callback':
    default: {
      const first = pick.scenario === 'callback_tomorrow' ? 'Can you call me tomorrow evening?' : 'Call me next Monday.';
      if (pick.scenario !== 'callback_tomorrow') {
        member('Yes, but I am busy right now.');
        agent('No problem. Would you like me to call you later?');
      }
      member(first);
      const bare = first.replace(/[.?]$/, '');
      const answers = [first, `${bare} at 6 PM`, `${bare} at 11 AM`];
      let r = null;
      for (let i = 0; i < answers.length; i++) {
        r = await tool('schedule_callback', { when_text: answers[i], reason: 'busy during the call' });
        if (r.status === 'scheduled') break;
        if (r.status !== 'need_more') break;
        agent(r.ask);
        member(i === 0 ? '6 PM.' : '11 AM then.');
      }
      if (r?.status === 'scheduled') {
        agent(`Perfect. I'll call you ${r.when}. Have a great day!`);
        return finish(base, t, { ...res, outcome: 'callback_requested', renewal_interest: 'yes', reason: 'Busy during the call; asked to be called back' });
      }
      agent('I could not book that time. Someone from the gym will reach you. Thank you!');
      return finish(base, t, { ...res, outcome: 'other', renewal_interest: 'maybe', reason: 'Wanted a call back at a time the gym does not call' });
    }
  }
}

function finish(base, transcript, analysis, seconds = null) {
  const duration = seconds ?? Math.max(20, transcript.length * 7);
  let at = 0;
  const timed = transcript.map((x) => { const row = { ...x, secs: at }; at += Math.round(duration / Math.max(1, transcript.length)); return row; });
  return { ...base, status: 'completed', duration, transcript: timed, outcome: analysis.outcome, summary: analysis.reason || null, ...analysis };
}

export const _test = { roll };
