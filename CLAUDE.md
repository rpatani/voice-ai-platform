# CLAUDE.md — Project context for Claude Code

This file is read automatically by Claude Code at the start of every
session in this repo. It captures project conventions, the current state,
and the implementation roadmap so work can continue across sessions without
re-deriving the design.

## What this project is

A production-ready AI voice agent: Twilio (inbound calls + Media Streams) +
streaming STT + an LLM conversation engine + streaming TTS + a
calendar/booking integration, all behind provider-agnostic interfaces so no
single vendor is hard-coded. See `docs/architecture.md` for the full design
- **read that file before making architectural changes**.

## Tech stack & conventions

- **Language**: TypeScript, strict mode, ES2022, `NodeNext` module
  resolution (all relative imports use explicit `.js` extensions, even in
  `.ts` source files - this is required by `NodeNext`).
- **Monorepo**: npm workspaces (`packages/*`, `apps/*`). No pnpm/yarn.
- **Testing**: Vitest. Every package should have `npm run test` runnable
  standalone via `npm run test -w <package-name>`.
- **Build order matters**: `packages/config` depends on `@platform/core`'s
  built output. The root `build` script builds in explicit dependency
  order (`core` -> `observability` -> `config`). If you add a new package
  that depends on another workspace package, add it to that script in the
  correct order rather than relying on `--workspaces` default ordering.
- **No vendor SDKs outside adapter packages**: domain/orchestration code
  depends only on the interfaces in `packages/core/src/interfaces/`.
  Provider-specific code (Twilio, OpenAI, ElevenLabs, Deepgram, Cal.com
  SDKs/HTTP clients) belongs in dedicated `packages/adapters-*` packages
  (not yet created).
- **Observability from day one**: any new service/operation that talks to
  an external provider should be wrapped in `withSpan(...)` from
  `@platform/observability` and increment the relevant metric
  (`providerErrorTotal` on failure, etc). Don't bolt this on later.
- **Keep it simple**: this project intentionally avoids microservices,
  message queues, and premature abstraction. Platform concerns
  (observability, multi-tenancy) are designed as clean interfaces /
  libraries within a single deployable, not separate services - splitting
  them out later should be possible without changing calling code, but
  don't do it preemptively.

## Repo layout

```
packages/
  core/            domain types, provider + persistence interfaces, state machine, μ-law codec (pure, no I/O)
  observability/   OpenTelemetry wrapper - logger, tracer, metrics (used by every other package)
  config/          tenant config zod schema + FileTenantConfigProvider + sample tenant (tenants/demo-dental.json)
  data/            Postgres repos + migrations (src/postgres/schema.ts), Redis session store, in-memory variants
  engine/          conversation engine: LLM tool loop, prompt rendering, sentence splitter
  adapters-twilio/     webhooks + HMAC validation, TwiML, Media Streams session, REST call control (no SDK)
  adapters-deepgram/   streaming STT over ws (injectable socket factory)
  adapters-openai/     streaming chat completions + tool calls over fetch/SSE
  adapters-elevenlabs/ streaming TTS (ulaw_8000 -> PCM16)
  adapters-calcom/     Cal.com v2 slots + bookings over fetch
  adapters-mock/       scripted STT/LLM/TTS/calendar - powers SIMULATION=true and most tests
apps/
  voice-agent/     the deployable service: env, provider registry, CallSession orchestrator, HTTP + /media WS server
infra/
  observability/   docker-compose.yml + configs for OTel Collector, Tempo, Loki, Promtail, Prometheus, Grafana
docs/
  architecture.md  full architecture reference - read this first
```

## Local setup

```bash
npm install
npm run build
npm run test

# Bring up the observability stack (Grafana at http://localhost:3000)
docker compose -f infra/observability/docker-compose.yml up -d
```

Copy `.env.example` to `.env` and fill in provider credentials as adapters
are built. Live API testing (Twilio/OpenAI/ElevenLabs/Deepgram/Cal.com)
requires an environment with normal internet access and real credentials -
not available in a restricted sandbox.

