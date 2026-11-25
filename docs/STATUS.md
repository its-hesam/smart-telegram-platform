# Project status

**Version:** 0.3.12

This is an actively developed self-hosted project, not a turnkey audited product. The code,
tests, migrations, and Docker images are maintained together; capabilities that are not
verified are reported as unsupported rather than simulated.

## Implemented

- Admin authentication, roles, account CRUD, encrypted phone storage.
- Panel-assisted Telegram login (phone → code → optional 2FA) through the official web UI.
- Persistent Chromium profiles with an AES-256-GCM full-profile vault, tmpfs runtime, lease,
  fencing token, and manual-recovery safety.
- Contact CRUD, CSV/XLSX import, tags, lists, merge, suppression, and async exports.
- Visible group/channel catalog and visible-member export with username enrichment.
- Campaigns with encrypted versioned templates, audience validation, durable outbox,
  pause/resume/cancel, and `UNKNOWN` outcomes without automatic replay.
- Jobs with progress, checkpoints, resumable exports, audit viewer, analytics, WebSocket
  resync, and Prometheus metrics.
- One auditable operator-level legal authorization for outreach; suppression always wins.

## Verified in this repository

- TypeScript typecheck across API, worker, packages, and web.
- Unit tests for policy, security, export, and queue behavior.
- Prisma migration on a fresh database and on a copied live-data database.
- Playwright browser fixtures for login and account-source flows.
- A recovery drill for authorization-gated campaign start, CSV/XLSX export, and export resume.
- Production image build with non-root runtime and a sandboxed Chromium worker.

## Remaining work

- Install and verify an authenticated selector registry on an authorized test account.
- Enable and validate real message sending only after selector review.
- Key-rotation tooling and offsite disaster-recovery drills.
- Multi-worker load, Redis outage, and browser-crash drills at production scale.
- Independent security review.
- Encrypted server-side search and large-dataset reporting.
- Full distributed tracing and alerting.

Message sending is disabled by default. A missing selector or unsupported UI fails closed
with `OPERATION_UNSUPPORTED`; it is never reported as a successful send.
