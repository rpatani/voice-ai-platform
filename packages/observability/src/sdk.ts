import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface ObservabilityOptions {
  /** Name shown in Grafana/Tempo for this service, e.g. "voice-agent". */
  serviceName: string;
  serviceVersion?: string;
  /**
   * Base URL of the OTLP/HTTP endpoint (the OpenTelemetry Collector).
   * Defaults to OTEL_EXPORTER_OTLP_ENDPOINT or http://localhost:4318.
   */
  otlpEndpoint?: string;
}

let sdk: NodeSDK | undefined;

/**
 * Initializes OpenTelemetry tracing + metrics for this process and starts
 * exporting to the configured OTLP collector. Safe to call once at the top
 * of the application entrypoint, before any other imports that should be
 * auto-instrumented (HTTP, pg, ioredis, etc).
 */
export function initObservability(options: ObservabilityOptions): void {
  if (sdk) return;

  const endpoint = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation is extremely noisy and rarely useful.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = (): void => {
    void shutdownObservability().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Flush and shut down the OpenTelemetry SDK. Call on graceful shutdown. */
export async function shutdownObservability(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}
