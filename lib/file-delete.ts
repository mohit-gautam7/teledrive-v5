import { deleteMessagesBot } from "@/lib/telegram-bot";
import { deleteChunkMessages } from "@/lib/telegram";
import { deleteUserMessages } from "@/lib/telegram-user";
import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

type DeletableFile = {
  id: string;
  userId: string;
  backend: string;
  isChunked: boolean;
  storageMode: string;
  storageChatId: string | null;
  telegramFileId: string | null;
  telegramMessageId: string | null;
  chunks: Array<{ telegramFileId: string | null; telegramMsgId: number }>;
  user: { storageConfig: { telegramSession: string | null; mtprotoSession: string | null; botToken: string | null } | null };
};

/**
 * Is some *other* row still pointing at the same Telegram bytes?
 *
 * "Make a copy" duplicates rows by reference rather than re-uploading, so two
 * files can share one Telegram message and its chunks. Deleting the messages
 * because one row went away would silently break every sibling copy, so the
 * Telegram-side purge is skipped while any other row still needs them.
 */
async function hasSurvivingTwin(file: DeletableFile): Promise<boolean> {
  const identity = file.telegramMessageId
    ? { telegramMessageId: file.telegramMessageId }
    : file.telegramFileId
      ? { telegramFileId: file.telegramFileId }
      : null;

  if (identity) {
    const twin = await prisma.file.findFirst({
      where: { userId: file.userId, id: { not: file.id }, ...identity },
      select: { id: true }
    });
    if (twin) return true;
  }

  // Chunked files share their per-chunk Telegram message ids instead.
  const msgIds = file.chunks.map(c => c.telegramMsgId).filter(id => id > 0);
  if (!msgIds.length) return false;
  const sharedChunk = await prisma.chunk.findFirst({
    where: { telegramMsgId: { in: msgIds }, fileId: { not: file.id }, file: { userId: file.userId } },
    select: { id: true }
  });
  return Boolean(sharedChunk);
}

/**
 * Best-effort removal of the Telegram-side copies of a permanently deleted file.
 * Never throws: Telegram refuses to delete messages older than 48h, and the
 * database row is the app's source of truth either way.
 */
export async function purgeTelegramCopies(file: DeletableFile) {
  try {
    if (await hasSurvivingTwin(file)) return;
    if (file.backend === "mtproto" && file.telegramMessageId) {
      const session = decryptSecret(file.user.storageConfig?.mtprotoSession);
      if (session) await deleteUserMessages(session, [Number(file.telegramMessageId)]);
      return;
    }

    const botMsgIds = file.chunks.filter(c => c.telegramFileId && c.telegramMsgId > 0).map(c => c.telegramMsgId);
    const legacyMsgIds = file.chunks.filter(c => !c.telegramFileId).map(c => c.telegramMsgId);

    if (botMsgIds.length && file.storageChatId) {
      await deleteMessagesBot(file.storageChatId, botMsgIds);
    }
    if (legacyMsgIds.length) {
      await deleteChunkMessages(legacyMsgIds, decryptSecret(file.user.storageConfig?.telegramSession));
    }
  } catch (err) {
    console.warn("[file-delete] Telegram cleanup failed (continuing):", (err as Error).message);
  }
}
