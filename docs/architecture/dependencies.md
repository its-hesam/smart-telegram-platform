# Dependency decisions — 2026-11-06

Version 0.3.0 adds persistent Playwright runtime, tar profile archiving, CSV parsing/stringifying, read-excel-file 9.x (named readSheet API, isolated in a worker), Radix/lucide/form/query/state/chart dependencies and websocket/telemetry packages. Deprecated OTel 2.x/prom-client were replaced during compatibility checks by @opentelemetry/sdk-trace 3.1.0 + API 1.10.0 + OTLP exporter 0.301.0 and @prometheus-io/client. Exact versions are pinned in the lockfile; no force/legacy-peer-deps bypass was used. PostgreSQL client tools for the local restore drill were obtained from the official EDB 18.6 Windows binaries archive, outside project dependencies. Container images still need deployment-specific digest pinning.

Phase 2 additions resolved and pinned: @nestjs/swagger 12.1.0, argon2 0.45.2, cookie-parser 1.4.7 and helmet 8.3.0. Official Nest guard/exception/OpenAPI documentation and Node crypto behavior were checked before implementation. Temporary embedded-postgres 18.6.0-beta.19 is external test tooling only and was not added to the application dependency tree. Its actual server identifies as PostgreSQL 18.6.

Registry stable versions checked before installation and frozen in package-lock.json. Node 24 LTS satisfies framework requirements. Prisma latest pointed to 8.0.0-rc.30; selected stable 7.10.1. TypeScript 6.0.3 matches the Nest 12 documented major; TypeScript 7 awaits verified framework compatibility.

Official references reviewed:
- https://nextjs.org/docs/app/getting-started/installation
- https://docs.nestjs.com/migration-guide
- https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/database-drivers
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context

Registry stable resolutions: Next 16.4.5, Nest 12.3.3, Prisma 7.10.1, Playwright 1.65.0, BullMQ 6.7.0, React 19.3.1, Tailwind 4.3.4, Zod 4.6.7 and Vitest 5.1.0. Build/test results determine compatibility, not release dates. Digest pinning and security review remain production hardening work.