## Implementation roadmap

Status legend: `[x]` done, `[ ]` not started.

- [x] **M0 - Repo scaffolding**: npm workspaces monorepo, TS config, lint/test setup.
- [x] **M1 - Core domain layer**: provider interfaces (`telephony`, `stt`, `llm`, `tts`, `calendar`, `tenant-config`), `ConversationState`, slot definitions, pure state machine (`deriveNextStep`, etc) with unit tests.
- [x] **M2 - Observability package**: `@platform/observability` (OTel SDK bootstrap, traced logger, `withSpan`, shared metric instruments) + `infra/observability` Docker Compose stack (OTel Collector, Tempo, Loki, Promtail, Prometheus, Grafana) with a starter dashboard.
- [x] **M3 - Configuration & multi-tenancy (initial)**: `tenantConfigSchema` (zod), `FileTenantConfigProvider` implementing `ITenantConfigProvider`, sample tenant `demo-dental`.
- [x] **M4 - Data layer**: persistence interfaces added to `core` (`ICallRepository`, `ITranscriptRepository`, `ILeadRepository`, `ICallSummaryRepository`, `ISessionStore`); `@platform/data` with Postgres implementations + versioned migrations (embedded SQL, run by `runMigrations` at startup), `RedisSessionStore` (structural `RedisLike` client for testability), and in-memory variants used by tests/simulation.
- [x] **M5 - Telephony adapter (Twilio)**: `TwilioTelephonyProvider` (TwiML, webhook parse, HMAC-SHA1 signature validation), `TwilioMediaStreamSession` over a transport-agnostic `MediaSocket` (barge-in via `clear`), `TwilioRestCallControl` for hangup/transfer. μ-law codec lives in `@platform/core` (src/audio) since ElevenLabs also needs it. No Twilio SDK.
- [x] **M6 - STT adapter (Deepgram)**: live WebSocket API with injectable socket factory; `speech_final` maps to `isFinal`; audio buffered until socket opens. Scripted `MockSttProvider` lives in `packages/adapters-mock` (a first-class package, deviation from the original plan so simulation mode needs no vendor deps).
- [x] **M7 - LLM adapter & conversation engine**: `OpenAiLlmProvider` (fetch + SSE, streamed tool-call accumulation); `packages/engine` with `ConversationEngine` - tools `update_slot`, `check_availability`, `book_appointment`, `answer_faq`, `escalate_to_human`, `end_call`; max 5 tool rounds/turn; sentence-level streaming via `SentenceSplitter`; deterministic `handleFallback` (no LLM call) with escalation budget.
- [x] **M8 - TTS adapter (ElevenLabs)**: streams `ulaw_8000`, decodes to PCM16 8kHz frames. Silent `MockTtsProvider` (duration proportional to word count) in adapters-mock.
- [x] **M9 - Booking adapter (Cal.com)**: v2 slots + bookings API; serviceId -> eventTypeId mapping from `providerOptions.calcom`.
- [x] **M10 - End-to-end orchestration**: `apps/voice-agent` - `ProviderRegistry` (tenant provider names -> adapter instances; `SIMULATION=true` forces mocks), `CallSession` (turn queue, speech queue, barge-in on interim transcripts, low-confidence fallback, escalation transfer/hangup, persistence), HTTP server (`POST /twilio/voice` with signature validation, `GET /healthz`) + `/media` WebSocket.
- [x] **M11 - Call summaries & logging**: post-call summary via `llm.complete`, lead capture (even for abandoned calls), call finalization with outcome (`booked`/`escalated`/`completed`/`abandoned`); spans + metrics throughout. (Grafana visual verification still requires running the observability stack manually.)
- [x] **M12 - Testing harness**: `e2e-simulated-call.test.ts` drives the real Twilio media adapter with protocol JSON + mock providers through the full pipeline (booked and abandoned paths). 101 tests across 12 suites; plus a live boot smoke test (server + webhook + WS media) run during development.
- [x] **M13 - Deployment packaging**: `apps/voice-agent/Dockerfile` (multi-stage, healthcheck), root `docker-compose.yml` (app + Postgres + Redis), README with simulation/live setup incl. Twilio console + ngrok steps, updated `.env.example`.
- [ ] **M14 - Tenant onboarding/admin API** (future; build LAST - recommended order is M16 -> M17 -> M15 -> M14, see notes under M17): CRUD for tenant configs on top of `ITenantConfigProvider`, usage metering hooks - seed of a standalone multi-tenant SaaS layer. Absorbs M17's minimal `ADMIN_API_KEY` auth when built.
- [ ] **M16 - Google Calendar adapter + normalized booking domain** (spec'd, not started; **build before M17/M15/M14**): the long-tail calendar tier and the seed of a future unified-integration/MCP product. (1) Core schema: `Booking` type + `getBooking`/`cancelBooking` added to `ICalendarProvider` (all adapters implement; NO reschedule method - reschedule = cancel + create, orchestrated by engine). (2) Pure slot math: `packages/core/src/scheduling/slots.ts` `computeAvailableSlots(busy, businessHours, duration, window, timeZone)` - raw calendars return busy intervals, not slots; test DST/overnight edges. Add optional top-level `timeZone` (IANA) to `tenantConfigSchema`. (3) `packages/adapters-google-calendar` (no SDK, fetch + injectable fetchImpl/clock): OAuth2 refresh-token flow (`GOOGLE_CLIENT_ID/SECRET` env; per-tenant refresh tokens in git-ignored `TENANT_SECRETS_FILE` JSON keyed by tenantId - NEVER in tenant JSON; consent CLI `apps/voice-agent/scripts/google-oauth-setup.ts`), `freeBusy` -> slot computation, event insert with `extendedProperties.private={tenantId,callId,serviceId}`, event id = bookingId, DELETE/GET for cancel/get, freeBusy re-check just before insert (best-effort double-booking guard), 401 -> refresh once + retry once. Registry name `google-calendar`; demo tenant `demo-salon-google.json`. ~15-18 tests. Est 1.5-2 days, no new deps.
- [ ] **M17 - Outbound calling + confirmation-call product** (spec'd, not started; depends on M16): second product (same engine, direction-aware). v1 scope = transactional appointment-confirmation calls ONLY (confirm/cancel/reschedule - lowest TCPA risk). (1) Core: `IOutboundDialer.placeCall({to, from, answerWebhookUrl, machineDetection, metadata})` - separate from `ITelephonyProvider` (origination is account-level). (2) Twilio: `TwilioOutboundDialer` POST `/Calls.json` (`MachineDetection=Enable`, `StatusCallback`); new routes `POST /twilio/outbound-answer` (signature-validated; AnsweredBy=human -> same `<Connect><Stream>` TwiML into existing `/media` pipeline; machine -> hangup, mark `machine`) + `POST /twilio/outbound-status`. `From` = tenant's first inboundPhoneNumbers entry. (3) Engine: `ConversationState.direction` + `purpose: 'appointment_confirmation'` + `bookingRef`; new pure steps outbound_greeting (identity check) -> deliver_purpose -> confirmed/reschedule/cancelled/wrong_number; new tools `confirm_appointment`/`cancel_appointment`; new outcomes confirmed/rescheduled/cancelled_by_customer/no_answer/machine; optional `outboundPromptTemplate` in tenant schema. (4) Jobs: migration v2 `outbound_calls` + `dnc_numbers` tables (+ in-memory variants); setInterval worker (NO message broker), per-tenant concurrency cap (default 2), retry no-answer/busy max 3 attempts +2h. Guardrails: calling hours 8am-9pm tenant-local, DNC check before dial, bot-disclosure opening line. Trigger: `POST /outbound/calls` + `GET /outbound/calls/:id` behind `ADMIN_API_KEY` env (absorbed by M14 later). ~20-25 tests incl. e2e simulated outbound confirmation call. Est 3-4 days, no new deps.
  - Recommended build order: M16 -> M17 -> M15 -> M14. Deferred/tracked: REST/MCP exposure of the integration layer (revisit after 2-3 calendar adapters are battle-tested), voicemail drop on AMD, waitlist-backfill campaigns, Square/Booksy adapters.
- [ ] **M15 - Provider failover & resilience** (spec'd, not started): ordered provider chains per tenant (`providers.llm: ["groq","openai"]`, zod `string | string[]`), decorator wrappers in `packages/core/src/resilience/` implementing the existing STT/LLM/TTS interfaces (engine/CallSession untouched), shared circuit breakers held by `ProviderRegistry` (3 failures -> open 30s -> half-open probe), AbortSignal timeouts everywhere (LLM first-token 5s, TTS first-frame 3s, STT open 5s - currently NO timeouts exist), failover only before first streamed token/frame (never mid-stream, to avoid double-speak), STT mid-call session re-establishment (also fixes latent bug: an STT socket death currently leaves the call permanently deaf), metrics `providerFailoverTotal`/`circuitOpenTotal`. Non-goals: telephony/calendar failover, hedged dispatch, mid-stream resume. Degraded floor = existing deterministic `handleFallback` + escalation.

When starting a session, check this list, pick up at the first unchecked
milestone (unless told otherwise), and update the checkbox + add brief notes
here when a milestone is completed.

### Free provider stack (added post-M13)

- **LLM (free):** Groq is wired as a first-class `llm` provider name. It
  reuses `OpenAiLlmProvider` (Groq exposes an OpenAI-compatible API) via
  `baseUrl` (`https://api.groq.com/openai`) + a `providerLabel` option so
  spans/metrics/`name` read `groq`. Env: `GROQ_API_KEY`, optional
  `GROQ_BASE_URL`. Default model `llama-3.3-70b-versatile`.
- **TTS (free):** `DeepgramTtsProvider` (Deepgram Aura) in
  `packages/adapters-deepgram` streams `/v1/speak` as raw `mulaw` 8 kHz
  (`container=none` to avoid a WAV header) → PCM16 frames, reusing the core
  μ-law codec. Selected with `"tts":"deepgram"`; reuses `DEEPGRAM_API_KEY`.
  TTS voice = Aura model name via `providerOptions["deepgram-tts"].model`
  (STT model stays under `providerOptions.deepgram.model`).
- **Free tenant:** `packages/config/tenants/demo-dental-free.json`
  (groq + deepgram STT + deepgram Aura TTS + mock calendar).
- **Chosen Deepgram Aura over Edge-TTS** for free TTS: documented, keyed,
  streaming API vs. a reverse-engineered consumer endpoint (brittle
  `Sec-MS-GEC` token) — Edge-TTS remains a possible future zero-key adapter.
- Aura's raw-`mulaw` output + `container=none` is implemented against the
  documented wire protocol with fake-`fetch` unit tests; a live credential
  pass is still needed to confirm byte framing (same posture as other
  adapters).

### Known gaps / notes

- Postgres/Redis code paths have been verified against live servers
  (Postgres 16 + Redis 7 in Docker): a full simulated booking call wrote the
  expected rows to `schema_migrations` (v1), `calls` (outcome=booked,
  booking_id set, ended_at set), `transcript_turns` (contiguous 0..N),
  `leads`, and `call_summaries`, and the Redis `session:*` key was cleaned
  up on call end. `runMigrations` + all Postgres repos + `RedisSessionStore`
  are exercised. (Reproduce: `docker compose up` then place a simulated call.)
- Real vendor APIs (Twilio/Deepgram/OpenAI/ElevenLabs/Cal.com) are
  implemented against their documented wire protocols with unit tests using
  fakes; live credentials are needed for a true integration pass.
- Barge-in cancels the sentence being spoken and all queued sentences of
  that reply (generation counter), and clears Twilio's outbound buffer.
