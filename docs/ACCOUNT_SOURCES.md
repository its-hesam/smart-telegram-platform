# Account sources and visible-member export

The account-sources feature lets an operator browse the groups and channels visible to a
connected Telegram account, select sources, and export the members that Telegram itself
displays to that account.

## Flow

1. Choose a connected account.
2. Refresh the account's visible source catalog.
3. Select one or more groups/channels.
4. Register the selected sources, optionally extracting members in the same action.
5. Poll the job list for progress and download CSV/XLSX when complete.

The catalog and member result are stored encrypted in the durable job result. Contacts
imported from an export are deduplicated by Telegram ID/username and do not receive
per-contact consent automatically. Campaign eligibility is governed by the operator-level
legal authorization and by suppression.

## What is read

Only rendered UI is read:

- visible dialog rows for groups/channels;
- the Members/Subscribers surface shown to the signed-in account;
- a username only when it is visible in the member's profile.

Hidden members, hidden usernames, phone numbers, private-state reads, Bot API, MTProto, and
internal Telegram endpoints are not used. If Telegram does not expose the member surface,
the job fails with `SOURCE_MEMBERS_UNAVAILABLE` rather than guessing.

## Limits and failure behavior

- The scan uses a time budget and reports `partial=true` when it reaches the budget.
- Member profile inspection is time-budgeted; unchecked profiles are marked
  `NOT_CHECKED`, and profiles without a visible username are marked `NOT_VISIBLE`.
- Rows are capped by the configured Telegram-visible surface; no hidden roster is claimed.
- Unsupported UI fails closed with a sanitized error code.
- Large exports run asynchronously and expose progress, processed count, and total items.

## Export formats

- CSV: UTF-8 with BOM, quoted fields, formula escaping, fixed columns.
- XLSX: real spreadsheet cells with inline strings; Telegram IDs remain text.

Columns include display name, username, numeric Telegram ID, Telegram Web reference,
observation time, partial flag, and username status. Consent is not an export column.

## Endpoints

All endpoints require an authenticated admin session; writes also require exact Origin and
CSRF.

```http
GET  /v1/accounts/:id/sources
POST /v1/accounts/:id/sources/refresh
POST /v1/accounts/:id/sources/select
POST /v1/targets/:id/extract-members
GET  /v1/targets/member-exports/recent
GET  /v1/targets/member-exports/:id/csv
GET  /v1/targets/member-exports/:id/xlsx
POST /v1/targets/member-exports/:id/import
```

## Authorization note

Selection and export are actions initiated by an authenticated administrator. They do not
claim Telegram ownership or administrator rights. The operator is responsible for having a
lawful basis to process the exported data and for complying with Telegram's Terms of
Service and applicable privacy law.
