# AI Communication: audit of the existing system

Audited on 12 November 2026, on branch `feat/ai-communication` at `64af9d9`, before
any AI Communication 2.0 work. Everything below was checked in the code, and the
items marked "working" were also exercised in the local test-mode demo the same day
(two campaigns, 13 simulated contacts, billing, call backs, founder console).
A button existing was not treated as evidence that a feature works.

Production state: `main` carries the Phase 2 fixes, but **none of the `followup_*`
tables exist in the production database yet** (the migration is paused). New columns
and constraints can therefore go straight into `database/schema.sql`; existing
development databases are upgraded by `backend/scripts/init-db.js`.

## How the system is built

| Layer | Where | What it does |
|---|---|---|
| Engine | `backend/src/services/followups/engine.js` | `tickOrg` = sweep → plan → dispatch. Plans one job per member, campaign step and channel (`followup_jobs`, unique `dedupe_key`), re-checks every gate at dispatch, places the call or message, applies provider results. |
| Schedules | `services/followups/schedule.js` | Pure: is a step due today for this member (`missed_visits`, `membership_ending`, `payment_due`, `onboarding`). |
| Consent | `services/followups/consent.js` | `evaluate()` ALLOW / DENY / DEFER per member and channel; append-only `followup_consent_log`. |
| Billing | `services/followups/wallet.js`, `orders.js` | Per-product balances, hold → settle → release, idempotent ledger (`ux_followup_ledger_job_reason` + row lock), test checkout. |
| Content | `services/followups/studio.js`, `render.js`, `languages.js` | Voice/SMS/WhatsApp messages with versions and approval, AI agents with versions, human call backs. |
| Providers | `services/followups/providers/*` | Provider-neutral interfaces: speech (ElevenLabs, Sarvam, self-hosted HTTP), telephony/SMS/WhatsApp (Exotel), conversation (ElevenLabs Agents, self-hosted HTTP), and `mock.js` for test mode. |
| Audio | `services/followups/audio.js` | TTS audio cached per gym in `followup_audio` (base64, pruned after 14 days), served to Exotel by signed URL. |
| API | `backend/src/routes/followups.js` | Public hooks (Exotel gather/keypress/status/SMS/WhatsApp, ElevenLabs post-call, cron tick, audio) and the owner, member (`/me`) and trainer (`/trainer/callbacks`) APIs. |
| Founder API | `backend/src/routes/consoleFollowups.js` | Setup, health, price book, gyms, numbers, adjustments, platform pause. |
| Owner UI | `frontend/src/components/trainer/comms/*` | Overview, Campaigns, Messages, Voices & AI agents, Members, Call backs, History, Plans & usage, Settings. |
| Member UI | `frontend/src/components/client/GymContactPrefs.jsx` | Per-channel switches, person-only, language, best time. |
| Founder UI | `admin/src/pages/Communication.jsx`, `CommunicationGym.jsx` | Gyms, Operations, Price book, Setup; one gym's balances, numbers, ledger, orders, owner changes. |
| Tests | `backend/test/followups*.test.js` | 59 tests; the whole suite also runs on PostgreSQL (`TEST_DATABASE_URL`) including concurrency and RLS. |

The two pipelines that exist today:

- **Voice message call** (`channel = 'call'`): queue → `placeJob` → TTS of the owner's text
  (`buildVoiceMessage` wraps it with the "automated call from {gym}" notice and the keypad
  menu) → Exotel call into a Programmable Gather flow → `/hooks/exotel/gather` serves the
  audio → `/hooks/exotel/keypress` (1 = person, 2 = on it, 9 = stop) → `/hooks/exotel/status`
  settles the minute hold.
- **AI conversation** (`channel = 'agent'`): queue → `ensureProviderAgent` (creates or updates
  the ElevenLabs agent from `agentPrompt`) → ElevenLabs `convai/exotel/outbound-call`
  (ElevenLabs runs speech recognition, the language model and speech in real time) →
  `post_call_transcription` webhook → `applyAgentResult` settles minutes and maps one
  `outcome` field.

## Classification

### Fully implemented and working

| Feature | Files | Tables | Notes |
|---|---|---|---|
| Campaign engine (4 trigger kinds, sequences, retries per day, gaps, smart stops) | `engine.js`, `schedule.js` | `followup_rules`, `followup_jobs` | Verified in the demo and 59 tests. |
| Consent, opt-outs, person-only, pauses, wrong-number suppression, daily/weekly caps, calling hours (09:00–21:00 hard limit) | `consent.js`, `engine.js` | `followup_member_prefs`, `followup_consent_log` | Checked at planning and at dispatch. |
| Prepaid balances, hold/settle/release/refund, idempotent ledger, spending cap, per-campaign budget | `wallet.js` | `followup_balances`, `followup_ledger` | Duplicate and concurrent webhooks proven safe on Postgres. |
| Orders and test checkout | `orders.js` | `followup_orders` | No money moves in test mode; sales closed in `off` mode. |
| Script Studio (voice and SMS text, versions, approval, AI draft/translate when an AI key is set) | `studio.js` | `followup_scripts`, `followup_script_versions`, `followup_sms_templates`, `followup_templates` | |
| Human call backs (keypad 1, AI `callback_requested`, WhatsApp "Call me"), assignment, trainer view | `studio.js`, `routes/followups.js`, `People.jsx`, `CallbackCard.jsx` | `followup_callbacks` | Automated contact pauses while one is open. |
| Member preferences in the app | `routes/followups.js` (`/me`), `GymContactPrefs.jsx` | `followup_member_prefs` | |
| Owner audit trail | `audit.js` | `followup_audit` | |
| Founder console: gyms, health, price book, numbers, adjustments, platform pause | `consoleFollowups.js`, admin pages | `followup_price_versions`, `followup_platform`, `followup_numbers` | |
| Gym isolation | `orgScope` on every owner route; `database/rls.sql` | 20 `followup_*` tables with `tenant_isolation` | RLS tested on Postgres. |

