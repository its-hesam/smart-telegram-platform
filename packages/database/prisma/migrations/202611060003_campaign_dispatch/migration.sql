ALTER TABLE "Campaign" ADD COLUMN "creationKey" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT 'legacy';
UPDATE "Campaign" SET "creationKey" = "id"::text;
ALTER TABLE "Campaign" ALTER COLUMN "creationKey" SET NOT NULL;
CREATE UNIQUE INDEX "Campaign_creationKey_key" ON "Campaign"("creationKey");
ALTER TABLE "Campaign" ALTER COLUMN "requestHash" DROP DEFAULT;
ALTER TABLE "Job" ADD COLUMN "workerId" TEXT;
CREATE TABLE "WorkerHeartbeat" ("id" TEXT NOT NULL, "lastSeenAt" TIMESTAMPTZ(3) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id"));
CREATE INDEX "WorkerHeartbeat_expiresAt_idx" ON "WorkerHeartbeat"("expiresAt");
