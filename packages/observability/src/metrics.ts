import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('voice-agent');

/** Total duration of an inbound call, from answer to hangup, in milliseconds. */
export const callDurationMs = meter.createHistogram('voice_agent_call_duration_ms', {
  description: 'Total duration of an inbound call, in milliseconds',
  unit: 'ms',
});

/**
 * Latency of a single conversation turn. Record with a `stage` attribute
 * (e.g. "stt", "llm", "tts", "turn_total") to break down where time goes.
 */
export const turnLatencyMs = meter.createHistogram('voice_agent_turn_latency_ms', {
  description: 'Latency of a conversation turn or sub-stage, in milliseconds',
  unit: 'ms',
});

/** Incremented each time the fallback/clarification handler is triggered. */
export const fallbackTotal = meter.createCounter('voice_agent_fallback_total', {
  description: 'Number of times the fallback/clarification handler was triggered',
});

/** Incremented when a provider adapter call fails. Tag with `provider` and `operation`. */
export const providerErrorTotal = meter.createCounter('voice_agent_provider_error_total', {
  description: 'Number of errors returned by an external provider adapter',
});

/** Incremented when a booking is successfully created. */
export const bookingsCreatedTotal = meter.createCounter('voice_agent_bookings_created_total', {
  description: 'Number of appointments successfully booked',
});

/** Incremented when a call ends in escalation to a human. */
export const escalationsTotal = meter.createCounter('voice_agent_escalations_total', {
  description: 'Number of calls escalated to a human',
});
