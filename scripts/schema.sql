-- Additive schema changes. Idempotent: safe to run repeatedly.
-- Mirrors prisma/schema.prisma; see scripts/apply-schema.mjs for why this exists.

-- File: which Telegram transport holds the bytes, and resumable-upload key.
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "backend"   TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "resumeKey" TEXT;
CREATE INDEX IF NOT EXISTS "File_userId_resumeKey_idx" ON "File"("userId", "resumeKey");

-- StorageConfig: per-user MTProto session + half-finished login state.
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "mtprotoSession" TEXT;
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "mtprotoUserId"  TEXT;
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "mtprotoPremium" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "pendingSession" TEXT;
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "pendingHash"    TEXT;
ALTER TABLE "StorageConfig" ADD COLUMN IF NOT EXISTS "pendingPhone"   TEXT;

-- OAuthAccount: third-party sign-in linked to a TeleDrive (Telegram) user.
CREATE TABLE IF NOT EXISTS "OAuthAccount" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "provider"   TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "email"      TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthAccount_provider_providerId_key" ON "OAuthAccount"("provider", "providerId");
CREATE INDEX IF NOT EXISTS "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OAuthAccount_userId_fkey') THEN
    ALTER TABLE "OAuthAccount"
      ADD CONSTRAINT "OAuthAccount_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
