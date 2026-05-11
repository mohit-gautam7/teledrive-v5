import { StorageMode } from "@prisma/client";

const TWO_GB = 2 * 1024 * 1024 * 1024;

export function decideStorage(mimeType: string, size: number) {
  // Use BOT for everything up to 2GB — MTProto only if session is configured and file exceeds bot limit
  const hasSession = !!process.env.TELEGRAM_SESSION;
  if (hasSession && size > TWO_GB) {
    return { storageMode: StorageMode.PERSONAL, reason: "Files over 2GB use personal Telegram storage." };
  }
  return { storageMode: StorageMode.BOT, reason: "Using bot channel storage." };
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
  telegramMessageId: string | null;
  folderId: string | null;
  isFavorite: boolean;
  createdAt: Date;
}) {
  return {
    ...file,
    size: Number(file.size),
    createdAt: file.createdAt.toISOString()
  };
}
