import { StorageMode } from "@prisma/client";

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
