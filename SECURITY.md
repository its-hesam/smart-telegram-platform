# Security policy

## Supported version

Security fixes target the current `main` branch and the latest tagged release. This project
is actively developed and has not undergone an independent security audit.

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately to the maintainers
with:

- affected version/commit,
- a minimal reproduction,
- impact and prerequisites,
- any suggested fix.

Never include real Telegram credentials, OTPs, phone numbers, browser profiles, database
dumps, or production secrets in a report.

## Security model

- Only the official Telegram Web K UI is automated through Playwright.
- No Bot API, MTProto, internal HTTP calls, hidden-state reads, or selector guessing.
- Message sending is disabled by default and requires a verified selector registry.
- A send that may have reached Telegram is marked `UNKNOWN`; it is never replayed
  automatically.
- One auditable operator-level legal authorization is required for campaigns.
- Suppression always overrides an authorization.

## Implemented controls

- Argon2id password hashing (64 MiB, 3 passes, parallelism 1).
- Random 256-bit opaque sessions stored only as SHA-256 hashes.
- Bounded session expiry; `HttpOnly`, `SameSite=Strict`, production `Secure` and
  `__Host-` cookies.
- Exact `Origin` checks and session-bound CSRF HMAC.
- Restricted credentialed CORS, role guards, Zod validation, 1 MiB JSON body cap.
- Helmet headers, request IDs, structured logs without bodies, queries, cookies, or phones.
- Distributed Redis rate limits; fail-closed business routes when Redis is unavailable.
- AES-256-GCM field encryption with per-record AAD contexts.
- Keyed HMAC-SHA256 for deduplication identity.
- Independent `DATA_ENCRYPTION_KEY`, `IDENTITY_HMAC_KEY`, and `PROFILE_ENCRYPTION_KEY`.
- Full Chromium profile encrypted as an authenticated archive; tmpfs runtime; `0700`
  directories; no profile access over HTTP.
- Durable account lease with fencing token and heartbeat; stale leases require manual
  recovery.
- Queue payloads contain job/trace IDs only, never contacts, phones, or message text.
- Audit rows commit in the same transaction as the corresponding mutation.
- Database and Redis are private in production; only the TLS reverse proxy is published.
- Non-root API/worker containers, dropped capabilities, no-new-privileges, worker seccomp
  profile, and sandboxed Chromium.

## Secrets

Generate three independent 32-byte random keys encoded as 64 hex characters. Store them in
a secret manager or a root-owned environment file with mode `0600`. Back up the keys
separately from the database. Losing `PROFILE_ENCRYPTION_KEY` makes existing browser
profiles unrecoverable; losing `DATA_ENCRYPTION_KEY` makes encrypted fields unreadable.

Never commit `.env` files, certificates, database dumps, browser profiles, logs, or real
contact data.

## Remaining security work

- Key-rotation tooling and migration procedure.
- Independent penetration test and threat-model review.
- Off-host encrypted backups and a full restore drill.
- Multi-worker isolation and load/failure testing.
- Audit retention and write-only database roles.
- Verified trusted-proxy configuration and client-IP forwarding.
- Alerting for failed leases, repeated `UNKNOWN` outcomes, and worker outages.
