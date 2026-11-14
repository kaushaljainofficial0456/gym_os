# AI Communication 2.0: deployment and configuration

What has to happen, in order, to run prerecorded calls, interactive AI
conversations and scheduled call backs for real. Nothing on this page has been
done against a live provider account: every live step below is still to be
carried out and verified by someone with the accounts.

Related: [FOLLOWUPS.md](FOLLOWUPS.md) (the operator checklist for providers),
[AI_COMMUNICATION_ARCHITECTURE.md](AI_COMMUNICATION_ARCHITECTURE.md),
[AI_CALLBACK_ENGINE.md](AI_CALLBACK_ENGINE.md),
[AI_COMMUNICATION_TEST_REPORT.md](AI_COMMUNICATION_TEST_REPORT.md).

## 1. How the server decides what it may do

The mode is derived from configuration, never set by hand (`config.setupStatus`):

| Mode | When | Effect |
|---|---|---|
| `off` | Production without providers | Nothing is sent, nothing can be bought. This is the state after merging without provider accounts. |
| `test` | Not production, providers not configured | Calls and messages are simulated (`providers/mock.js`, `simulator.js`); checkout is a test checkout. Nothing reaches a phone. |
| `live` | `FOLLOWUP_PROVIDER=exotel`, Exotel credentials and flow, a speech provider, an https `PUBLIC_BASE_URL` | Real calls. |

Demo mode cannot place a real call: the simulator is only reachable through the
`test` conversation provider, which `providers/index.js` selects only in test
mode. The demo script used to fill the local demo (`scratchpad/demo/run-day.mjs`)
refuses to run unless the mode is `test`.

## 2. Database

Production has no `followup_*` table yet. The whole of AI Communication,
including 2.0, is one additive, idempotent migration, generated from
`database/schema.sql` and `database/rls.sql` of this branch:

- File: `ai-communication-migration.sql` (kept outside the repository, next to
  it, in the `barbell` folder). 24 tables, 28 indexes, row-level security on 22
  tables, grants for the `skos_app` runtime role.
- Rehearsed on 13 November 2026 on PostgreSQL 17: a fresh database built from
  `origin/main`'s schema, the migration run twice. Both runs returned the
  expected verification row.

Steps (database owner role):

1. In Neon, create a **backup branch** of production.
2. Run `ai-communication-migration.sql` in the SQL editor on production.
3. Check the verification row it prints: `tables 24 | rls_forced 22 | policies 22 | ledger_unique 1 | balance_checks 2 | runtime_role_can_use 24`.
4. Only then merge and deploy: the Vercel build runs `npm run db:check`, which
   fails if the schema is not in the database.

An environment that already ran the first version of AI Communication (a
development database, a staging copy) is brought up to 2.0 by `npm run db:init`:
`backend/scripts/lib/followupsUpgrade.js` adds the new columns before
`schema.sql` runs, then widens the two changed CHECK constraints
(`followup_rules.kind`, `followup_callbacks.status`). On SQLite that rebuilds the
two tables, keeping every row. This was run on the local demo database (2
campaigns, 1 call back, 13 calls before; all kept).

Rollback: the migration only adds tables and indexes. To undo it, restore the
Neon backup branch, or drop the `followup_*` tables (no other table references
them).

## 3. Environment variables

2.0 adds **no new variables**. The ones AI Communication uses (see
`.env.example`):

| Variable | For |
|---|---|
| `FOLLOWUP_PROVIDER=exotel`, `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`, `EXOTEL_CALLER_ID`, `EXOTEL_FLOW_APP_ID` | Calls (both modes), SMS |
| `EXOTEL_WHATSAPP_FROM`, `EXOTEL_WABA_ID` | WhatsApp |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_AGENT_PHONE_ID` | Interactive AI conversations; TTS voices |
| `SARVAM_API_KEY`, `SARVAM_TTS_MODEL` | Indian-language TTS |
| `FOLLOWUP_AGENT_PROVIDER`, `FOLLOWUP_AGENT_HTTP_URL`, `FOLLOWUP_SPEECH_HTTP_URL`, `FOLLOWUP_HTTP_TOKEN` | Your own agent or speech server instead of ElevenLabs |
| `PUBLIC_BASE_URL` | The https base every provider calls back (hooks, audio, agent tools) |
| `CRON_SECRET` | The scheduler tick |
| `FOLLOWUP_TICK_BUDGET_MS`, `FOLLOWUP_TICK_GYM_MS`, `FOLLOWUP_DISPATCH_PER_TICK` | Tick sizing |

The agent tools' key is derived from `JWT_SECRET`; it is never stored or printed.
Rotating `JWT_SECRET` changes it, and every agent is re-sent to the provider with
the new key on its next call (the key's fingerprint is part of the agent hash).

## 4. Interactive AI conversations (Mode B) on ElevenLabs

Needs: an ElevenLabs account with Conversational AI (Agents) and credits, the
Exotel integration in ElevenLabs, and each caller number imported there.

1. Set `ELEVENLABS_API_KEY` and `PUBLIC_BASE_URL`.
2. In ElevenLabs, add a **post-call webhook** to
   `https://<PUBLIC_BASE_URL>/api/followups/hooks/elevenlabs`, with transcription
   events, and put its signing secret in `ELEVENLABS_WEBHOOK_SECRET`.
