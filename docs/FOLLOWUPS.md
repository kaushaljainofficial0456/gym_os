# Follow-ups: automated calls and WhatsApp to members

Gym owners set up **automations** that follow up with members by **phone call**
(an AI voice reading the owner's message, or a two-way AI conversation) and/or
**WhatsApp**. Each automation is triggered by a condition the owner picks:

| Automation | Fires when | Stops by itself when |
|---|---|---|
| Stops coming (`missed_visits`) | no visit for N days, then every K days, up to M contacts | the member visits again |
| Membership ending (`membership_ending`) | chosen days before the end date (e.g. 4, 2, on the day), then every K days after it, up to M times | the member renews |
| Payment pending (`payment_due`) | a membership is unpaid: every K days, up to M contacts | the payment is recorded |

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
- Every ledger row carries the job, the provider reference, the platform's cost estimate and the price-book version.

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
cron (every 5 min) / owner opens Follow-ups
        │
        ▼
  engine.tick ──► plan: who is due today?  (schedule.js, pure)
        │            gates: permission, phone, hours, caps, snoozes, balance
        ▼
     followup_jobs (queued) ──► dispatch: charge a unit, render the message,
                                          make the audio (ElevenLabs), place the call
                                          (Exotel) or send the WhatsApp (Exotel)
        ▲
        └── webhooks: Exotel call status + keypad, WhatsApp status + replies,
                      ElevenLabs post-call results (AI conversations)
```

- `backend/src/services/followups/`:
  - `schedule.js` decides which step of an automation is due for one member (pure, unit-tested).
  - `engine.js` plans, gates, dispatches and applies outcomes.
  - `wallet.js` holds balances, the ledger and the price book.
  - `orders.js` handles pack purchases (Razorpay, own order table).
  - `providers/` contains `exotel.js`, `elevenlabs.js` and `mock.js`.
- `backend/src/routes/followups.js`:
  - the owner API
  - the public webhooks, audio and cron endpoints
  - the member's own permission switch
- `frontend/src/pages/trainer/FollowUps.jsx`: the owner's tab (Overview, Automations, Plans, Settings).

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

5. **Scheduler**: call `GET https://<host>/api/followups/cron/tick` with header
   `Authorization: Bearer <CRON_SECRET>` every 5 minutes (cron-job.org, or Vercel
   Cron on a plan that allows it).
6. **Price book**: in the admin console (Follow-ups), enter the real per-unit
   costs from your Exotel, ElevenLabs and Meta invoices. Every pack shows its cost
   and margin. The defaults are estimates from public price lists (2026) and must
   be checked.
7. **Production database**: `npm run db:init` with the production `DATABASE_URL`
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
