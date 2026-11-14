# AI Communication 2.0: test report

Branch `feat/ai-communication` (2.0 changes uncommitted in the worktree at the
time of writing). Tested 12-14 November 2026 on Windows 11, Node 22,
PostgreSQL 17 (local, throwaway) and SQLite. No provider account was used: every
call and message in these tests is simulated, and no real phone was dialled.

## Results

| Suite | Where | Result |
|---|---|---|
| AI Communication (6 files: `followups`, `followupsHardening`, `followupsAiCalls`, `followupsRecordings`, `followupsWhen`, plus `followupsPg` on Postgres) | SQLite | **110 / 110 passed** (run at 2 AM IST, to prove nothing depends on the time of day) |
| Same files, including concurrency and row-level security | PostgreSQL 17 | **120 / 120 passed** (also run at night) |
| Whole backend (`node --test`, every module) | SQLite | **2,164 tests: 2,149 passed, 0 failed, 15 skipped** (the skipped ones need `TEST_DATABASE_URL`, and run in the Postgres row above or in CI) |
| Frontend unit and component tests (Vitest) | jsdom | **22 files, 199 / 199 passed** |
| Bundle budgets (`check:bundle`) | production build | **All met** (initial JS 90.3 / 95 kB) |
| Production builds | owner app and admin console | **Both build** |
| Migration rehearsal | Postgres 17, database built from `origin/main` | **24 tables, 22 with forced RLS, 22 policies, ledger unique index, 2 balance checks, runtime role on all 24**; run twice, same result |
| Upgrade of an existing database | the local demo database (made with the first version) | **Both tables rebuilt with the new constraints, every row kept** |
| Browser check | local demo (owner app, admin console) | Campaign mode cards, recording upload and preview, conversations list and detail, call-back trail, founder Usage tab; no console errors |

Two older tests depended on the time of day: they used a simulated clock for
planning but left a job's time at the real clock, and failed when run at night.
Both were fixed by putting the job on the simulated clock as well. The same
look found one real flaw: the agent tools' "this call has ended" guard measured
against the simulated clock; it now measures real elapsed time. One unrelated
test (`foodBenchmarkGate`, the food-database quality gate) failed once under
the full parallel suite and passes on its own; it is a timing flake in a module
this work does not touch.

## The 18 interactive scenarios from the brief

All run in test mode: `simulator.js` plays the member, and every state change
goes through the same server tools a live agent calls.

| # | Scenario | Test | What is checked |
|---|---|---|---|
| 1 | Agrees to renew | `AI 1` | Outcome `renewing`, owner action "Collect the payment...", minutes charged = minutes talked |
| 2 | Declines | `AI 2` | Reason kept ("Moved to another area"), no call back, campaign stops for that membership |
| 3 | Busy | `AI 3+5` | AI offers a call back |
| 4 | "Call me tomorrow" | `AI 4` | Booked tomorrow 18:00; summary names the date |
| 5 | "Call me next Monday" | `AI 3+5` | AI asks the time, then books Monday 18:00 in the gym's timezone and confirms the exact time; confirmation only after `scheduled` |
| 6 | "After five days" | `AI 6+7` | Asks for a time; books day +5 at 11:00 |
| 7 | "In the evening" | `AI 6+7` | Today around 6 PM; a second request moves the same booking |
| 8 | Ambiguous date | `AI 8` | "Which day next week suits you?"; nothing booked |
| 9 | Membership prices | `AI 9` | Quotes the gym's own plans exactly; without plans, refers the question and flags it for the owner |
| 10 | Unavailable discount | `AI 10` | "I cannot confirm any discount"; question goes to a person |
| 11 | Wants a human | `AI 11` | Staff call back (assigned, high priority), owner action, campaigns pause for the member |
| 12 | Wrong number | `AI 12` | Number suppressed at once; next planning skips it |
| 13 | Stop calling | `AI 13` | Opt-out recorded during the call (source `agent`), booked call back cancelled |
| 14 | Disconnects | `AI 14` | `incomplete`, "ended after 6 seconds... Nothing was agreed" |
| 15 | Not understood | `AI 15` | `not_understood`, owner asked to call |
| 16 | Provider fails | `AI 16` | Failed, nothing charged; a silent provider is closed by the sweep |
| 17 | Call back fails | `AI 17` | Retried an hour later, then "No answer after 2 attempts. Call the member yourself." |
| 18 | Two workers, one call back | `AI 18`, Postgres race test | Placed exactly once (3 workers on SQLite, 12 on a real Postgres pool) |

## Other coverage

