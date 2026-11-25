# Production deployment example

This is a generic deployment reference. Replace every placeholder with your own values and
never commit production secrets, certificates, database dumps, or browser profiles.

## Host

- Ubuntu 24.04/26.04 (or a comparable Linux distribution)
- Docker Engine + Compose plugin enabled at boot
- 2+ vCPU, 4 GB RAM recommended for one Chromium worker
- Swap disabled when Chromium profile tmpfs is used (`/proc/swaps` must have no active entries)

## Services

- nginx TLS reverse proxy on 80/443
- Next.js web
- NestJS API
- BullMQ worker with Playwright Chromium
- PostgreSQL 18
- Redis 8

Only SSH, HTTP, and HTTPS are published. PostgreSQL, Redis, the API, and the worker login
bridge remain on private Docker networks.

## TLS

Terminate TLS at nginx with certificates from your CA or ACME client. Mount the certificate
directory read-only and set `TLS_CERT_DIR`. Keep HTTP redirected to HTTPS and enable HSTS.

## Secrets

Generate independent values for:

```bash
openssl rand -hex 32   # DATA_ENCRYPTION_KEY
openssl rand -hex 32   # IDENTITY_HMAC_KEY
openssl rand -hex 32   # PROFILE_ENCRYPTION_KEY
```

Store them in a secret manager or a root-owned environment file with mode `0600`. Back up
the keys separately from the database; losing them makes encrypted data unrecoverable.

## Database role

The application should not run as the PostgreSQL bootstrap user. Create a least-privilege
role, grant CRUD on application tables, and deny `UPDATE`/`DELETE` on the audit log and all
access to the migration ledger. See `infrastructure/deploy/provision-db-role.mjs`.

## Browser runtime

- The worker runs as a non-root user with all capabilities dropped.
- Chromium uses the supplied seccomp profile and sandbox.
- The live profile directory is a `tmpfs`; the closed profile is an authenticated encrypted
  archive on a host volume.
- A stale lease is never stolen automatically. Recover a crashed profile manually after
  stopping the owner and preserving the encrypted archive.

## Backup and restore

- Take encrypted database backups on a schedule.
- Store at least one copy off-host and test a full restore.
- Browser profiles are not part of the database backup; preserve them separately.
- Keep an independent backup of the encryption keys.

## Health checks

```bash
docker compose -f docker-compose.production.yml ps
curl -fsS http://127.0.0.1:3001/health/ready
```

The worker exposes a private `/health` endpoint on the login bridge (port 3002). Do not
publish it.

## Upgrade

```bash
docker compose -f docker-compose.production.yml build api web worker
docker compose -f docker-compose.production.yml run --rm migrate
docker compose -f docker-compose.production.yml up -d
```

Migrations are additive where possible. Keep the previous image tags for rollback until the
new release has passed smoke tests.