3. Import each Exotel caller number into ElevenLabs and paste its phone-number
   id on the number in the founder console (or `ELEVENLABS_AGENT_PHONE_ID` for
   the shared line).
4. Nothing else is configured by hand: on a gym's first AI call the server
   creates the agent with its prompt, its four server tools
   (`https://<PUBLIC_BASE_URL>/api/followups/hooks/tools/<tool>`, header
   `X-Barbell-Tool-Key`, `followup_job` filled from the call's dynamic variable),
   the built-in `end_call` tool, and the after-call data fields. It updates the
   agent whenever any of that changes.

**To verify on the live account before switching a gym on** (built from
ElevenLabs' documented API, but not run against it):

- The agent is created with the server tools and `end_call` (the API accepts
  `conversation_config.agent.prompt.tools` with `type: "webhook"`, or the account
  requires tools created separately and attached by id).
- A tool request arrives with the header and `followup_job` filled from the
  dynamic variable; the route accepts both a flat body and `{ parameters: {...} }`.
- The agent says the time the tool returns, and does not confirm a call back
  when the tool returns `need_more`.
- The post-call webhook carries `conversation_initiation_client_data.dynamic_variables.followup_job`,
  `transcript` (role, message, time) and the data-collection results
  (`outcome`, `reason`, `renewal_interest`, `unanswered_question`, `objection`, `understood`).
- Speech recognition and the voice work in each language the gym enabled.

Then place AI test calls to the owner's own phone ("Test on my phone" on the
agent) before starting any campaign.

## 5. Prerecorded calls (Mode A) on Exotel

The existing Exotel Programmable Gather flow plays the audio from
`/hooks/exotel/gather`. A recording is joined with the spoken notice and menu
into one 8 kHz, 16-bit mono WAV, which is the format Exotel plays. Voice of the
notice and menu: the campaign's voice, else the gym's default voice for the
tier and language, so one must be picked.

To verify on the live account: a recording plays fully and clearly over a real
line, the key press after it still registers, and the call's duration is
reported (it bills the minutes).

Exotel's Gather flow does not report voicemail. A call answered by voicemail is
recorded as connected and billed like any connected call; the call status shows
no key press. Documented as a limitation.

## 6. The scheduler

Call the tick every **1 to 2 minutes** from an external scheduler (cron-job.org,
GitHub Actions, Vercel Cron on a paid plan):

```
GET https://<host>/api/followups/cron/tick
Authorization: Bearer <CRON_SECRET>
```

A call back is placed on the first tick after its time. With a 5-minute tick it
can be up to 5 minutes late; it expires if it cannot be placed within 2 hours.
The tick's budget must stay under the hosting function's time limit
(`FOLLOWUP_TICK_BUDGET_MS`, default 50 seconds).

## 7. Compliance before production calls

- The owner confirms the compliance checklist in Settings (already required
  before any campaign starts).
- Members' permission is recorded per channel with evidence; offers and events
  need the separate permission. Do not import permission you cannot prove.
- Every call says it is automated (prerecorded) or that it is an AI (interactive);
  every prerecorded call offers 9 to stop; the AI stops at once when asked.
- Calling hours are clamped to 09:00-21:00 whatever a gym sets.
- Transcripts: kept 90 days by default, readable only by the gym's owners,
  deleted at the end of the period or at once when the gym switches them off.
- A legal review of the consent wording and of the promotional rules (DND/NCPR
  scrubbing for promotional calls is not built in; see the test report) is still
  needed before promotional announcements are used on real members.

## 8. Go-live order

1. Database migration (section 2), then merge and deploy. The feature stays `off`.
2. Exotel account, KYC, caller numbers, Gather flow (FOLLOWUPS.md "Going live").
3. Speech provider and voices; ElevenLabs Agents for AI conversations (section 4).
4. Scheduler (section 6).
5. Real provider costs in the founder price book.
6. Test calls to the owner's own phone in both modes; check the items under
   "verify on the live account".
7. One gym, a small campaign, watch the founder console's Operations and Usage
   tabs for a day, then widen.
