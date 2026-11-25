# Database design

PostgreSQL with Prisma. UUID identifiers, timestamptz timestamps, explicit foreign keys. Contacts belong to many lists. Campaigns reference immutable template versions, lists and a sender; recipients enforce unique (campaignId, contactId) plus idempotencyKey. Account profiles contain opaque storage references, never session secrets in API responses.

AdminUser → AuthSession / AuditLog. TelegramAccount → AccountSession / AccountLease / AccountRestriction / Job / CampaignRecipient. Contact → ContactIdentity / ConsentRecord / ContactListMember / CampaignRecipient; Suppression is independent of erasure. Campaign → CampaignRecipient / Job. Job → OutboxEvent and workerId; WorkerHeartbeat determines orphan state. TelegramTarget → Invitation with a separate canonical HMAC identity.

PII/template/link fields use authenticated application encryption. Alias lookup uses keyed HMAC, not low-entropy plain hashes. ConsentRecord preserves consentedAt and recordedAt plus evidence references; Suppression takes precedence and survives erasure as a one-way lookup key. Key rotation tooling is not yet implemented: do not change keys without a migration plan. Campaign creationKey/requestHash and unique campaign-recipient/idempotency keys prevent repeated creation/execution. Unknown recipients require manual reconciliation.

Restrict deletion of referenced accounts, campaigns and templates. Contact deletion sets historical recipient references null so job outcomes survive; delete consent records and list membership. Remove payloads and PII from audit metadata during erasure. Audit actors set null when admin deleted. Retention and cryptographic erasure must include backups and exported data. Uniqueness of nullable identifiers follows PostgreSQL semantics.

Migrations live in packages/database/prisma/migrations. Run `npm run db:migrate` after reviewing generated SQL. Never use db push in production.
