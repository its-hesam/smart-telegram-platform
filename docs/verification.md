# Verification — 2026-11-06

## Source-list bug fix and access policy — release 0.3.3

- Investigated three recent real catalog results: COMPLETED but 0 sources, partial=true and skipped=1. Stage-specific reproduction found a dialog-row click timeout; the previous broad catch discarded the whole source and hid the reason.
- Added full-document UI navigation fallback, header retry, dialog readiness and sanitized diagnostic counts. Removed administrative inspection from discovery so its failure cannot discard a source.
- Removed Telegram owner/admin prerequisites from API/export worker and source picker, including the extra checkbox. Platform ADMIN/Origin/CSRF/account-scoping and actual Telegram UI access remain enforced. Normal profile Members is supported before any edit-page fallback; hidden member lists are refused.
- 59 unit/security tests and 9 browser tests passed. Includes intercepted clicks, partial-warning details, non-owner UI/API requests and absence of the checkbox.
- Post-deployment live catalog passed: 1 source, partial=false, skipped=0. Isolated real-DB/browser drill passed for non-owner export and refusal when the member surface disappears, with encrypted results and UNKNOWN consent preserved. Production members were not exported by verification.
- Live production browser also verified non-owner selection, enabled export action without the former confirmation checkbox, populated catalog and mobile layout. Verification did not request a production member export.

## Account sources release 0.3.2

- Strict typecheck/build passed. **59 unit/security tests** and **9 browser tests** passed locally, including source scoping, explicit authorization, ADMIN/CSRF guards, CSV formula escaping, account-dialog selection, managed-group-only export and revoked-admin refusal.
- Live production discovery through authenticated API/outbox/worker completed: **1 source, no skipped sources, partial=false**. The current account was not found in that group's administrator roster, so extraction is disabled for that source. No production member export was requested.
- Live admin browser verified the populated RTL picker, permission restriction and mobile layout. HTTPS/web/API/database/Redis remained healthy after deployment.
- Dedicated smart_sources_fixture DB and sandboxed real Chromium drill passed: source discovery, server-bound selection, durable jobs/outbox, encrypted member results, bounded CSV, UNKNOWN consent/no contact import, runtime permission recheck and refusal after admin removal. Test DB and temporary profiles were removed.
- A VPS writeback-throttle/kernel stall interrupted the first full image build. It was cancelled; a normal host reboot, retained encrypted profile verification and documented vda queue tuning restored I/O. A minimal runtime delta with tested JavaScript/Next assets was deployed while preserving Linux dependencies/Prisma/browser binaries. See [ACCOUNT_SOURCES.md](ACCOUNT_SOURCES.md).

## Panel login release 0.3.1

- Build and strict typecheck passed; **55 unit tests** and **7 browser tests** passed locally. The 55 unit tests also passed in the Linux image build.
- Live VPS: authenticated public login API reached the private worker; cross-flow requests were rejected without sending a Telegram code. Real admin browser login displayed the new code-request dialog. Production sandbox and live Telegram QR-to-phone UI passed without submitting a phone.
- Isolated VPS drill passed with real PostgreSQL, leases, sandboxed Chromium and tmpfs: phone/code/2FA stages, wrong code/password, session binding, idempotent start, CONNECTED only after visible UI, encrypted profile sealing and browser-profile restore. The explicit fixture intercepted every Telegram document request; this was not a live Telegram account login. Dedicated test database and temporary profile directories were removed.
- The drill caught and verified a fix for premature CODE exposure during browser initialization. It is preserved in `tests/recovery/telegram-login-flow.mjs`; it requires an isolated database named `smart_login_fixture`, migrated schema, and production worker environment. Run its contents with Node stdin from `/app` inside a worker container, passing only that isolated DATABASE_URL. Never run it against the production database.
- Graceful worker shutdown waits for login initialization/closure; worker stop grace is 60 seconds. Full owner login acceptance still requires the user's real account.

## Live VPS acceptance

- Production Docker images built on Ubuntu 26.04; API/web healthy, worker heartbeat, private PostgreSQL 18 and Redis 8, nginx public 80/443. Local demo stopped.
- All 9 integration tests in 6 files passed against real PostgreSQL/Redis on the VPS; 52 unit tests passed. Dedicated integration database removed afterwards.
- HTTPS validates from the user computer and server. Real ADMIN login, Secure/HttpOnly/SameSite=Strict host cookie, authenticated APIs/admin metrics, TLS WebSocket handshake and resync event passed.
- Application DB role is not superuser/createdb and cannot update AuditLog.
- Chromium launched as non-root with chromiumSandbox=true after explicitly permitting its user-namespace chroot in custom seccomp; all host capabilities remain dropped.
- First encrypted production DB backup authenticated/decrypted in memory and pg_restore catalog read successfully. This is not a full VPS disaster-recovery drill.
- Details: [VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md).

## Version 0.3.0 — current results (phases 3–10 code)

