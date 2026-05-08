import { StorageMode } from "@prisma/client";

const FIFTY_MB = 50 * 1024 * 1024;

export function decideStorage(mimeType: string, size: number) {
  if (mimeType.startsWith("video/")) {
    return { storageMode: StorageMode.PERSONAL, reason: "Videos always use personal Telegram storage." };
  }
  if (mimeType.startsWith("image/") && size <= FIFTY_MB) {
    return { storageMode: StorageMode.BOT, reason: "Images up to 50MB use bot channel storage." };
  }
  if (mimeType.startsWith("image/")) {
    return { storageMode: StorageMode.PERSONAL, reason: "Large images use personal Telegram storage." };
  }
  if (size <= FIFTY_MB) {
    return { storageMode: StorageMode.BOT, reason: "Files up to 50MB use bot channel storage." };
  }
  return { storageMode: StorageMode.PERSONAL, reason: "Large files use personal Telegram storage." };
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
