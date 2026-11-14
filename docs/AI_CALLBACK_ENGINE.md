# The call-back engine

"Call me next Monday at 6" becomes a real call at that time. This page covers
how the time is understood, how the call back is stored and run, and what the
owner can do with it.

Code: `backend/src/services/followups/when.js` (understanding the time),
`callbacks.js` (booking and running), `conversations.js` (the agent's
`schedule_callback` tool), `engine.js` (the tick and dispatch). Tests:
`backend/test/followupsWhen.test.js`, `followupsAiCalls.test.js`,
`followupsPg.test.js` (the race on real Postgres).

## 1. Understanding the time (`when.js`)

The agent passes the member's own words (`when_text`) and, if it is sure, its
own reading as `date` and `time`. The server decides: the words win, and the
model's fields only fill what the words did not say. So the model's date
arithmetic can never book the wrong day.

| The member says | Result (on Thursday 12 November, 2:30 PM, gym open Mon-Sat 10:00-19:30) |
|---|---|
| tomorrow at 6 PM | Friday 13 November, 18:00 |
| next Monday | Asks: "What time on Monday 16 November suits you? We call between 10 AM and 7:30 PM." |
| next Monday at 6 | Monday 16 November, 18:00 (a bare 1-7 means PM) |
| after three days | Sunday is closed: "We do not call on Sundays. Would Monday 16 November work instead?" |
| after five days | Asks for a time on Tuesday 17 November |
| in the evening | Today, around 6 PM (the next open day if that has passed) |
| after 7 PM / after 8 PM | 19:00 / "We can only call between 10 AM and 7:30 PM..." |
| on the 20th, 20 November, Nov 20, 20/11 | 20 November (next month if the day has passed this month) |
| first day of next month | 1 December |
| next week, next month, after my vacation, later | Asks: "Which day next week suits you?" / "Which date should we call you on?" |
| kal shaam 6 baje, parso subah 11 baje | Tomorrow 18:00 / day after tomorrow 11:00 |
| today at 2:35 PM | Too soon: "That time is too soon. What later time suits you?" |
| in 90 days | Too far: up to 60 days ahead |

Rules: at least 15 minutes ahead, at most 60 days; on a day the gym calls;
inside calling hours (never before 09:00 or after 21:00 whatever the gym set).
Local time is converted to UTC with the gym's IANA timezone in two passes, so a
daylight-saving change is handled (tested with Europe/London; India has none).

## 2. Booking (`scheduleCallback`)

A call back is a `followup_callbacks` row. It is the same table as the staff
call-back queue, with a `mode`:

| mode | Who calls | Lifecycle |
|---|---|---|
| `human` | A person from the gym | new → assigned → in_progress → completed / unreachable / cancelled |
| `agent` | The AI, in the same agent and language | scheduled → processing → completed / scheduled (retry) / failed / cancelled / expired |
| `call` | A recording or voice message plays | same as `agent` |

