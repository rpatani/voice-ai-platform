# Voice Agent Platform

A provider-agnostic AI voice agent: Twilio for inbound calls, a streaming
speech-to-text engine, an LLM-driven conversation engine, streaming
text-to-speech, and a calendar/booking integration - all behind
configurable, swappable adapter interfaces, with multi-tenant config and
shared open-source observability (OpenTelemetry + Grafana).

See [`docs/architecture.md`](./docs/architecture.md) for the full design and
[`CLAUDE.md`](./CLAUDE.md) for the implementation roadmap and conventions.

## Status

The full pipeline is implemented and tested end-to-end (M0-M13):

- `packages/core` - provider interfaces, conversation state machine, μ-law codec (pure logic)
- `packages/observability` - OpenTelemetry tracing/metrics + structured logging
- `packages/config` - tenant configuration schema + file-based provider
- `packages/data` - Postgres repositories + migrations, Redis session store, in-memory variants
- `packages/adapters-twilio` - webhook parsing + signature validation, TwiML, Media Streams WebSocket, REST call control
- `packages/adapters-deepgram` / `-openai` / `-elevenlabs` / `-calcom` - real vendor adapters (plain fetch/WebSocket, no SDKs)
- `packages/adapters-mock` - deterministic scripted STT/LLM/TTS/calendar for tests and simulation mode
- `packages/engine` - the conversation engine: LLM tool loop, slot filling, booking, escalation, sentence streaming
- `apps/voice-agent` - the deployable service: HTTP webhook + media WebSocket server, call orchestration with barge-in, persistence, post-call summaries

## Prerequisites

- Node.js >= 20
- Docker + Docker Compose (for Postgres/Redis and the observability stack)

## Quickstart

```bash
npm install
npm run build
npm run test
```

### Run in simulation mode (no credentials needed)

The entire platform runs against deterministic mock providers - useful for
development, demos, and CI:

```bash
SIMULATION=true PERSISTENCE=memory PORT=8080 node apps/voice-agent/dist/main.js
```

Then simulate Twilio yourself: `POST /twilio/voice` with form fields
`CallSid`, `From`, `To=+15551234567` returns TwiML pointing at
`wss://.../media`; connect a WebSocket there and speak Twilio's Media
Streams protocol (`start` / `media` / `stop` JSON events). The e2e test in
`apps/voice-agent/src/__tests__/e2e-simulated-call.test.ts` does exactly
this - it is the best reference for the wire flow.

### Run the full stack with Docker

```bash
docker compose up --build            # app + Postgres + Redis (SIMULATION=true by default)
docker compose -f infra/observability/docker-compose.yml up -d   # Grafana etc.
```

Grafana: http://localhost:3000 (anonymous admin in local dev) with a
pre-provisioned "Voice Agent Overview" dashboard.

### Run on a free provider stack

For a $0 / free-tier live stack (no OpenAI or ElevenLabs bill), use the
`demo-dental-free` tenant, which selects **Groq** (LLM, OpenAI-compatible,
free tier) + **Deepgram** for both STT (nova) and TTS (Aura) on a single
free-credit key + a mock calendar:

1. Get free keys: `GROQ_API_KEY` from <https://console.groq.com>,
   `DEEPGRAM_API_KEY` from <https://console.deepgram.com> ($200 free credit).
2. In `.env` set `SIMULATION=false`, `GROQ_API_KEY=...`, `DEEPGRAM_API_KEY=...`.
3. Point a Twilio number at the app (see below) and add it to
   `packages/config/tenants/demo-dental-free.json` → `inboundPhoneNumbers`.

Provider selection is per-tenant config, never code. To move a tenant to a
paid/premium stack, change its `providers` block (`"llm":"openai"`,
`"tts":"elevenlabs"`, …) and supply the matching key — no rebuild.

| Capability | Free provider | Premium provider |
|---|---|---|
| LLM | `groq` (Llama 3.3 70B) | `openai` (GPT-4o-mini) |
| STT | `deepgram` (nova) | `deepgram` |
| TTS | `deepgram` (Aura) | `elevenlabs` |
| Calendar | `mock` | `calcom` |

### Go live with real providers

1. `cp .env.example .env` and fill in `TWILIO_*`, `DEEPGRAM_API_KEY`, and
   either `GROQ_API_KEY` (free) or `OPENAI_API_KEY`; add `ELEVENLABS_API_KEY`
   / `CALCOM_API_KEY` only if a tenant uses those providers. Set
   `SIMULATION=false` and `PERSISTENCE=postgres`.
2. Expose the app publicly (e.g. `ngrok http 8080`) and set `PUBLIC_HOST`
   to the ngrok hostname (no scheme). `PUBLIC_HOST` is also used to
   validate Twilio webhook signatures.
3. In the Twilio console, point your phone number's Voice webhook (HTTP
   POST) at `https://<PUBLIC_HOST>/twilio/voice`.
4. Add the number to a tenant's `inboundPhoneNumbers` in
   `packages/config/tenants/<tenant>.json`, and map services to Cal.com
   event types under `providerOptions.calcom.eventTypeIdByService`.

## Project layout

```
packages/
  core/                domain types, provider interfaces, state machine, audio codec (pure, no I/O)
  observability/       OpenTelemetry wrapper (logging, tracing, metrics)
  config/              tenant config schema + FileTenantConfigProvider + sample tenant
  data/                Postgres/Redis/in-memory persistence (tenant-scoped)
  engine/              conversation engine (LLM tool loop, slot filling, booking, escalation)
  adapters-twilio/     telephony adapter (webhooks, TwiML, Media Streams, μ-law)
  adapters-deepgram/   streaming STT (nova) + streaming TTS (Aura) adapters
  adapters-openai/     OpenAI-compatible LLM adapter (OpenAI, Groq, ...)
  adapters-elevenlabs/ streaming TTS adapter (premium)
  adapters-calcom/     booking/calendar adapter
  adapters-mock/       scripted STT/LLM/TTS/calendar for tests + simulation
apps/
  voice-agent/         the deployable service (HTTP + WebSocket + orchestration)
infra/
  observability/       docker-compose stack for Grafana/Loki/Tempo/Prometheus/OTel Collector
docs/
  architecture.md      architecture reference
```

## Sample tenant

`packages/config/tenants/demo-dental.json` is a complete example tenant
config (a fictional dental practice) that exercises the full config schema -
useful as a template when adding a new tenant or writing tests.
