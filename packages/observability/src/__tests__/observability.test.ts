import { describe, expect, it } from 'vitest';
import { getLogger, getTracedLogger } from '../logger.js';
import { withSpan } from '../tracing.js';
import { callDurationMs, fallbackTotal, turnLatencyMs } from '../metrics.js';

describe('logger', () => {
  it('creates a child logger with bound fields', () => {
    const logger = getLogger({ component: 'test' });
    expect(logger.level).toBeDefined();
    // Should not throw when logging.
    logger.info({ foo: 'bar' }, 'hello');
  });

  it('getTracedLogger works even with no active span', () => {
    const logger = getTracedLogger({ component: 'test' });
    logger.info('no span active');
  });
});

describe('tracing', () => {
  it('withSpan runs the function and returns its result', async () => {
    const result = await withSpan('test.operation', async (span) => {
      span.setAttribute('test.attr', 'value');
      return 42;
    });
    expect(result).toBe(42);
  });

  it('withSpan propagates errors after recording them on the span', async () => {
    await expect(
      withSpan('test.failing-operation', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('metrics', () => {
  it('exposes histogram and counter instruments that can record values', () => {
    expect(() => callDurationMs.record(1234)).not.toThrow();
    expect(() => turnLatencyMs.record(50, { stage: 'llm' })).not.toThrow();
    expect(() => fallbackTotal.add(1)).not.toThrow();
  });
});
