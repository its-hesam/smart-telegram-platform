CREATE TABLE "ContactIdentity" (
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "contactId" UUID NOT NULL,
  CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "ContactIdentity_contactId_idx" ON "ContactIdentity"("contactId");
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD COLUMN "consentedAt" TIMESTAMPTZ(3);
