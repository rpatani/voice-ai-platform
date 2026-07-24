import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

const tracer: Tracer = trace.getTracer('voice-agent');

/**
 * Runs `fn` inside a new active span named `name`, recording success/error
 * status and exceptions automatically. Use this to wrap every external
 * call (STT, LLM, TTS, calendar, telephony) so per-stage latency shows up
 * as child spans of the per-call trace in Tempo.
 *
 * @example
 * const reply = await withSpan('llm.completeStream', (span) => {
 *   span.setAttribute('llm.provider', 'openai');
 *   return runLLMTurn(...);
 * });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) span.setAttributes(attributes);
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function getTracer(): Tracer {
  return tracer;
}
