import { Registry, Histogram, Counter, collectDefaultMetrics } from '@prometheus-io/client';
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
export const metrics = new Registry();
collectDefaultMetrics({ register: metrics, prefix: 'smart_' });
export const requestDuration = new Histogram({ name: 'smart_http_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'status'] as const, registers: [metrics] });
export const requestCount = new Counter({ name: 'smart_http_requests_total', help: 'HTTP responses', labelNames: ['method', 'status'] as const, registers: [metrics] });
const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const provider = new TracerProvider({ spanProcessors: endpoint ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: endpoint }) })] : [] });
trace.setGlobalTracerProvider(provider);
export const tracer = provider.getTracer('smart-platform-api', '0.3.12');
export async function shutdownTelemetry() { await provider.shutdown(); }
