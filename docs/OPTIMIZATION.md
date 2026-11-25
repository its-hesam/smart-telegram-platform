# Optimization and scale release — 0.3.12

This release keeps the safety boundary (suppression always wins) while removing
the per-contact consent friction and the arbitrary export/source limits.

## 1. Legal authorization instead of per-contact consent

- New table `OutreachAuthorization`: one explicit, audited operator-level record
  with an evidence reference (`POST /v1/settings/outreach-authorization`).
- The Contacts UI no longer asks for consent per contact. It exposes only
  **منع ارسال** (suppression).
- Campaign start requires an active authorization. Without one the API returns
  `AUTHORIZATION_MISSING` before building an audience.
- `canContact(consent, authorized)` bypasses the per-contact consent fields when
  authorized, but **never** bypasses suppression.
- Revoking authorization pauses campaigns at the next pre-mutation check.
- Contact exports no longer contain a `consentStatus` column.

`POST /v1/settings/outreach-authorization` body:

```json
{ "evidenceReference": "contract/2026-11" }
```

`DELETE /v1/settings/outreach-authorization` revokes the active record.
`GET /v1/settings/outreach-authorization` returns the active record and history.

## 2. Unbounded, async contact export

### Async job (recommended)

1. `POST /v1/contacts/export/jobs` — body `{ "format": "csv" | "xlsx", ...filters }`
   returns `202 { jobId, status }`.
2. `GET /v1/contacts/export/jobs/:id` — `progress`, `processed`, `totalItems`,
   `status`, `errorCode`.
3. `GET /v1/contacts/export/jobs/:id/file` — downloads the finished file.
4. `POST /v1/contacts/export/jobs/:id/resume` — resumes a `FAILED`/`CANCELLED` job
   from its checkpoint.

### Direct stream (CSV)

`GET /v1/contacts/export` streams CSV with keyset pagination and no 100-row cap.
Filters: `consentStatus`, `listId`, `tag`.

### How it works

- Contacts are read in batches (`EXPORT_BATCH_SIZE`, default 500) by `id`.
- CSV is appended with durable `checkpoint { lastId, bytes, processed }` after
  each batch; a resumed CSV truncates to the last committed byte offset, so it
  cannot duplicate rows.
- XLSX is written at the end of the job; a resumed XLSX restarts from the first
  row (safe, read-only).
- Files are written with mode `0600` under `EXPORT_ROOT` (default `/exports` in
  production Compose). The API and worker share the `exports` volume.
- Cancellation is checked between batches.

## 3. Batched campaign start

- Audience selection is one SQL query with `NOT EXISTS` suppression checks; it
  no longer loads contact rows and identities into Node memory.
- Recipients are inserted with `createManyAndReturn` in chunks of 1000.
- Jobs and outbox rows are inserted with `createMany` in chunks of 1000.
- Transaction timeout is 120 s, and the arbitrary 1000-contact audience cap is
  removed.
- `start` returns `eligible` and `excluded` counts.

## 4. Worker and database

- New `Job` fields: `progress`, `processed`, `totalItems`, `checkpoint`, `params`.
- New indexes: `Contact(createdAt, id)`, `Job(status, type, createdAt)`.
- Outbox dispatch batch is configurable (`WORKER_DISPATCH_BATCH`, default 500).
- Dispatch/heartbeat runs every 2 s; recovery/reconcile runs every
  `WORKER_MAINTENANCE_MS` (default 15 s), reducing steady-state DB load.
- Orphaned `DATA_EXPORT` jobs return to `PENDING` instead of `UNKNOWN`.
- The worker exposes `GET /health` on the private login bridge (port 3002); the
  Compose worker now has a healthcheck.
- Source and member jobs write progress and `totalItems`; member profiles are
  inspected with a 30-minute budget instead of a 5-minute cut-off.
- The source catalog scan and member scan use time budgets instead of the old
  100/150-iteration caps.

## 5. Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `EXPORT_ROOT` | `/tmp/smart-exports` | Shared export directory |
| `EXPORT_BATCH_SIZE` | `500` | Contacts per export batch |
| `IMPORT_MAX_ROWS` | `5000` | Maximum rows per import |
| `WORKER_DISPATCH_BATCH` | `500` | Outbox events per dispatch tick |
| `WORKER_MAINTENANCE_MS` | `15000` | Recovery/reconcile interval |

Production Compose sets `EXPORT_ROOT=/exports` and mounts the `exports` volume on
both `api` and `worker`.

## 6. Migration

`packages/database/prisma/migrations/202611240001_optimization/migration.sql`

- Adds the five `Job` columns.
- Creates `OutreachAuthorization` and its indexes/FK.
- Adds the two hot-path indexes.

The migration is additive and was verified against a live-data copy without data loss. It grants the new table to the production
`smart_app` role. For a different application role, re-run
`infrastructure/deploy/provision-db-role.mjs` after migrating; it also sets
future-table default privileges.

## 7. Verification performed

- `npm run typecheck` — pass (API, worker, packages, web).
- `npm test` — 65 unit tests pass.
- `npm run build` — API/worker TypeScript and Next.js production build pass.
- Migration drill on a fresh database — pass.
- Migration drill on a copy of the live database — pass; counts preserved
  (accounts, contacts and jobs).
- Functional drill (`tests/recovery/optimization-drill.ts`) on a temporary
  database:
  - campaign start rejected with `AUTHORIZATION_MISSING`;
  - authorized start created one recipient, one job, one outbox event;
  - CSV export completed with progress and no consent column;
  - XLSX export completed and was read back with the expected header/row;
  - a deliberately failed export was resumed and completed.
- API smoke test on a temporary database:
  - `/health/ready` and `/health/live` (phase 10, version 0.3.12);
  - ADMIN login and CSRF cookie flow;
  - `POST /v1/settings/outreach-authorization` created an active record;
  - `POST /v1/contacts/export/jobs` queued a `DATA_EXPORT` job;
  - `GET /v1/contacts/export` streamed the CSV header with
    `Content-Type: text/csv`.
- Docker image build of `Dockerfile.production` — pass.

## 8. Deployment example

```bash
# 1. Build the new image from the release copy
cd smart-telegram-platform
docker compose -f docker-compose.production.yml build api web worker

# 2. Run migrations through the existing migrate service
docker compose -f docker-compose.production.yml run --rm migrate

# 3. Point your release symlink at this directory and recreate api/worker/web
#    (adjust the path to your deployment layout)
docker compose -f docker-compose.production.yml up -d api worker web proxy

# 4. Verify
curl -fsS http://127.0.0.1:3001/health/ready
docker compose -f docker-compose.production.yml ps
```

Rollback: point `current` back to `0.3.11` and recreate the same services. The
new columns/table are backward-compatible with 0.3.11.

Sending remains disabled by default (`TELEGRAM_MUTATIONS_ENABLED=false`) and
still requires a verified selector registry.
