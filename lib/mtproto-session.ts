import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isKnownDeadSession } from "@/lib/telegram-user";

/** Decrypted MTProto session for a user, or null when they haven't linked one. */
export async function userMtprotoSession(userId: string): Promise<string | null> {
  const config = await prisma.storageConfig.findUnique({
    where: { userId },
    select: { mtprotoSession: true }
  });
  return (await dropIfDead(config?.mtprotoSession)) ? null : decryptSecret(config?.mtprotoSession) || null;
}

/**
 * Clear a stored (encrypted) session once Telegram has revoked it in this
 * process; it can never work again. Only that exact value is cleared, so a link
 * made since is left alone, and mtprotoUserId stays to show which account to
 * link again. Returns true when it was dead.
 */
export async function dropIfDead(encrypted: string | null | undefined): Promise<boolean> {
  const session = decryptSecret(encrypted);
  if (!encrypted || !session || !isKnownDeadSession(session)) return false;
  await prisma.storageConfig.updateMany({
    where: { mtprotoSession: encrypted },
    data: { mtprotoSession: null, mtprotoPremium: false }
  });
  return true;
}

export async function saveMtprotoSession(userId: string, session: string, telegramUserId: string, premium: boolean) {
  const data = {
    mtprotoSession: encryptSecret(session),
    mtprotoUserId: telegramUserId,
    mtprotoPremium: premium,
    pendingSession: null,
    pendingHash: null,
    pendingPhone: null
  };
  await prisma.storageConfig.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data }
  });
}

export async function savePendingLogin(userId: string, pendingSession: string, hash?: string, phone?: string) {
  const data = {
    pendingSession: encryptSecret(pendingSession),
    pendingHash: hash ?? null,
    pendingPhone: phone ?? null
  };
  await prisma.storageConfig.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data }
  });
}

export async function readPendingLogin(userId: string) {
  const config = await prisma.storageConfig.findUnique({
    where: { userId },
    select: { pendingSession: true, pendingHash: true, pendingPhone: true }
  });
  if (!config?.pendingSession) return null;
  return {
    session: decryptSecret(config.pendingSession) as string,
    hash: config.pendingHash,
    phone: config.pendingPhone
  };
}

/** Discard only a half-finished login, leaving any established link intact. */
export async function clearPendingLogin(userId: string) {
  await prisma.storageConfig.updateMany({
    where: { userId },
    data: { pendingSession: null, pendingHash: null, pendingPhone: null }
  });
}

export async function clearMtproto(userId: string) {
  await prisma.storageConfig.updateMany({
    where: { userId },
    data: {
      mtprotoSession: null,
      mtprotoUserId: null,
      mtprotoPremium: false,
      pendingSession: null,
      pendingHash: null,
      pendingPhone: null
    }
  });
}
