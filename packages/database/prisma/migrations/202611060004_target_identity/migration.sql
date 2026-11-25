ALTER TABLE "TelegramTarget" ADD COLUMN "identityKey" TEXT;
UPDATE "TelegramTarget" SET "identityKey" = 'legacy:' || "id"::text;
ALTER TABLE "TelegramTarget" ALTER COLUMN "identityKey" SET NOT NULL;
CREATE UNIQUE INDEX "TelegramTarget_identityKey_key" ON "TelegramTarget"("identityKey");