- Strict typecheck, Prisma schema validation and production build passed for API, worker and Next.js panel.
- Unit/HTTP/security/WebSocket: **52 passed in 6 files**. Includes password/encryption/CSRF/RBAC, bounded contracts, metrics, forged WebSocket handshakes and versioned read-only resync events.
- Chromium tests: **6 passed in 3 files**. Includes full-profile localStorage/IndexedDB recovery and isolation, ciphertext tampering/stale runtime rejection, unexpected browser close without ownership release, strict selector ambiguity/missing handling, visible outgoing confirmation using a local fixture, responsive RTL panel controls, and actual HTTP forwarding of HttpOnly cookie/Origin/CSRF through the built Next proxy. Fixtures never target a real Telegram recipient.
- Real UTF8 PostgreSQL 18.6 integration: **5 passed in 5 files**, run serially in a temporary cluster. Covers auth/account CRUD, lease/fencing/stale lock refusal, CSV and real XLSX import, aliases/dedup/consent/suppression/erasure/list union, campaign template versions/Test Send queue creation/outbox/idempotency/pause/cancel/UNKNOWN, pending-only Redis-loss reconciliation, target/invitation encryption/dedup and operations/settings/audits.
- All **4 migrations** applied to a fresh real DB. Prisma migrate diff between the database and schema returned **No difference detected**.
- Backup/restore drill: **passed** using real PostgreSQL 18.6 pg_dump/pg_restore tools downloaded from the official EDB binary archive into the OS temporary directory. Restored a separate generated test database and successfully decrypted/verified a fixture after restoration. Temporary restore database, dump and server were cleaned up/stopped. No real Telegram data was used.
- Local DB benchmark, final observed run: 500 durable Job inserts **252 ms**, first 100-row query **26 ms**. This is a local database-only measurement, not a browser/account capacity guarantee.
- `npm audit --omit=dev`: reported **0 known vulnerabilities** when executed.
- Development/production Compose and CI files parsed as YAML; seccomp parsed as JSON. This is syntax validation only, not container/runtime validation.
- Public logged-out Telegram Web K was inspected: QR-login heading and phone-login button observed; only those login controls entered the default registry.
- Docker images/Compose, Redis/BullMQ production worker integration, nginx/TLS, Linux container sandbox/tmpfs and a VPS rollout remain **unverified locally**. The real Redis tests are present but not reported as passed. A CI definition exists; no remote CI result is claimed.
- No authorized Telegram account login, live authenticated selector validation, real message sending, group management or join moderation was performed. Mutation execution defaults to disabled. See STATUS.md for incomplete acceptance.

## Phase 2 — historical results


- `npm run typecheck`: passed.
- `npm test`: 48 tests passed across 3 files (policies, health and isolated HTTP/security tests).
- `npm run build`: API, worker, Prisma client and Next.js production build passed.
- Real PostgreSQL 18.6 was started temporarily on loopback using external embedded-postgres tooling installed under the OS temporary directory, outside production/project dependencies. The database used UTF8. Prisma migrate deploy applied the initial migration successfully.
- `vitest run tests/integration/backend.test.ts` against this real DB: passed. Covers actual HTTP auth/account CRUD, token hashing, expiry/logout revocation, store recreation with a persisted session, phone encryption, Persian names, viewer redaction, role enforcement, duplicate rejection, state conflicts, filtered listing, audit trail, and rollback of account creation when audit insert fails. Deliberate FK/unique violations were expected negative test cases. Temporary server was stopped afterward.
- `git diff --check`: passed.
- Compiled phase 2 main-process smoke: /health/live returned 200 with phase=2; with Redis deliberately unavailable, /v1/accounts returned sanitized 503 RATE_LIMITER_UNAVAILABLE and request ID. Temporary API process was stopped.
- Redis atomic rate-limit, Redis/BullMQ transport and full Compose remain unverified locally because Redis/Docker are unavailable. Real-service tests are included in `npm run test:integration` and existing CI configuration, but no remote CI execution is claimed.
- Telegram login, sending and browser-profile management remain phase 3+ and were not attempted. No real Telegram account or recipient was used.

## Phase 1 — historical results

Environment: Windows/PowerShell; Node 24.22.2 installed through nvm because no Node version was active. npm 11.19.1. No Docker executable is available.

| Check | Observed result |
|---|---|
| npm install / lockfile refresh | Successful; npm reported 0 known vulnerabilities at execution time |
| npm run db:validate | Passed |
| Prisma migrate diff from empty | Generated 15,733-byte initial PostgreSQL SQL migration; not applied to a real DB locally |
| npm run typecheck | Passed, including web and integration-test source |
| npm test | 35 passed in 2 files |
| npm run build | Passed: compiled API/worker/Prisma client and optimized Next.js static routes |
| Production API smoke | /health/live HTTP 200; /health/ready HTTP 503 with postgres=false and redis=false using deliberately unavailable loopback dependencies |
| Worker smoke | Started compiled worker and observed structured heartbeat reporting both dependencies unavailable; no Telegram operations enabled |
| Production web HTTP smoke | HTTP 200; Persian title and explicit non-operational phase notice present |
| git diff --check | Passed |
| Docker image / Compose start | Not executed: Docker unavailable |
| Live PostgreSQL migration / Redis / BullMQ integration | Not executed locally; runnable test command and CI service configuration added |
| Telegram UI login / send / session recovery | Not implemented in phase 1; not tested |
| Visual browser QA | Not performed; HTTP content and production build checked only |

CI in .github/workflows/verify.yml is configured for real PostgreSQL 18 and Redis 8, but no remote CI run is claimed. Phase 1 code and offline checks are complete; infrastructure acceptance remains pending real-service verification. There is no claim of production readiness or completion of phases 2–10.
