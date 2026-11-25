# Verification

Current suites separate offline fixtures from real infrastructure. See docs/verification.md for observed results and docs/STATUS.md for unverified acceptance. No test is allowed to send unwanted real Telegram messages.

`npm test`: domain policies, consent, templates, cryptography, HTTP auth/RBAC/CSRF/input protection, metrics, read-only authenticated WebSocket and unavailable loopback health. HTTP security tests use an explicitly isolated repository fixture; no production fake repository exists.

`npm run db:validate`, `npm run typecheck`, `npm run build`: schema, strict TypeScript and production web/API/worker compilation.

`npm run test:integration`: serial tests against real PostgreSQL and Redis. Requires DATABASE_URL naming a dedicated database ending in _test and applied migrations. Includes DB repositories/transactions, lease ownership, contacts/CSV/XLSX/suppression, campaigns/outbox/UNKNOWN, target/invitation registration, Redis atomic rate windows, generic BullMQ transport and real outbox-to-worker duplicate claims. Missing infrastructure fails rather than skips. Use a dedicated Redis database too. No Telegram operations.

`npm run test:browser`: build the web app first, then install Chromium with `node node_modules/playwright/cli.js install chromium`. Runs local profile/adapter fixtures and the built panel/proxy using ports 3190/3191. Screenshot docs/dashboard-desktop.png contains fixture data only. Does not verify Telegram authenticated selectors.

`npm run test:restore`: dedicated *_test DB and matching-major pg_dump/pg_restore binaries required (PG_DUMP/PG_RESTORE override paths). Dumps the test DB, restores a generated temporary DB, verifies an encrypted fixture, drops the generated restore DB and deletes the dump. Never target production.

`node --env-file=.env --import tsx tests/load/database.ts`: 500-Job DB-only benchmark on *_test. It cleans up its own records and does not provide a Telegram capacity estimate.

Still required: authorized Telegram login/reconnect/test send, live UI permission/selector validation, full real Redis worker outage tests, container/TLS acceptance, multi-worker/browser load and independent security review.