| Area | Tests |
|---|---|
| Spoken times | 21 tests in `followupsWhen.test.js`: relative days, weekdays, dates, parts of the day, Hinglish, closed days, calling hours, too soon / too far, the agent's own fields, daylight saving |
| Prerecorded calls | WAV conversion from 8/16/24/32-bit and float, any rate, stereo; refusal of MP3, compressed WAV, silence, too short, too long; notice + recording + menu joined and cached; a campaign plays the recording with no conversation record and bills voice minutes; a call back can play a recording |
| Recordings library | Upload, de-duplication, preview, rename, archive blocked while a running campaign uses it, another gym gets 404, every change audited |
| Summaries | Every finished conversation: one or two sentences, never "call completed", incomplete never marked completed |
| Transcripts | Kept 90 days by default, deleted after the period, none kept when switched off |
| Agent setup | Opening line without "AI" refused; length clamped; tools follow the owner's switches; ElevenLabs tool definitions carry the key header and the dynamic job reference |
| Announcements and promotions | Only on their day, only to their audience, no "press 2"; promotional needs the separate permission; a call back never grants it; turning offers off cancels queued promotional calls |
| Owner controls | Reschedule, change who calls, cancel, call now, book one; validation; event trail; audit rows |
| Security | Tool endpoint needs the key and a valid signed job token; a tool cannot touch another gym's member; gym B gets 404 on gym A's conversations, call backs and recordings; members and trainers get 403 on the owner API |
| Row-level security | Postgres: conversations, call backs and recordings invisible and unwritable across gyms |
| Billing | Founder usage split by mode, campaign and gym; a retried status webhook and a late duplicate AI result are not counted twice; owners get 403 on founder usage |
| End to end | An interactive campaign of 12 members in test mode: 12 conversation records, all closed with summaries, only the test provider used |

## Status by the brief's four categories

### 1. Fully implemented and tested

- Choice of calling mode on campaigns and call backs (prerecorded, interactive AI, messages only).
- Recording library: upload (MP3/M4A/WAV/OGG/WebM via the browser) or record in the browser, preview, rename, archive; server validation.
- Prerecorded calls: notice + recording + keypad menu, retries, calling windows, statuses, durations, provider ids, usage.
- Call-back engine: understanding the time, clarifying questions, persistence, exactly-once execution, retries, expiry, cancellation, mode kept and changeable, owner controls, audit trail, timezone and daylight saving.
- Conversation records: structured outcome, intent, renewal interest, questions, objections, call back, escalation, owner action, server-written summary, transcript with retention.
- Owner screens: campaign mode cards, recordings, Conversations, Call backs (booked / for your team / finished), agent settings, transcript settings; member "Offers and events" switch.
- Founder Usage tab: by mode, campaign, gym, month; call-back counts; six-month trend.
- Announcements; separation of service and promotional contact.
- Gym isolation (application and database), authorisation, migration and upgrade path.

### 2. Implemented, tested only in simulation

- The interactive conversation itself: in tests a scripted member replaces the
  real speech-to-AI-to-speech loop. The live loop is ElevenLabs Agents (or your
  own agent server) through the provider adapter; the prompt, tools, data fields
  and webhook parsing are tested, the live model's behaviour is not.
- Exotel playback of the joined recording audio, key presses and statuses on a
  real line.
- Provider cost breakdown per conversation (`cost_json`) is stored when the
  provider sends it; never observed from a real account.

### 3. Needs external credentials or provider configuration

- Exotel account, KYC, caller numbers, the Gather flow.
- ElevenLabs API key and credits, post-call webhook and secret, Exotel numbers
  imported into ElevenLabs; the checks listed under "verify on the live account"
  in [AI_COMMUNICATION_DEPLOYMENT.md](AI_COMMUNICATION_DEPLOYMENT.md), in
  particular that this account accepts inline webhook tools with
  `dynamic_variable` in the request body.
- A TTS voice for each language used (speaks the notice and menu around recordings).
- An external scheduler calling the tick every 1-2 minutes.
- The production database migration (prepared and rehearsed; paused on request).
- Real provider costs in the founder price book.

### 4. Not implemented, and why

- **Voicemail detection.** Exotel's Programmable Gather flow does not report
  answering machines, and ElevenLabs' outbound call over Exotel does not expose
  one either. A voicemail is recorded as a connected call with no key press.
  Adding it needs a provider feature (answering-machine detection) or a
  different telephony provider.
- **Live call transfer to a human.** The AI records the request and creates a
  staff call back; it does not bridge the member to a person during the call.
  That needs a staffed number and the provider's transfer tool, which the gym
  must decide to offer.
- **DND / NCPR scrubbing for promotional calls.** Promotional calls are gated on
  the member's own recorded permission, but the number is not checked against
  the national do-not-call registry. Doing that needs a registry or telecom
  operator integration; until then promotional announcements should not be used
  on real members without the legal review listed in the deployment guide.
- **A language model inside Barbell for summaries.** Summaries are written by
  the server from the facts recorded during and after the call (deterministic,
  testable, never invented). The provider's own free-text summary is kept
  alongside for reference.
