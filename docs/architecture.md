# Architecture Reference — AI Voice Agent Platform

This document is the condensed source of truth for the system design. It's
written to be loaded as context by Claude Code (or any contributor) when
working on any part of this repo.

## 1. Goal

A production-ready AI voice agent that answers inbound phone calls, speaks
naturally, collects caller details (name, phone number, service needed,
preferred appointment time), and books an appointment or captures a lead.
Built so that the telephony, STT, LLM, TTS, and booking/calendar providers
are all swappable via configuration, not code changes - and so the platform
(observability, multi-tenancy) can be reused by future, non-voice agentic
SaaS apps.

## 2. Core design principle: ports and adapters

The application core never imports a vendor SDK directly. Every external
dependency is accessed through an interface defined in `@platform/core`:

| Interface | Role | Default adapter (planned) |
|---|---|---|
| `ITelephonyProvider` / `ITelephonyCallSession` | Inbound call handling, bidirectional audio | Twilio (Media Streams) |
| `ISpeechToTextProvider` | Streaming transcription | Deepgram |
| `ILLMProvider` | Conversation intelligence, tool calling | OpenAI (GPT-4o / GPT-4o-mini) |
| `ITextToSpeechProvider` | Streaming voice synthesis | ElevenLabs |
| `ICalendarProvider` | Availability + booking | Cal.com |
| `ITenantConfigProvider` | Multi-tenant config resolution | File-based (`FileTenantConfigProvider`), Postgres-backed later |

Adapters live in their own packages (`packages/adapters-*`, to be created in
later milestones) and are selected per-tenant via `TenantConfig.providers`
(see `packages/core/src/interfaces/tenant-config.ts`). Switching a tenant
from ElevenLabs to another TTS provider, or from OpenAI to another LLM, is a
config change plus (if the adapter doesn't exist yet) a new class
implementing the relevant interface - never a change to the conversation
engine, state machine, or orchestration code.

## 3. Conversation flow / state machine

Pure, fully unit-tested logic in `packages/core/src/conversation/`:

```
greeting -> slot_filling -> confirmation -> booking -> closing -> completed
                |
                v
           (fallback handler, max N retries per slot)
                |
                v
            escalated (human transfer / take a message)
```

Slots collected, in order (`SLOT_ORDER`): `callerName`, `phoneNumber`,
`serviceNeed`, `preferredTime`. `deriveNextStep()` is a pure function -
given a `ConversationState`, it always returns the same next step. The
orchestration layer (built in later milestones) calls this after each turn
and executes the corresponding action (prompt the LLM, call the booking
adapter, end the call, etc).

## 4. Turn-by-turn runtime flow (target, once adapters are built)

1. Twilio webhook (`POST /voice/incoming`) -> `ITelephonyProvider.parseInboundCall` -> resolve tenant via `ITenantConfigProvider.resolveTenantByPhoneNumber`.
2. Response opens a Media Streams WebSocket (`buildStreamResponse`).
3. Caller audio frames -> `ISpeechToTextProvider` streaming session -> `TranscriptEvent`s.
4. On a final transcript: append to `ConversationState.history`, call `ILLMProvider.completeStream` with the system prompt (rendered from `TenantConfig.systemPromptTemplate`) + history + tool definitions (`update_slot`, `check_availability`, `book_appointment`, `escalate_to_human`, `answer_faq`).
5. As the LLM streams sentences, pipe each to `ITextToSpeechProvider.synthesizeStream` and forward audio frames to `ITelephonyCallSession.sendAudio`.
6. Tool calls execute against `ICalendarProvider` (availability/booking) and update `ConversationState.slots`.
7. `deriveNextStep` determines the next step; repeat until `isTerminal(state)`.
8. On call end: persist transcript + call record, generate a summary via `ILLMProvider.complete` (non-streaming), persist summary.

## 5. Multi-tenancy

Every persisted record carries a `tenantId`. `ITenantConfigProvider` resolves
"which tenant owns this inbound number, and what's their config" once at
call start; the resolved `TenantConfig` is attached to the session context
for the rest of the call (one lookup per call, not per turn). The default
implementation (`FileTenantConfigProvider`) reads validated JSON files from
`packages/config/tenants/`. This interface is the seam where a future
standalone Tenant/Config service (shared across multiple agentic SaaS
products) would plug in - calling code does not change.

## 6. Observability

Shared, app-agnostic stack in `infra/observability/` (Docker Compose):
OpenTelemetry Collector + Tempo (traces) + Loki (logs, via Promtail) +
Prometheus (metrics) + Grafana (dashboards), all open source.

The `@platform/observability` package gives every service:
- `initObservability({ serviceName })` - call once at startup; sets up OTel traces + metrics export to the collector.
- `getLogger()` / `getTracedLogger()` - structured JSON logs (pino) to stdout, with `trace_id`/`span_id` attached for correlation in Grafana.
- `withSpan(name, fn)` - wraps any operation (STT/LLM/TTS/calendar calls) in a traced span; per-call traces show a full latency breakdown.
- Shared metric instruments: `callDurationMs`, `turnLatencyMs` (tagged by `stage`), `fallbackTotal`, `providerErrorTotal`, `bookingsCreatedTotal`, `escalationsTotal`.

A starter Grafana dashboard (`voice-agent-overview`) is pre-provisioned with
panels for call volume, average call duration, p95 turn latency by stage,
fallback/escalation rates, bookings, and provider errors.

## 7. Data model (target, Milestone 4)

Postgres, all tables `tenant_id`-scoped:
- `calls` (call_id, tenant_id, caller_number, started_at, ended_at, status, outcome)
- `transcript_turns` (call_id, turn_index, speaker, text, confidence, timestamp)
- `leads` (call_id, name, phone_number, service_requested, preferred_time, status, booking_confirmation_id)
- `call_summaries` (call_id, summary_text, sentiment, intent_category, follow_up_required)

Redis holds ephemeral per-call `ConversationState` keyed by `call_id`
(TTL slightly longer than max call duration), so the app can scale
horizontally without losing in-progress call state.

## 8. Deployment

Single containerized app service (Node.js/TypeScript) with WebSocket
support (Twilio Media Streams), Postgres, Redis, and the observability
stack as sibling containers/services. Local dev uses ngrok to expose the
app's webhook/WebSocket endpoints to Twilio.

## 9. Monorepo layout

```
packages/
  core/            - domain types, provider interfaces, conversation state machine (no I/O)
  observability/   - OpenTelemetry wrapper: logging, tracing, metrics
  config/          - tenant config schema (zod) + FileTenantConfigProvider
  adapters-*/      - (future) one package per provider integration
  data/            - (future) Postgres/Redis repositories
apps/
  voice-agent/     - (future) the deployable service wiring everything together
infra/
  observability/   - Docker Compose stack for Grafana/Loki/Tempo/Prometheus/OTel Collector
```

## 10. Implementation milestones

See `CLAUDE.md` for the up-to-date milestone checklist and current status.
