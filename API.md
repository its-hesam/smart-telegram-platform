# API v1

Current extension (phases 3–8): /contacts and /contact-lists (CRUD, import/export, consent, membership/merge); /campaigns (validate/start/pause/resume/cancel, immutable template history/revision, one-recipient consented test-send); /targets and /invitations registration; /jobs and cancellation; /analytics/overview and ADMIN-only /analytics/metrics; ADMIN /logs and allowlisted /settings. See generated /docs/openapi.json and docs/phase-5-6.md. POST /v1/accounts/:id/connect now returns 202 with a durable SESSION_VALIDATION job reference and does not claim a connection. Disconnect/session erasure remains Unsupported pending verified lifecycle UI. /health/live now reports the current backend phase. JSON body cap is 1 MiB, with tighter per-field/import limits. /events is a read-only authenticated WebSocket resync stream.

The following phase-2 section describes the original API subset; later behavior is clarified above.

Phase 2 implements GET /health/live and GET /health/ready plus the authenticated routes below. Liveness is independent of infrastructure. Readiness checks real PostgreSQL SELECT 1 and Redis PING with bounded timeouts; dependency failure returns 503. OpenAPI UI is at /docs, JSON at /docs/openapi.json.

| Method | Path | Access / behavior |
|---|---|---|
| POST | /v1/auth/login | Exact configured Origin; email/password; rate limited; sets HttpOnly cookie and returns user/CSRF/expiry |
| GET | /v1/auth/me | Valid non-expired session; returns user and session-bound CSRF |
| POST | /v1/auth/logout | Session, Origin and CSRF; revokes DB session; 204 |
| GET | /v1/accounts | All authenticated roles; bounded page/pageSize, status, sort(createdAt/displayName), order(asc/desc) |
| POST | /v1/accounts | ADMIN; displayName, E.164 phone and ownershipConfirmed=true; encrypted phone; 201 |
| GET | /v1/accounts/:id | Authenticated; phone only for ADMIN |
| PATCH | /v1/accounts/:id | ADMIN; displayName and/or enabled; enabled only changes DISCONNECTED/PAUSED states |
| DELETE | /v1/accounts/:id | ADMIN; only disconnected/paused accounts with no profiles, leases or operation references; 204 |
| GET | /v1/accounts/:id/health | Persisted account status; browser explicitly UNSUPPORTED |
| POST | /v1/accounts/:id/connect or disconnect | ADMIN; validates account then 501 OPERATION_UNSUPPORTED until phase 3 |

Every business mutation requires `Origin: APP_ORIGIN`; authenticated mutations also require `X-CSRF-Token` from login or me. Cookies are SameSite=Strict, HttpOnly, Path=/, expiring; production also uses Secure and __Host- prefix. API never accepts a session token via query or returns it in JSON. State survives API restarts in PostgreSQL. Error shape: `{code,message,requestId}` with a server-generated x-request-id header; validation errors omit submitted values. Conflict=409, validation=400, auth=401, role/CSRF/origin=403, rate=429, infrastructure protection failure=503.

Global rate limit: 120/minute per direct client IP; login 5/15 minutes per normalized-email HMAC and 20/15 minutes per direct IP HMAC. Redis failure blocks business routes. Proxy headers are deliberately not trusted; configure verified trusted proxy addresses before production to avoid grouping clients under the proxy IP.

Later: /contacts import/export, /contact-lists, /targets, /campaigns, /jobs, /logs, /settings, /analytics and WebSocket. These are not implemented yet.

WebSocket envelope: version=1, id, type, occurredAt, resourceId, traceId; no PII. Durable state is recovered via authenticated REST after reconnect. Events never replace persisted state. WebSocket and management routes are not implemented in phase 1.
