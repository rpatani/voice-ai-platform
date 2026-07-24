import pino from 'pino';
import { trace, context } from '@opentelemetry/api';

/**
 * Base structured JSON logger. Writes to stdout; in the local stack this is
 * scraped by Promtail and shipped to Loki, where it's visualized in
 * Grafana and can be correlated with traces (Tempo) and metrics
 * (Prometheus) via `trace_id`.
 */
const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = pino.Logger;

/** A logger pre-bound with static fields, e.g. `{ component: 'telephony' }`. */
export function getLogger(bindings: Record<string, unknown> = {}): Logger {
  return baseLogger.child(bindings);
}

/**
 * A logger that additionally attaches the current OpenTelemetry
 * `trace_id` / `span_id` (if a span is active) to every log line. Use this
 * inside request/call-handling code so logs can be pivoted to the
 * corresponding trace in Tempo from Grafana.
 */
export function getTracedLogger(bindings: Record<string, unknown> = {}): Logger {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();

  return baseLogger.child({
    ...bindings,
    ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
  });
}
