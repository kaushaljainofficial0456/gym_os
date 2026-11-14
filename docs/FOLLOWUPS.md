# Follow-ups: automated calls and WhatsApp to members

> **AI Communication 2.0** (November 2026) adds prerecorded calls from the gym's
> own recordings, interactive AI conversations that book call backs at the time
> the member asks for, a conversation history with server-written summaries,
> announcements, and a separate permission for promotional contact. See
> [AI_COMMUNICATION_ARCHITECTURE.md](AI_COMMUNICATION_ARCHITECTURE.md),
> [AI_CALLBACK_ENGINE.md](AI_CALLBACK_ENGINE.md),
> [AI_COMMUNICATION_DEPLOYMENT.md](AI_COMMUNICATION_DEPLOYMENT.md) and
> [AI_COMMUNICATION_TEST_REPORT.md](AI_COMMUNICATION_TEST_REPORT.md). The audit
> it started from is [AI_COMMUNICATION_AUDIT.md](AI_COMMUNICATION_AUDIT.md). This
> page remains the product spec and operator guide.

Gym owners set up **automations** that follow up with members by **phone call**
(an AI voice reading the owner's message, or a two-way AI conversation) and/or
**WhatsApp**. Each automation is triggered by a condition the owner picks:

| Automation | Fires when | Stops by itself when |
|---|---|---|
| Stops coming (`missed_visits`) | no visit for N days, then every K days, up to M contacts | the member visits again |
| Membership ending (`membership_ending`) | chosen days before the end date (e.g. 4, 2, on the day), then every K days after it, up to M times | the member renews |
| Payment pending (`payment_due`) | a membership is unpaid: every K days, up to M contacts | the payment is recorded |
| New member not in yet (`onboarding`) | N days after joining without a first visit, then every K days, up to M contacts | the member's first visit |

A campaign can run a **sequence** of channels on each contact day (for example
WhatsApp, then a call if there is no reply after 4 hours), stopping at the first
response.

The feature is an **add-on bought separately** from the gym's capacity package,
from the owner's **AI Communication** tab (Plans & usage). Every product has its
own balance; calls come in **quality tiers**, each run by a different provider and
priced from its own real cost:

| Balance | What it buys | Default provider |
|---|---|---|
| `voice:premium` | AI voice calls, most natural voice: "for renewals and important calls" | ElevenLabs |
| `voice:standard` | AI voice calls, natural Indian voices: "great for everyday reminders" | Sarvam |
| `voice:basic` | AI voice calls, low cost: "good for routine, less important calls" | your own model (IndicF5) |
| `agent:advanced` | two-way AI conversations, most human-like | ElevenLabs Agents |
| `agent:standard` | two-way AI conversations, simple check-ins | your own agent |
| `sms` | SMS, by billable segment (GSM-7 160/153, Unicode 70/67) | Exotel (DLT) |
| `whatsapp` | approved WhatsApp templates | Exotel |
| caller lines | the gym's own numbers, for N days | Exotel ExoPhones |

Tiers (name, tagline, provider, cost) live in the founder's **versioned price book**,
so they can be added or moved between providers from the admin console. A tier whose
provider is not configured is shown as "coming soon" and cannot be bought.

**Billing rules:**
- A call **holds** capacity when it is placed and **settles** on the provider's result, by connected minute. An unanswered call costs nothing.
- An SMS is charged per actual segment, and a WhatsApp message per message. Either is refunded once if the provider reports a failed delivery.
- Revenue is recognised as usage happens, at the value the gym paid. Unused balance is unearned (deferred) value.
- Every usage and refund row carries the job, the provider reference, the platform's cost estimate and the price-book version.
- **Exactly once.** A job has at most one hold, one release, one usage and one refund row: enforced by a
  unique index (`ux_followup_ledger_job_reason`) under a row lock on the job, so duplicate or concurrent
  provider callbacks can never charge, release or refund twice. Balances cannot go below zero (a CHECK
  under the conditional updates).
- **A verified payment always credits.** An order the owner closed (UPI still finishing) or whose first
  attempt failed is still activated by a verified payment for it, exactly once.
- **An answered call is never billed at zero.** A "completed" callback without a duration keeps its hold;
  the duration is taken from the provider's own record (Exotel Call Details API) by the sweep. If the
  provider never reports one within an hour, the 1-minute minimum pulse is charged and the job says so.
- The admin console's Operations tab reconciles every balance against the sum of its ledger rows and
  raises a critical alert on any difference.

## How a member is protected

These are enforced by the engine. No owner setting can turn them off.

- **Permission first.** A member is contacted only after they agreed: they turn on
  "Calls & WhatsApp from my gym" in the app, or the owner records that the member
  agreed (e.g. on the membership form), with an attestation. Required for robocalls
  under TRAI's TCCCPR and for WhatsApp business messages under Meta's policy.
- **Always a way out.** Every call says it is automated and from which gym, and
  offers "press 9 to stop these calls". WhatsApp templates carry a "Stop messages"
  button and STOP replies are honoured. A stopped member is never contacted again
  until they turn it back on themselves.
- **One recognisable number.** Each gym calls from one registered business line
  (its own ExoPhone, or the platform's). The engine never switches numbers to get
  past a member who blocked or ignored the gym. Under TRAI's 2024-25 directions,
  10-digit numbers are banned for business robocalls, and using them gets every
  number disconnected and the business blacklisted across all operators.
- **Hours and caps.** Calls only inside the gym's calling hours, which are limited
  to 09:00-21:00 in the gym's timezone and to the days the owner allows. The owner
  chooses 1-3 automated calls per member per day; a member can be capped lower or
  paused individually. At most one WhatsApp message per member per day.
- **Smart stops.** A visit, renewal or payment ends that automation for the member
  immediately. "I'm on it" (keypad 2 / quick reply) snoozes that automation for a
  few days. "Call me" (keypad 1) puts the member in the owner's *Needs your
  attention* list, so a person calls back.

## Providers are interchangeable

The engine talks to five provider-neutral interfaces
(`backend/src/services/followups/providers/index.js`):

- **speech**: text to phone audio, and voices
- **telephony**: voice-message calls into the keypad flow
- **conversation**: two-way AI agents
- **SMS**
- **WhatsApp**

Swapping a vendor (ElevenLabs → Sarvam → IndicF5 → your own model, or Exotel →
another carrier) means adding an adapter and changing an environment setting. The
engine does not change.

Voice ids are provider-qualified (`sarvam:priya`, `elevenlabs:…`, `http:…`), so
several speech engines run at once and each voice reaches its own engine. Test mode
is a set of mock adapters that return their outcome at once (`simulated`), applied
exactly like a webhook.

**Your own models** plug in over plain HTTP (`providers/http.js` documents the
contract):
- Set `FOLLOWUP_SPEECH_HTTP_URL` for a speech server: `GET /voices`, and `POST /synthesize` returning WAV.
- Set `FOLLOWUP_AGENT_HTTP_URL` for an agent server: `PUT /agents`, `POST /calls`, and results posted to `/api/followups/hooks/agent/http`, signed with `FOLLOWUP_HTTP_TOKEN`.

Other switches:
- `SARVAM_API_KEY` enables Sarvam speech (Bulbul; `SARVAM_TTS_MODEL`, default `bulbul:v3`).
- `FOLLOWUP_AGENT_PROVIDER` chooses who runs new agents.

## Moving parts

```
cron (every 5 min) / owner opens AI Communication (test mode)
        │
        ▼
  engine.tick ──► plan: who is due today?  (schedule.js, pure)
        │            gates: permission, phone, hours, caps, snoozes, balance
        ▼
     followup_jobs (queued) ──► dispatch: hold or charge a unit, render the message,
                                          make the audio (the tier's speech engine),
                                          place the call (Exotel) or send the SMS /
                                          WhatsApp (Exotel)
        ▲
        └── webhooks: Exotel call status + keypad, WhatsApp status + replies,
                      ElevenLabs post-call results (AI conversations)
```

- `backend/src/services/followups/`:
  - `schedule.js` decides which step of an automation is due for one member (pure, unit-tested).
  - `engine.js` plans, gates, dispatches and applies outcomes.
  - `wallet.js` holds balances, the ledger and the price book.
  - `orders.js` handles pack purchases (Razorpay, own order table).
  - `consent.js` decides whether a member may be contacted on a channel right now, and keeps the consent log.
  - `numbers.js` pins each member to one of the gym's caller lines.
  - `studio.js`, `languages.js` and `render.js` hold scripts, agents, the 10 languages and message rendering.
  - `providers/` contains `exotel.js`, `elevenlabs.js`, `sarvam.js`, `http.js` (your own models) and `mock.js` (test mode).
- `backend/src/routes/followups.js`:
  - the owner API
  - the public webhooks, audio and cron endpoints
  - the member's own permission switch, and trainers' call backs
- `backend/src/routes/consoleFollowups.js`: the founder's API, mounted at `/api/console/communication`
  behind the console's SUPER_ADMIN gate (price book, per-gym usage and margin, numbers, adjustments,
  platform pause). Every change is audited.
- `frontend/src/pages/trainer/Communication.jsx`: the owner's AI Communication tab. Each section is a
  file under `frontend/src/components/trainer/comms/` (Overview, Campaigns, Messages, Voices & AI agents,
  Members, Call backs, History, Plans & usage, Settings).
- `frontend/src/components/client/GymContactPrefs.jsx`: the member's own switches.
- `admin/src/pages/Communication.jsx` and `CommunicationGym.jsx`: the founder's AI Communication screens
  in the admin console (Gyms, Price book, Setup; and one gym's numbers, sender, adjustments and ledger).

### Modes

| Mode | When | What happens |
|---|---|---|
| `live` | Exotel + ElevenLabs keys and the public URL are configured | real calls and messages |
| `test` | keys missing, outside production | calls and messages are simulated with realistic outcomes, so the whole flow can be tried |
| `off` | keys missing in production | owners can set things up; nothing is sent |

Voice previews ("Hear it") use ElevenLabs whenever `ELEVENLABS_API_KEY` is set,
in any mode.

## Going live (operator checklist)

1. **Exotel**
   - Complete business KYC.
   - Rent the caller line(s), using a registered commercial series as Exotel advises for automated calls.
   - Enable the WhatsApp Business API and create the WABA.
2. **Exotel call flow** (once): in App Bazaar, create a flow:
   - *Programmable Gather*, URL `https://<host>/api/followups/hooks/exotel/gather`
   - then *Passthru*, URL `https://<host>/api/followups/hooks/exotel/keypress`
   - then *Hangup*
   - Note the flow's app id.
3. **ElevenLabs**
   - Create an API key.
   - For AI conversations:
     - Import the Exotel number under Agents, Phone numbers, and note its phone number id.
     - Add a post-call webhook to `https://<host>/api/followups/hooks/elevenlabs`, and note its secret.
4. **Vercel environment** (Production):

   | Variable | Value |
   |---|---|
   | `FOLLOWUP_PROVIDER` | `exotel` |
   | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` | your Exotel credentials |
   | `EXOTEL_SUBDOMAIN` | `api.in.exotel.com` |
   | `EXOTEL_CALLER_ID` | default ExoPhone |
   | `EXOTEL_FLOW_APP_ID` | the flow's app id |
   | `EXOTEL_WHATSAPP_FROM` | default WhatsApp sender |
   | `EXOTEL_WABA_ID` | your WABA id |
   | `ELEVENLABS_API_KEY` | your ElevenLabs key (Premium voice, Advanced agents) |
   | `SARVAM_API_KEY` | your Sarvam key (Standard voice), optional |
   | `ELEVENLABS_AGENT_PHONE_ID` | the imported number's id |
   | `ELEVENLABS_WEBHOOK_SECRET` | the post-call webhook secret |
   | `PUBLIC_BASE_URL` | `https://<host>` |
   | `CRON_SECRET` | already used by the access tick |

5. **Admin console** (AI Communication, Setup tab): check the mode is `live`, and copy the
   webhook URLs from there (the WhatsApp one is signed). Then, on the Gyms tab, open each gym
   that rented a line and assign its ExoPhone under *Caller numbers*, and its WhatsApp sender.
6. **Scheduler**: call `GET https://<host>/api/followups/cron/tick` with header
   `Authorization: Bearer <CRON_SECRET>` every 5 minutes (cron-job.org, or Vercel
   Cron on a plan that allows it).
7. **Price book**: in the admin console (AI Communication, Price book tab), enter the real
   per-unit costs from your Exotel, ElevenLabs, Sarvam and Meta invoices. Every pack shows its
   cost, pre-tax price and markup as you type, and one below cost plus margin is flagged.
   Saving creates a new version; orders keep the version they were sold at. The defaults are
   estimates from public price lists (2026) and must be checked.
8. **Production database**: `npm run db:init` with the production `DATABASE_URL`
   (new tables). The deploy's `db:check` refuses to go live until this is done.

### Things to verify on the live account

The adapters follow Exotel's and ElevenLabs' public docs. A few details could not
be confirmed there and are handled defensively (and logged) until checked on a
real account:

- Exotel's status-callback field names (we read `CallSid`/`Sid`, `Status`/`CallStatus`,
  `ConversationDuration`/`Duration`, `CustomField`).
- Exotel's `digits` format (we strip the surrounding quotes).
- Exotel's WhatsApp delivery and inbound-reply webhook shapes.
- The ElevenLabs webhook signature scheme (`t=<ts>,v0=<hmac-sha256 of "<ts>.<body>">`).
- Whether Exotel's inbound WhatsApp payload names the business number replied to (we read
  `to`). With it, a STOP is applied to the gym whose number the member replied to; without it,
  to the gym that messaged the member last.

