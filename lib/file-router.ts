import { StorageMode } from "@prisma/client";
import { BOT_DOWNLOAD_LIMIT, SAVED_MESSAGES } from "@/lib/upload-config";

/**
 * Which chat the *bot* should put an auxiliary message in for this file.
 *
 * Thumbnails are always bot-stored, even for a file whose bytes live in the
 * user's own Saved Messages — a bot cannot write to "me", so that value is not a
 * chat id it can use and the user's own bot chat is the right destination.
 */
export function botChatFor(file: { storageChatId: string | null }, fallback: string) {
  return file.storageChatId && file.storageChatId !== SAVED_MESSAGES ? file.storageChatId : fallback;
}

export function safeName(name: string) {
  return name.replace(/[^\w.\- ()]/g, "_").slice(0, 180) || "file";
}

export function toPublicFile(file: {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: bigint;
  storageMode: StorageMode;
  backend: string;
  isChunked: boolean;
  telegramMessageId: string | null;
  storageChatId: string | null;
  folderId: string | null;
  isFavorite: boolean;
  createdAt: Date;
}) {
  const size = Number(file.size);
  return {
    ...file,
    size,
    // Marked in the listing so a tile can label the file rather than silently
    // failing to load a thumbnail: an early version stored anything under 50 MB
    // as one bot document, and Telegram will not serve a bot more than 20 MB of
    // one. See unreachableReason() — this is the same rule without a chunk join.
    unreachable: !file.isChunked && file.backend !== "mtproto" && file.storageMode === StorageMode.BOT && size > BOT_DOWNLOAD_LIMIT,
    createdAt: file.createdAt.toISOString()
  };
}
