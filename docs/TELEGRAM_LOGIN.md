# Panel-assisted Telegram login

Admins can add an authorized phone number, open **ورود تلگرام**, and select **دریافت کد ورود**.
Enter the code supplied by Telegram; if the official UI requests two-step verification,
the panel switches to a masked password field. Telegram chooses the delivery channel;
an SMS is not guaranteed. Only existing accounts and numeric-code login are supported.
Email setup/recovery, account signup and challenges are not automated.

All actions use the official Telegram Web K UI through Playwright. There are no direct
Telegram/MTProto/Bot API calls or private-state inspection. A verified visible chats page
is required before marking a session CONNECTED; sending remains separately disabled.

API `/v1/accounts/:id/login` accepts strict start/status/code/password/cancel commands.
It requires a live ADMIN session, exact Origin, CSRF and rate limits. Commands go directly
to the private worker bridge (port 3002, no host publication), authenticated with a
purpose-separated HMAC token. The worker rechecks the live admin session and binds each
flow to account, actor, session and random flow ID. Secrets never enter a durable queue,
audit metadata, application logs or database. They exist transiently in request/DOM memory.
Only non-secret flow metadata is kept in browser sessionStorage for refresh recovery.

One login/browser at a time; flows expire after ten minutes and allow five secret attempts.
Starting again resumes an active flow owned by the same session without resending a code.
Cancel/expiry closes the browser and encrypts the profile under the existing lease/fencing
rules. A crash or sealing failure requires recovery rather than unsafe ownership release.
Closing the modal does not cancel login; reopen in the same browser to resume, or cancel.

Set WORKER_LOGIN_URL to the private worker origin (localhost:3002 for local development,
http://worker:3002 in production Compose). Use HTTPS on the public panel. Never publish
the bridge port. Multi-worker routing/affinity is outside this single-worker deployment.

Validation: strict typecheck/build, security/contract tests, and browser fixtures covering
phone, invalid/valid code, invalid/valid two-step password, strict origin/selector rejection,
and the real panel's transition between stages. Public phone-login DOM was inspected live;
authenticated widgets were reviewed in official tweb source commit
ae67ff9763a77cce0b9d3ff993c1e0e11637f904. Full live login still needs the owner's account;
fixture success is not a claim of live Telegram authentication or message delivery.

The VPS isolated drill also passed against real PostgreSQL, leases and sandboxed browser:
code/2FA errors and success, session binding, encrypted profile sealing and restoration.
See `tests/recovery/telegram-login-flow.mjs`; all Telegram requests in that drill are fixtures.
