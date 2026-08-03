import { StorageMode } from "@prisma/client";
import { BOT_DOWNLOAD_LIMIT } from "@/lib/upload-config";

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
