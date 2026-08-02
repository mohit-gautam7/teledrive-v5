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

-- ── AI platform (Phase 2) ────────────────────────────────────────────────────
-- All additive. The feature is off unless AI_ENABLED=1, so applying this early
-- is harmless.

-- AiKey: per-user bring-your-own provider keys. "encryptedKey" holds AES-256-GCM
-- ciphertext; the plaintext key never leaves the server.
CREATE TABLE IF NOT EXISTS "AiKey" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "nickname"         TEXT NOT NULL,
  "encryptedKey"     TEXT NOT NULL,
  "hint"             TEXT NOT NULL,
  "baseUrl"          TEXT,
  "model"            TEXT,
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "priority"         INTEGER NOT NULL DEFAULT 100,
  "dailyLimitMicros" BIGINT,
  "health"           TEXT NOT NULL DEFAULT 'unknown',
  "failureCount"     INTEGER NOT NULL DEFAULT 0,
  "lastError"        TEXT,
  "lastUsedAt"       TIMESTAMP(3),
  "disabledAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AiKey_userId_provider_nickname_key" ON "AiKey"("userId", "provider", "nickname");
CREATE INDEX IF NOT EXISTS "AiKey_userId_provider_enabled_idx" ON "AiKey"("userId", "provider", "enabled");

-- AiUsage: one row per model call. Tokens always; cost only when a price is known.
CREATE TABLE IF NOT EXISTS "AiUsage" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "keyId"            TEXT,
  "provider"         TEXT NOT NULL,
  "model"            TEXT NOT NULL,
  "task"             TEXT NOT NULL,
  "promptTokens"     INTEGER NOT NULL DEFAULT 0,
  "completionTokens" INTEGER NOT NULL DEFAULT 0,
  "costMicros"       BIGINT,
  "latencyMs"        INTEGER NOT NULL DEFAULT 0,
  "status"           TEXT NOT NULL,
  "error"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_keyId_createdAt_idx" ON "AiUsage"("keyId", "createdAt");

-- Job: durable background queue, claimed with SKIP LOCKED.
CREATE TABLE IF NOT EXISTS "Job" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'queued',
  "priority"    INTEGER NOT NULL DEFAULT 100,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "runAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"   TIMESTAMP(3),
  "finishedAt"  TIMESTAMP(3),
  "result"      JSONB,
  "error"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Job_status_runAt_priority_idx" ON "Job"("status", "runAt", "priority");
CREATE INDEX IF NOT EXISTS "Job_userId_createdAt_idx" ON "Job"("userId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiKey_userId_fkey') THEN
    ALTER TABLE "AiKey" ADD CONSTRAINT "AiKey_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiUsage_userId_fkey') THEN
    ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiUsage_keyId_fkey') THEN
    ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_keyId_fkey"
      FOREIGN KEY ("keyId") REFERENCES "AiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Job_userId_fkey') THEN
    ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AiPreference: per-user AI routing mode and per-task overrides (Phase 2).
CREATE TABLE IF NOT EXISTS "AiPreference" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "mode"          TEXT NOT NULL DEFAULT 'hybrid',
  "strategy"      TEXT NOT NULL DEFAULT 'priority',
  "taskOverrides" JSONB NOT NULL DEFAULT '{}',
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AiPreference_userId_key" ON "AiPreference"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiPreference_userId_fkey') THEN
    ALTER TABLE "AiPreference" ADD CONSTRAINT "AiPreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- FileEmbedding: semantic-search vectors. JSONB rather than pgvector, which is
-- not enabled on this project; an exact scan in the app is accurate and fast
-- enough at personal-drive scale.
CREATE TABLE IF NOT EXISTS "FileEmbedding" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "fileId"     TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "text"       TEXT NOT NULL,
  "vector"     JSONB NOT NULL,
  "model"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileEmbedding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "FileEmbedding_fileId_chunkIndex_key" ON "FileEmbedding"("fileId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "FileEmbedding_userId_idx" ON "FileEmbedding"("userId");

-- Automation: trigger + steps, run by the job worker.
CREATE TABLE IF NOT EXISTS "Automation" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "trigger"   JSONB NOT NULL,
  "steps"     JSONB NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "runCount"  INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Automation_userId_enabled_idx" ON "Automation"("userId", "enabled");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FileEmbedding_userId_fkey') THEN
    ALTER TABLE "FileEmbedding" ADD CONSTRAINT "FileEmbedding_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FileEmbedding_fileId_fkey') THEN
    ALTER TABLE "FileEmbedding" ADD CONSTRAINT "FileEmbedding_fileId_fkey"
      FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Automation_userId_fkey') THEN
    ALTER TABLE "Automation" ADD CONSTRAINT "Automation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