### Implemented but incomplete

| Feature | What exists | What is missing |
|---|---|---|
| Interactive AI calls | Real two-way ElevenLabs agents through Exotel; prompt with the owner's facts and FAQs; post-call result. | No tools during the call: the agent cannot schedule a call back, record a request for a person, record "stop calling" or "wrong number" while talking. It only reports one `outcome` and one `reason` afterwards. No transcript is kept. No identity check before membership details are mentioned. The gym's real plan prices (`packages`) are not available unless the owner retypes them. No owner settings for tone, call length, or turning call backs / hand-over / plan questions on or off. |
| Call backs | Human call-back queue with statuses `new/assigned/in_progress/completed/unreachable/cancelled`. | `requested_time` is free text nobody reads. There is no scheduled automated call back, no date/time understanding, no executor, no retry, no reschedule, no mode change, no "call now". |
| Conversation summaries | `followup_jobs.summary` holds the provider's one-line `reason` or its transcript summary. | Not structured (intent, renewal interest, questions, objections, owner action). Not written for calls without that field, and nothing marks an incomplete conversation as incomplete. |
| Voice message calls | TTS from approved text, keypad menu, minute billing. | No uploaded recordings, no audio library, no preview of a recording. |
| Usage reporting | Per gym and per product unit (founder); per campaign spend in `/analytics`. | Not split by calling mode, campaign or billing period in the console; no call-back counts. |

### Frontend only

None found. Every owner, member and founder screen calls a working endpoint.

### Backend only

| Feature | Where | Notes |
|---|---|---|
| Campaign analytics (contacts, connections, responses, visits/renewals after contact) | `GET /api/followups/analytics` | No screen uses it. |
| Self-hosted speech and agent servers | `providers/http.js` | Configured by environment only, by design. |

### Mocked / simulated

| Feature | Where | Notes |
|---|---|---|
| Calls, SMS, WhatsApp in test mode | `providers/mock.js` | Deterministic outcomes per job id; nothing leaves the server. |
| AI conversations in test mode | `mock.conversation` | No conversation happens: an outcome and a canned reason are picked by hash. Call backs, escalation and summaries are therefore not exercised. |
| Checkout in test mode | `orders.js` + frontend test checkout | Same signature verification as live. |

### Completely missing

- Uploaded recordings and a reusable audio library (upload, validate, preview, archive).
- Natural-language call-back times ("next Monday at 6 PM") and a persistent scheduler that places the call back at that time with the original mode.
- Owner screens to view, reschedule, re-mode, cancel and trigger scheduled call backs.
- Conversation history: structured outcome, owner action, transcript with retention.
- Broadcast campaigns for one-off announcements (holiday closures, events, offers) to a chosen group on a chosen day.
- Separation of service and promotional calls, and a separate permission for promotional contact.
- Voicemail detection (Exotel's Gather flow does not report it; see the deployment notes).

### Implemented but requires security or compliance fixes

| Issue | Risk | Fix planned |
|---|---|---|
| The agent is told to confirm "you will not be called again" and "someone will call you back", but both are recorded only from the post-call webhook. | If that webhook is lost or late, a member who asked to stop can be called again, and a promised call back never exists. | Record both through tools during the call, and again from the post-call result (idempotent). |
| The owner can replace the opening line, and the prompt only says to admit being an AI "if asked". | An owner could remove the AI disclosure. | The disclosure becomes a fixed rule of the prompt and is checked in the opening line. |
| The agent may discuss membership details with whoever answers. | Disclosure to a family member or a recycled number. | Identity check before any membership detail; wrong-number tool. |
| A call back requested by a member could be read as general permission. | Promotional calls on the back of a service request. | Call backs are tied to their own request; promotional campaigns need a separate permission. |

## Plan

1. **Call-back engine**: extend `followup_callbacks` (mode, scheduled time, timezone, attempts,
   context, events) instead of adding a parallel table; a pure resolver for spoken times
   (`when.js`); execution through the existing tick and `followup_jobs` (a unique
   `dedupe_key` per call-back attempt makes double execution impossible).
2. **Interactive AI**: agent tools (`schedule_callback`, `request_person`, `stop_calls`,
   `wrong_number`) served by a signed tool endpoint; a `followup_conversations` record per AI
   call with structured outcome, a deterministic one-to-two-line summary, transcript and
   retention; agent settings (tone, length, toggles, plan answers from `packages`); a test-mode
   conversation simulator that drives the same tools.
3. **Prerecorded calls**: `followup_recordings` library (validated 8 kHz mono WAV, converted in
   the browser from MP3/M4A/OGG/WAV/WebM), playback inside the existing Exotel flow with the
   fixed notice and keypad menu.
4. **Owner screens**: a clear choice between the two calling modes, recordings library,
   call-back manager, conversation history; announcement campaigns with a promotional flag.
5. **Founder usage** by mode, campaign, period and call-back status.
6. **Tests** on SQLite and PostgreSQL, then documentation.
