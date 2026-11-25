# Observability milestone

Current API has Pino request IDs/trace IDs, administrator-only Prometheus metrics at /v1/analytics/metrics, optional OTLP HTTP span export, worker heartbeats and database aggregates. WebSocket resync events are authenticated and data-minimal. No collector/alerting deployment is claimed. See docs/phase-7-10.md for limits and pending distributed tracing work.
