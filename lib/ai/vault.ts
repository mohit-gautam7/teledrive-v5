import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { getProvider } from "@/lib/ai/providers";
import { resolveBaseUrl } from "@/lib/ai/client";

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
  // Refused here as well as at call time, so the answer arrives while the user
  // is looking at the field rather than as a failed job an hour later.
  if (baseUrl) {
    try {
      resolveBaseUrl(spec, baseUrl);
    } catch (err) {
      throw new VaultError((err as Error).message);
    }
  }

  // The provider's default stands in when no model is named. Requiring one made
  // adding a key a research task — the exact model string had to be known before
  // anything could be saved — and the router refuses to use a key without one,
  // so "no model" was a key that silently never ran.
  const model = input.model?.trim() || spec.defaultModel;

  const chosen = input.nickname.trim();
  const taken = new Set(
    (
      await prisma.aiKey.findMany({
        where: { userId, provider: input.provider },
        select: { nickname: true }
      })
    ).map(k => k.nickname)
  );

  // A name the user typed is theirs — a clash is worth reporting. An
  // auto-generated one is not: adding a second fallback key for the same
  // provider is the normal case, and failing it over a name nobody chose would
  // be pointless.
  if (chosen && taken.has(chosen)) {
    throw new VaultError(`You already have a ${spec.label} key called "${chosen}".`, 409);
  }
  let nickname = chosen || spec.label;
  for (let n = 2; taken.has(nickname); n++) nickname = `${spec.label} ${n}`;

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
  const owned = await prisma.aiKey.findFirst({
    where: { id: keyId, userId },
    select: { id: true, provider: true }
  });
  if (!owned) throw new VaultError("Key not found.", 404);

  // The endpoint can be edited as well as set, so it is checked on the way in
  // here too — a guard only on create is a guard with a PATCH-shaped hole.
  if (patch.baseUrl) {
    const spec = getProvider(owned.provider);
    if (!spec) throw new VaultError(`Unknown provider "${owned.provider}".`);
    if (!/^https?:\/\//i.test(patch.baseUrl)) {
      throw new VaultError("The base URL must start with http:// or https://");
    }
    try {
      resolveBaseUrl(spec, patch.baseUrl);
    } catch (err) {
      throw new VaultError((err as Error).message);
    }
  }

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
