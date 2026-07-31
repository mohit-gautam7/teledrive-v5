import { deleteMessagesBot } from "@/lib/telegram-bot";
import { deleteChunkMessages } from "@/lib/telegram";
import { deleteUserMessages } from "@/lib/telegram-user";
import { decryptSecret } from "@/lib/crypto";

type DeletableFile = {
  backend: string;
  isChunked: boolean;
  storageMode: string;
  storageChatId: string | null;
  telegramMessageId: string | null;
  chunks: Array<{ telegramFileId: string | null; telegramMsgId: number }>;
  user: { storageConfig: { telegramSession: string | null; mtprotoSession: string | null; botToken: string | null } | null };
};

/**
 * Best-effort removal of the Telegram-side copies of a permanently deleted file.
 * Never throws: Telegram refuses to delete messages older than 48h, and the
 * database row is the app's source of truth either way.
 */
export async function purgeTelegramCopies(file: DeletableFile) {
  try {
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
