# Phase 4 — account panel

Implemented Persian RTL responsive panel with Next.js/React/Tailwind, TanStack Query, Zustand UI preferences, React Hook Form/Zod and accessible Radix dialogs/shadcn-style button primitives. Login/logout uses same-origin server forwarding; session/CSRF secrets are not saved in browser persistent storage. Role-aware account list/create/filter/pagination/inspect/pause/delete is connected to the real phase-2 API. Error responses show a traceable request ID, not stack traces. Unavailable Telegram login validation is identified explicitly.

Browser tests use an explicitly named HTTP fixture (not production fake data), check login, consent/ownership gate before account creation, rendered rows and mobile overflow/menu. The actual rendered desktop fixture was visually inspected. Real API/DB behaviors are covered independently by backend integration tests; full authorized Telegram reconnect acceptance remains blocked on phase-3 live verification.

The server-side /v1 forwarder reads API_INTERNAL_URL at runtime, with a fixed backend origin, bounded body and a header allowlist. This avoids build-time localhost rewrites inside Docker. It forwards Origin and CSRF to the API and never exposes backend credentials or accepts a caller-provided target URL.
