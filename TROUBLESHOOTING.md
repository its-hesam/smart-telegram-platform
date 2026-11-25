# Recovery rules

| Failure | Required behavior before business operations are enabled |
|---|---|
| Network loss | Bounded retry before mutation; otherwise UNKNOWN |
| Chromium crash | Close stale process, reconcile PROCESSING, validate session |
| API restart | Recover DB state and pending outbox |
| Redis outage | Backpressure, retain durable outbox, no direct execution |
| DB unavailable | Stop mutations: consent/claim/lease cannot be verified |
| Session expired | AUTH_REQUIRED; owner-assisted login |
| UI changed | UI_ELEMENT_NOT_FOUND; stop affected adapter version |
| Permission/privacy | Fail without retry |
| Restriction | Pause account; no transfer to bypass restriction |
| Worker loss | Fence ownership, terminate stale browser, uncertain mutations UNKNOWN |
| Duplicate job | DB idempotent claim; never repeat attempted recipient |
| WebSocket loss | REST resync from DB |
| RAM shortage | Stop acquisitions and drain idle contexts |
| Disk full | Stop acquisitions/mutations; alert and apply retention |

In phase 1 readiness 503 is expected without PostgreSQL/Redis. Check `.env` and `docker compose ps`. Liveness only confirms the HTTP process. Worker heartbeats are infrastructure probes, not Telegram jobs.