## Queue operation

Every 5 minutes the scheduler calls `runAll`: gyms that are switched on are visited
**longest-waiting first** (`last_tick_at`), each within its share of the tick
(`FOLLOWUP_TICK_GYM_MS`, default 15 s) and the whole tick within `FOLLOWUP_TICK_BUDGET_MS`
(default 50 s -- keep it below the hosting function's time limit). For one gym, `tickOrg`:

1. **sweep** -- calls silent for 30 minutes and answered calls still waiting for a duration are
   reconciled from the provider's record (oldest 100 per tick); messages with no result are closed
   with nothing charged; anything queued for over 6 hours is skipped (never sent late);
2. **plan** -- who is due today, through every consent and cap gate -> `followup_jobs` rows
   (`dedupe_key` is unique, so overlapping ticks cannot double-queue);
3. **dispatch** -- up to `FOLLOWUP_DISPATCH_PER_TICK` (default 25) queued jobs are **claimed**
   (`UPDATE ... WHERE status = 'queued'`, so each job is placed by exactly one worker) and placed.

Immediately before a job is placed it is revalidated: platform and channel switches, the gym's
switch and calling hours (09:00-21:00 at most, its days), the job's day, the member's consent,
stop, human-only, pause, own window and pending call-back, **and that the step is still due** --
a visit, renewal or payment since planning skips it. Capacity is then held or charged atomically.

Crash recovery: a job claimed but never placed (process died) is released by the sweep after
30 minutes with nothing charged; queued jobs are simply placed by the next tick on the same day.
Retries are the campaign's own attempts per day, spaced by its gap; there is no blind retry loop.

Measured on PostgreSQL 17 (docs/AI_COMMUNICATION_PRODUCTION_READINESS.md): planning a gym of
8,000 members across 3 campaigns takes ~1.5-1.8 s, a dispatch pass ~0.15 s with a simulated
provider. At 25 per tick a gym places up to ~300 contacts an hour.

## Provider callback contracts

| Callback | Authenticated by | Fields read | Duplicates / order |
|---|---|---|---|
| Exotel call status | signed job token in the URL (`?j=`) and `CustomField`; Exotel does not sign callbacks | `CallSid`/`Sid`, `Status` (`completed`, `failed`, `busy`, `no-answer`), `ConversationDuration` / `DialCallDuration` / `Duration` / `Legs[].OnCallDuration` | a settled job ignores later statuses; "completed" without a duration waits for Call Details |
| Exotel Passthru (keypad) | signed job token | `digits` (first digit pressed; quotes stripped) | first key wins |
| Exotel Call Details (fallback, we call it) | Basic auth | `Call.Status`, `Call.Details.ConversationDuration`, `Call.Duration` | -- |
| Exotel SMS status | signed job token | `Status` (failures checked before "delivered": `undelivered` is a failure) | refunded once |
| Exotel WhatsApp | signed key `?k=` (copy from the admin console) | statuses by message id; replies `from`, `to`, text / button title | STOP is idempotent; replies scoped to the business number when `to` is present |
| ElevenLabs post-call | `ElevenLabs-Signature: t=..,v0=..` HMAC-SHA256 of `"<t>.<raw body>"`, 30-minute window, any matching v0 | `post_call_transcription` (duration, data collection, summary), `call_initiation_failure` (busy / no-answer / unknown); `post_call_audio` ignored | settles once; unsigned -> 401, signed but unreadable -> 400 |
| Your own agent server | `X-Followup-Signature`: hex HMAC-SHA256 of the raw body with `FOLLOWUP_HTTP_TOKEN` | `followup_job`, `call_id`, `status`, `duration_secs`, `outcome`, `summary` | unknown statuses are recorded as failed |

Webhooks are rate-limited per sender IP. Signed tokens in callback URLs are masked in the access
log (`backend/src/utils/redactUrl.js`).

## Security model

- Owner routes require `GYM_OWNER` (or `SUPER_ADMIN`), scope every query by the session's gym, and
  check every id taken from the URL or body belongs to that gym; members and trainers have their
  own narrow routes. The admin console API sits behind the console's SUPER_ADMIN gate and rate limit.
- Every follow-up table with `org_id` has a forced row-level-security policy (`database/rls.sql`);
  transactions run with `app.org_id` set. Platform-level tables (price book, platform switch) have none.
- Secrets live only in the environment. The browser gets booleans about what is configured, never keys.
- Owner changes (settings, compliance checklist, campaigns, number labels) are audited in
  `followup_audit`; founder changes in `admin_audit_logs`; consent in `followup_consent_log`.

## Testing

```bash
npm test --prefix backend                                         # everything, SQLite
TEST_DATABASE_URL=postgres://... node --test --test-concurrency=1 \
  backend/test/followups.test.js backend/test/followupsHardening.test.js backend/test/followupsPg.test.js
```

With `TEST_DATABASE_URL` the follow-up suites run unchanged on PostgreSQL, each test in its own
schema, plus concurrency (warm pool) and RLS tests that only a real server can run. Use a throwaway
UTF-8 database. CI runs this against its postgres:16 service. Provider tests use documented payload
shapes and stubbed HTTP: they prove the adapters, not a live account.

### Platform switch

The founder can pause all automated contact, or one channel, from the admin console
(AI Communication, Setup). While it is on nothing is placed, and every owner's Overview says
that Barbell has paused sending. Balances, campaigns and settings are untouched. A paused
channel drops what is queued on it; under a full pause queued contacts wait, and any not
placed within the gym's calling hours on the day they were due are dropped, never sent late.