Booked from an AI call, it stores the conversation, the original call (`job_id`),
the agent, the timezone, the member's words (`requested_time`), the context
the AI will open with ("On 12 November the member asked to be called back
Monday 16 November at 6 PM (busy at work, wants to renew)"), the gym-local time
as said to the member (`scheduled_local`) and its UTC instant (`scheduled_for`).

- One booked call back per member: a newer request replaces an older one
  (`replaced` event).
- The same call booking again (the member changed their mind) moves its own
  booking (`rescheduled` event), never adds a second.
- While a call back is booked, campaigns leave that member alone
  (`callback_scheduled` in the planner).
- A call back is a service contact: it never grants permission for promotions.

## 3. Running it

The scheduler tick (`tickOrg`: sweep → **call backs** → campaigns → dispatch)
calls `queueDueCallbacks` for each gym:

1. **Expire** any call back more than 2 hours past its time that was never
   placed (the scheduler was down or the gym was switched off). It is marked
   `expired` with "Not placed within 2 hours of 2026-11-16 18:00. Call the member
   yourself or book a new time." Calling much later than the member asked would
   be wrong.
2. Only when the gym is switched on and inside calling hours (and the platform is
   not paused), take the due ones (`scheduled_for <= now`).
3. **Claim** each with a conditional update (`status 'scheduled' → 'processing'`,
   `attempts + 1`). A worker whose update changes nothing moves on.
4. **Check** the member again: still active, valid number, calls not stopped or
   refused, not a wrong number. A member who now wants a person only gets a
   staff call back instead (`handed_to_staff`).
5. **Queue** an ordinary job with `dedupe_key = cb:<id>:<attempt>`. That key is
   UNIQUE, so even two workers that both claimed it could not create two calls.
   The job carries the original situation (`cycle_key`) and the agent's context.
6. **Dispatch** places it like any call: consent re-checked, minutes held, the
   same agent or recording. Two differences from campaign calls:
   - it is placed even if its campaign was paused or deleted since (the member asked);
   - the member's general "best time" and the staff call-back pause do not apply
     (the member chose this time).
   It is dropped (cancelled, with the reason) if its situation is gone: the
   member visited, renewed or paid since asking (`schedule.situationKey`). This is
   checked on the situation, not the campaign step, so a membership that ended
   yesterday between two reminder steps still gets its call back.

When the call ends, `syncCallbackFromJob` moves the call back (only from
`processing`, only for the job it is waiting on, so duplicates change nothing):

| The call | The call back |
|---|---|
| connected | `completed` |
| no answer, busy, failed | `scheduled` again one hour later (or at the asked time on the next open day if that is past calling hours), up to `max_attempts` (2); then `failed`: "No answer after 2 attempts. Call the member yourself." |
| skipped: member stopped calls, wrong number, renewed/visited/paid | `cancelled`, with the reason |
| skipped: no minutes left | `failed`: "...Buy more and book it again, or call the member yourself." |

Every step is appended to `events_json` with the time and who did it, for
example `scheduled > queued > retry > queued > failed`. Restarts lose nothing:
the state is all in rows, and a job left mid-call is reconciled by the existing
sweep (which also closes its conversation as failed).

## 4. The owner's controls

Screen: AI Communication → Call backs (`Callbacks.jsx`): **Booked**, **For your
team**, **Finished**, plus **Book a call back** for any member who allows calls.

| Action | API | Rules |
|---|---|---|
| See booked call backs | `GET /api/followups/callbacks?view=scheduled` | With the time as said to the member, who calls, the conversation summary, attempts and trail |
| Change the time | `PUT /callbacks/:id/schedule {date, time}` | Validated like a member's request (future, open day, calling hours); resets attempts |
| Change who calls | `PUT /callbacks/:id/mode {mode, agent_id?, recording_id?}` | To a person: moves to the staff queue. To the AI or a recording: needs an active agent or recording of this gym |
| Cancel | `POST /callbacks/:id/cancel` | Not while it is being placed |
| Call now | `POST /callbacks/:id/call-now` | Only inside calling hours with the feature on; then queued and dispatched at once |
| Book one | `POST /callbacks {client_id, date, time, mode, ...}` | The member must allow calls and not be person-only |
| Finished | `GET /callbacks?view=done` | Last 60 days |

Every owner change is also written to `followup_audit`. A member who turns calls
off in the app cancels their booked call backs.

## 5. Guarantees, and how they are tested

| Guarantee | Test |
|---|---|
| The AI confirms a call back only after the server booked it | `AI 3+5` checks the tool trail `need_more, scheduled` and the confirmation line |
| A call back keeps its calling mode | `AI 3+5`, `call back: due -> queued once as an AI call...`, `a scheduled call back can play a recording` |
| Never placed twice | `AI 18` (three racing workers, SQLite) and `concurrency: 12 scheduler workers racing for one due call back` (real Postgres pool) |
| Retries, then a failure the owner can act on | `AI 17` |
| Not placed late, not placed outside hours | `call back: outside calling hours it waits; more than 2 hours late it expires` |
| Dropped when no longer needed; kept when its campaign is paused | `call back: dispatch places it even if the campaign was paused...` |
| Owner controls validated, logged, audited, isolated | `owner controls...`, `isolation: gym B cannot read or change gym A's...` |
| Times understood, including clarification | `followupsWhen.test.js` (21 tests, DST included) |
