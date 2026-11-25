# Development and production deployment

## Current production package (not locally container-verified)

The actual capability/acceptance table is in docs/STATUS.md. Generate three independent 32-byte hex keys, including PROFILE_ENCRYPTION_KEY. Keep TELEGRAM_MUTATIONS_ENABLED=false for initial setup. On the Ubuntu host, disable swap before production browser profiles are used (`/proc/swaps` must contain no active entries); persistent plaintext profiles run only in tmpfs and closed profiles are authenticated encrypted archives. Store keys outside Git, restrict `.env` to mode 0600 and back them up separately in a secret manager.

For HTTPS use a real domain and valid existing certificate files `fullchain.pem` and `privkey.pem` in TLS_CERT_DIR. Set APP_ORIGIN to the exact HTTPS origin and POSTGRES_* credentials consistently. Review pinned dependency lockfile and pin base/container image digests before a production rollout. Then:
```bash
docker compose -f docker-compose.production.yml config
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d --wait postgres redis
docker compose -f docker-compose.production.yml run --rm migrate
# Provision the least-privilege role below; set APP_DATABASE_URL before starting the API.
docker compose -f docker-compose.production.yml up -d --wait
docker compose -f docker-compose.production.yml ps
```
The proxy is the only public service. Web forwards /v1 to the private API at runtime; /events upgrades directly to API. Production worker is non-root, uses the official Playwright seccomp profile and tmpfs runtime. This configuration has not been built or run here because Docker is unavailable; TLS, sandbox, backup restore and authorized Telegram acceptance must pass before operational use. It is not a verified deployment.

APP_DATABASE_URL must use an application role, not POSTGRES_USER (the bootstrap/migration user). After initial migration, open an interactive psql session as the bootstrap owner:
```bash
docker compose -f docker-compose.production.yml exec postgres psql -U YOUR_BOOTSTRAP_USER -d YOUR_DATABASE
```
Inside psql (replace database identifier and bootstrap role with yours; `\password` securely prompts rather than placing the password in shell history):
```sql
CREATE ROLE smart_app LOGIN;
\password smart_app
GRANT CONNECT ON DATABASE smart TO smart_app;
GRANT USAGE ON SCHEMA public TO smart_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO smart_app;
REVOKE UPDATE, DELETE ON "AuditLog" FROM smart_app;
REVOKE ALL ON "_prisma_migrations" FROM smart_app;
ALTER DEFAULT PRIVILEGES FOR ROLE YOUR_BOOTSTRAP_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smart_app;
```
Set APP_DATABASE_URL using that role and a URL-encoded password at internal host `postgres`. Use a separately injected maintenance connection for retention cleanup (CLEANUP_DATABASE_URL); API roles deliberately cannot alter/delete audits. Initial Compose interpolation still requires APP_DATABASE_URL even when starting selected services, so set the intended role URL before the staged commands. Review grants after each migration. These privilege steps have not been executed against a production database.

Create the first administrator via the migrate build target (which retains tooling) or the compiled runtime provisioning command with temporary ADMIN_EMAIL/ADMIN_PASSWORD environment injection. Existing emails are not overwritten. Panel-assisted phone/code/two-step login uses the private worker bridge at WORKER_LOGIN_URL (port 3002, never publish it). The owner CLI remains an alternative for authorized desktop sessions; no remote-debugging/browser port is published. See docs/TELEGRAM_LOGIN.md and docs/VPS_DEPLOYMENT.md.

The following local-development instructions remain useful; they are not production-hardening evidence.

This Compose is a development foundation, not the final production admin platform. No Telegram browser is started. Ubuntu needs Git, Node 24 LTS and Docker Engine with Compose plugin. Installation references: https://docs.docker.com/engine/install/ubuntu/ and https://nodejs.org/en/download .

## Phase 2 secrets and administrator
Generate two independent keys and put them in DATA_ENCRYPTION_KEY and IDENTITY_HMAC_KEY in .env. Never commit them. Run this command twice:
```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
Set APP_ORIGIN to the exact web origin, without trailing slash. After DB migration, provision your first admin locally. Provide ADMIN_EMAIL/ADMIN_PASSWORD through your secret manager or temporary environment (password at least 14 characters); run `npm run admin:create` and remove those two variables immediately. Do not paste passwords into command-line arguments. Existing emails are never overwritten. For Compose: `docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD api node dist/apps/api/src/create-admin.js` passes existing host environment variables. Use TLS and NODE_ENV=production for a production host; the included Compose remains development-only.

Open API documentation at http://localhost:3001/docs . Business routes use /v1. Login must send Origin matching APP_ORIGIN; subsequent writes send the returned X-CSRF-Token and cookie. There is no login UI until phase 4.

```bash
git clone <your-repository-url> smart-telegram-platform
cd smart-telegram-platform
cp .env.example .env
# Edit .env: replace change-me with a long URL-safe random password;
# keep DATABASE_URL consistent with POSTGRES_*.
npm ci
npm run db:validate
npm run typecheck
npm test
npm run build
docker compose up --build -d --wait
docker compose ps
curl --fail http://localhost:3001/health/live
curl --fail http://localhost:3001/health/ready
npm run test:integration
```

Open http://localhost:3000 locally, or use an SSH tunnel to the VPS. Services bind loopback. For local development run `npm run infra:up`, `npm run db:migrate`, then `npm run dev:api`, `npm run dev:worker` and `npm run dev:web` in separate terminals. PowerShell: `Copy-Item .env.example .env`. Readiness returns 503 when dependencies are unavailable.

Stop with `docker compose down` (keeps volumes). Do not use `down -v` on needed data. PostgreSQL 18 uses /var/lib/postgresql. Redis uses AOF/noeviction. Lockfile fixes JS dependencies; pin image digests during production hardening.

## Backup/restore
Before production, configure encrypted off-host backups, key custody, retention and restore drills. Development DB example:
```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backup.dump
# Restore into an empty, separately configured database only:
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < backup.dump
```
Encrypt dumps immediately and restrict permissions. Browser backups require closed profiles and encrypted storage. Before restoring, stop workers and reconcile uncertain jobs. TLS/reverse proxy, encrypted session volumes, production images and load benchmarks are phase 9–10 work.
