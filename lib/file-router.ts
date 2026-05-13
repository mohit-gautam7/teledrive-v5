import { StorageMode } from "@prisma/client";

const FIFTY_MB = 50 * 1024 * 1024;

export function decideStorage(mimeType: string, size: number, hasPersonalSession: boolean) {
  if (hasPersonalSession && size > FIFTY_MB) {
    return { storageMode: StorageMode.PERSONAL, reason: "Files over 50 MB use personal Telegram storage." };
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
