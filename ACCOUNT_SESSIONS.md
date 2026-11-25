# Account sessions

Panel login: admins use `POST /v1/accounts/:id/login` through the web dialog for phone/code and optional two-step password. Secrets are transient, never queued or persisted. The worker uses the official Telegram Web UI, requires visible authenticated chat navigation before CONNECTED, then closes and encrypts the profile. See [the login guide](docs/TELEGRAM_LOGIN.md).

Alternative owner CLI: `npm run owner:login` (ACCOUNT_ID and PROFILE_* settings) opens visible Chromium. In this CLI mode, OTP/2FA are entered directly in that browser and console Enter closes/encrypts. `POST /v1/accounts/:id/connect` remains the legacy registry-based validation job; message selectors/operations still require a separate authenticated registry.

ProfileVault seals the full closed Chromium directory using tar + AES-256-GCM, account-bound AAD, random nonces, authenticated restore before extraction and atomic ciphertext replacement. Linux production runtime must be tmpfs; Docker Compose supplies it. Runtime leftovers after crashes refuse automatic reuse. The archive includes IndexedDB/localStorage and is not just storageState. Keep PROFILE_ENCRYPTION_KEY separate from other keys and back it up in a secret manager. No key-rotation tool is shipped yet.

Stale leases are never automatically stolen. Before any manual repair: stop the owning worker, confirm no process uses the runtime profile, preserve encrypted backup, review UNKNOWN jobs and inspect archive integrity. Never delete a lease or runtime directory merely to unblock a second browser. A controlled recovery CLI and authorized Telegram restart drill remain acceptance work.

Use independent persistent Chromium profiles to retain IndexedDB, local storage and cookies. Do not assume storageState captures an entire browser profile. Full profile lives on an encrypted host volume, never a repository or public/static directory. Linux worker owns files (directory 0700, files 0600); profile access is not exposed over HTTP.

Acquire durable exclusive account lease before opening profile; check heartbeat before mutations, close browser on ownership loss, confirm prior process terminated before takeover. Fail closed when lock/database unavailable. Store profile reference and encryption key version, not raw tokens, in DB. Close Chromium before archiving or backing up a profile. Restore only after integrity/key verification. Restart validates session through UI; expired session becomes AUTH_REQUIRED.

Owner completes QR/OTP/2FA through restricted authenticated interactive login surface in phase 3. Never persist credentials, OTPs, screenshots of auth, or expose remote-debugging ports. Diagnostic screenshots are opt-in, redacted, permission restricted and short-lived. No live session storage is created in phase 1.
