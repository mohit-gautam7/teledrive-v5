import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getProvider } from "@/lib/ai/providers";

/**
 * Per-user storage for bring-your-own API keys.
 *
 * The plaintext key exists in exactly two places: the request that created it,
 * and the moment a provider call is made. Everything else — every list, every
 * API response, every log line — sees only `hint`, the last four characters.
 *
 * `encryptedKey` is AES-256-GCM under SESSION_ENCRYPTION_KEY (lib/crypto). If
 * that variable is unset, lib/crypto stores the value as-is, so the vault
 * refuses to accept keys rather than persisting secrets in the clear.
 */

/** Exactly the fields that may reach a browser. `encryptedKey` is not among them. */
export const PUBLIC_KEY_FIELDS = {
  id: true,
  provider: true,
  nickname: true,
  hint: true,
  baseUrl: true,
  model: true,
  enabled: true,
  priority: true,
  dailyLimitMicros: true,
  health: true,
  failureCount: true,
  lastError: true,
  lastUsedAt: true,
  disabledAt: true,
  createdAt: true
} as const;

export class VaultError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "VaultError";
    this.status = status;
  }
}

function assertEncryptionConfigured() {
  if (!process.env.SESSION_ENCRYPTION_KEY) {
    throw new VaultError(
      "SESSION_ENCRYPTION_KEY is not set, so API keys cannot be stored encrypted. Set it before adding keys.",
      503
    );
  }
}

export type NewKeyInput = {
  provider: string;
  nickname: string;
  apiKey: string;
  baseUrl?: string | null;
  model?: string | null;
  priority?: number;
  dailyLimitMicros?: bigint | null;
};

export async function addKey(userId: string, input: NewKeyInput) {
  assertEncryptionConfigured();

  const spec = getProvider(input.provider);
  if (!spec) throw new VaultError(`Unknown provider "${input.provider}".`);

  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new VaultError("The API key is empty.");

  const baseUrl = input.baseUrl?.trim() || null;
  // A provider with no default endpoint (a local runtime) is only reachable if
  // the key carries its own URL.
  if (!spec.baseUrl && !baseUrl) {
    throw new VaultError(`${spec.label} needs a base URL, e.g. http://localhost:11434/v1`);
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    throw new VaultError("The base URL must start with http:// or https://");
  }

  // Model is required rather than defaulted: which models a key can reach
  // depends on the account behind it, and a guessed default fails confusingly.
  const model = input.model?.trim() || null;
  if (!model) throw new VaultError("Choose a model for this key.");

  const nickname = input.nickname.trim() || spec.label;

  const existing = await prisma.aiKey.findFirst({
    where: { userId, provider: input.provider, nickname },
    select: { id: true }
  });
  if (existing) throw new VaultError(`You already have a ${spec.label} key called "${nickname}".`, 409);

  return prisma.aiKey.create({
    data: {
      userId,
      provider: input.provider,
      nickname,
      encryptedKey: encryptSecret(apiKey),
      hint: apiKey.slice(-4),
      baseUrl,
      model,
      priority: input.priority ?? 100,
      dailyLimitMicros: input.dailyLimitMicros ?? null
    },
    select: PUBLIC_KEY_FIELDS
  });
}

export async function listKeys(userId: string) {
  return prisma.aiKey.findMany({
    where: { userId },
    select: PUBLIC_KEY_FIELDS,
    orderBy: [{ provider: "asc" }, { priority: "asc" }, { createdAt: "asc" }]
  });
}

export type KeyPatch = {
  nickname?: string;
  enabled?: boolean;
  priority?: number;
  model?: string;
  baseUrl?: string | null;
  dailyLimitMicros?: bigint | null;
};

export async function updateKey(userId: string, keyId: string, patch: KeyPatch) {
  const owned = await prisma.aiKey.findFirst({ where: { id: keyId, userId }, select: { id: true } });
  if (!owned) throw new VaultError("Key not found.", 404);

  // Re-enabling is how a user retries a key the router disabled, so the health
  // counters reset with it — otherwise it would be disabled again immediately.
  const reviving = patch.enabled === true;

  return prisma.aiKey.update({
    where: { id: keyId },
    data: {
      ...patch,
      ...(reviving ? { health: "unknown", failureCount: 0, lastError: null, disabledAt: null } : {})
    },
    select: PUBLIC_KEY_FIELDS
  });
}

export async function deleteKey(userId: string, keyId: string) {
  const owned = await prisma.aiKey.findFirst({ where: { id: keyId, userId }, select: { id: true } });
  if (!owned) throw new VaultError("Key not found.", 404);
  await prisma.aiKey.delete({ where: { id: keyId } });
}

/**
 * Decrypt one key for an immediate provider call.
 *
 * The only function in the codebase that returns plaintext. Callers must not log
 * it, return it, or put it in a job payload.
 */
export async function revealKey(userId: string, keyId: string): Promise<string | null> {
  const row = await prisma.aiKey.findFirst({
    where: { id: keyId, userId },
    select: { encryptedKey: true }
  });
  if (!row) return null;
  return decryptSecret(row.encryptedKey);
}
