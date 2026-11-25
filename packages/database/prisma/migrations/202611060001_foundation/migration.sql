-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('DISCONNECTED', 'AUTH_REQUIRED', 'AUTHENTICATING', 'CONNECTED', 'SESSION_EXPIRED', 'ACTION_REQUIRED', 'RESTRICTED', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'VALIDATING', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT_UI_CONFIRMED', 'UNKNOWN', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('SESSION_VALIDATION', 'ACCOUNT_HEALTH_CHECK', 'APPROVED_MESSAGE_SEND', 'CAMPAIGN_EXECUTION', 'GROUP_INFORMATION_READ', 'INVITATION_MANAGEMENT', 'CONSENT_IMPORT', 'DATA_EXPORT', 'CLEANUP', 'REPORT_GENERATION');

-- CreateEnum
CREATE TYPE "TargetType" AS ENUM ('GROUP', 'CHANNEL');

-- CreateEnum
CREATE TYPE "OwnershipStatus" AS ENUM ('UNVERIFIED', 'OWNER', 'ADMINISTRATOR', 'MEMBER');

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramAccount" (
    "id" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "encryptedPhone" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastActiveAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSession" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "profileReference" TEXT NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'AUTH_REQUIRED',
    "lastValidatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLease" (
    "accountId" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccountLease_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "identityKey" TEXT NOT NULL,
    "encryptedUsername" TEXT,
    "encryptedTelegramId" TEXT,
    "encryptedPhone" TEXT,
    "encryptedDisplayName" TEXT NOT NULL,
    "encryptedNotes" TEXT,
    "source" TEXT NOT NULL,
    "sourceReference" TEXT,
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consentTimestamp" TIMESTAMPTZ(3),
    "consentEvidenceReference" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastContactAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "evidenceReference" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "identityKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("identityKey")
);

-- CreateTable
CREATE TABLE "ContactList" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactListMember" (
    "id" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactListMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramTarget" (
    "id" UUID NOT NULL,
    "type" "TargetType" NOT NULL,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownershipStatus" "OwnershipStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "encryptedLink" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "messageTemplateId" UUID NOT NULL,
    "contactListId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "contactId" UUID,
    "accountId" UUID NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attemptedAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "accountId" UUID,
    "campaignId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payloadReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "traceId" UUID NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "cancellationRequestedAt" TIMESTAMPTZ(3),
    "scheduledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "result" JSONB,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountRestriction" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "restrictionType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AccountRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_identityKey_key" ON "TelegramAccount"("identityKey");

-- CreateIndex
CREATE INDEX "TelegramAccount_status_idx" ON "TelegramAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSession_profileReference_key" ON "AccountSession"("profileReference");

-- CreateIndex
CREATE INDEX "AccountSession_accountId_idx" ON "AccountSession"("accountId");

-- CreateIndex
CREATE INDEX "AccountLease_expiresAt_idx" ON "AccountLease"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_identityKey_key" ON "Contact"("identityKey");

-- CreateIndex
CREATE INDEX "Contact_consentStatus_idx" ON "Contact"("consentStatus");

-- CreateIndex
CREATE INDEX "Contact_tags_idx" ON "Contact" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "ConsentRecord_contactId_recordedAt_idx" ON "ConsentRecord"("contactId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactList_name_key" ON "ContactList"("name");

-- CreateIndex
CREATE INDEX "ContactListMember_contactId_idx" ON "ContactListMember"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactListMember_listId_contactId_key" ON "ContactListMember"("listId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramTarget_reference_key" ON "TelegramTarget"("reference");

-- CreateIndex
CREATE INDEX "Invitation_targetId_idx" ON "Invitation"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_name_version_key" ON "MessageTemplate"("name", "version");

-- CreateIndex
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Campaign_accountId_idx" ON "Campaign"("accountId");

-- CreateIndex
CREATE INDEX "Campaign_messageTemplateId_idx" ON "Campaign"("messageTemplateId");

-- CreateIndex
CREATE INDEX "Campaign_contactListId_idx" ON "Campaign"("contactListId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_idempotencyKey_key" ON "CampaignRecipient"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_status_idx" ON "CampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignRecipient_accountId_idx" ON "CampaignRecipient"("accountId");

-- CreateIndex
CREATE INDEX "CampaignRecipient_contactId_idx" ON "CampaignRecipient"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_contactId_key" ON "CampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_scheduledAt_priority_idx" ON "Job"("status", "scheduledAt", "priority");

-- CreateIndex
CREATE INDEX "Job_accountId_status_idx" ON "Job"("accountId", "status");

-- CreateIndex
CREATE INDEX "Job_campaignId_idx" ON "Job"("campaignId");

-- CreateIndex
CREATE INDEX "Job_traceId_idx" ON "Job"("traceId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_jobId_idx" ON "OutboxEvent"("jobId");

-- CreateIndex
CREATE INDEX "AccountRestriction_accountId_resolvedAt_idx" ON "AccountRestriction"("accountId", "resolvedAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_timestamp_idx" ON "AuditLog"("resourceType", "resourceId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSession" ADD CONSTRAINT "AccountSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLease" ADD CONSTRAINT "AccountLease_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactListMember" ADD CONSTRAINT "ContactListMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "TelegramTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_messageTemplateId_fkey" FOREIGN KEY ("messageTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_contactListId_fkey" FOREIGN KEY ("contactListId") REFERENCES "ContactList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRestriction" ADD CONSTRAINT "AccountRestriction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
