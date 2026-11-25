-- Job progress, durable checkpoints and export parameters.
ALTER TABLE "Job" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "processed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "totalItems" INTEGER;
ALTER TABLE "Job" ADD COLUMN "checkpoint" JSONB;
ALTER TABLE "Job" ADD COLUMN "params" JSONB;

-- Single operator-level legal basis for outreach. Suppression still wins.
CREATE TABLE "OutreachAuthorization" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "evidenceReference" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "OutreachAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutreachAuthorization_revokedAt_idx" ON "OutreachAuthorization"("revokedAt");
CREATE INDEX "OutreachAuthorization_createdAt_idx" ON "OutreachAuthorization"("createdAt");

ALTER TABLE "OutreachAuthorization"
    ADD CONSTRAINT "OutreachAuthorization_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keyset pagination for streaming exports and fast job progress queries.
CREATE INDEX "Contact_createdAt_id_idx" ON "Contact"("createdAt", "id");
CREATE INDEX "Job_status_type_createdAt_idx" ON "Job"("status", "type", "createdAt");

-- The application uses a least-privilege role. New tables do not inherit
-- grants automatically. The production role is `smart_app`; other installations
-- should re-run infrastructure/deploy/provision-db-role.mjs after migrating.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smart_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "OutreachAuthorization" TO smart_app;
  END IF;
END $$;
