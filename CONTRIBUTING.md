# Contributing

Thanks for considering a contribution.

## Development setup

```bash
cp .env.example .env
# set DATABASE_URL, REDIS_URL and three independent 64-hex keys
npm ci
npm run infra:up
npm run db:migrate
npm run typecheck
npm test
```

Use Node.js 24.15+ < 25.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Run `npm run typecheck`, `npm test`, and `npm run build` before opening a PR.
- Add or update tests for policy, security, export, or queue behavior.
- Never commit `.env` files, real phone numbers, usernames, tokens, certificates, database
  dumps, browser profiles, or production logs.
- New database changes must include a Prisma migration; do not use `db push` for production.
- UI text is Persian/RTL first. Keep new labels consistent with the existing panel.

## Security reports

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) and report
privately to the maintainers.

## Legal use

This project automates the official Telegram Web UI. Contributions must not add Bot API,
MTProto, hidden-state extraction, consent bypasses, rate-limit evasion, or unsolicited
messaging features. Keep the suppression and legal-authorization checks intact.
