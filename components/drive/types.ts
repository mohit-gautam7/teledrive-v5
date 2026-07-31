export type DriveFile = {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageMode: "BOT" | "PERSONAL";
  backend: string;
  telegramMessageId: string | null;
  storageChatId: string | null;
  folderId: string | null;
  isFavorite: boolean;
  createdAt: string;
};

export type DriveFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  size?: number;
  fileCount?: number;
};

export type AppView = "files" | "shared" | "insights" | "favorites" | "trash" | "settings" | "about";
export type ThemeMode = "light" | "dark" | "system";
export type SortField = "date" | "name" | "size";
export type SortDir = "asc" | "desc";
export type TypeFilter = "all" | "image" | "video" | "doc";
export type PropsTarget = { kind: "file"; file: DriveFile } | { kind: "folder"; folder: DriveFolder };

export type UploadItem = {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  file: File;
  /** Relative path when the item came from a folder drop / directory picker. */
  path?: string;
};

export type TelegramLink = {
  available: boolean;
  linked: boolean;
  telegramUserId: string | null;
  premium: boolean;
  maxBytes: number;
};

export type ShareRow = {
  id: string;
  token: string;
  url: string;
  kind: "file" | "folder";
  name: string;
  mimeType: string | null;
  size: number | null;
  orphaned: boolean;
  disabled: boolean;
  hasPassword: boolean;
  expiryDate: string | null;
  expired: boolean;
  createdAt: string;
};

export type Insights = {
  totalSize: number;
  count: number;
  trashSize: number;
  trashCount: number;
  byBackend: Array<{ backend: string; bytes: number; files: number }>;
  byType: Array<{ bucket: string; bytes: number; files: number }>;
  largest: Array<{ id: string; originalName: string; mimeType: string; size: number }>;
};

export const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "";

/** Where this file actually lives in Telegram, for the "open in Telegram" action. */
export function telegramDeepLink(file: DriveFile, mtprotoUserId: string | null): string | null {
  if (file.backend === "mtproto" && file.telegramMessageId && mtprotoUserId) {
    return `tg://openmessage?user_id=${mtprotoUserId}&message_id=${file.telegramMessageId}`;
  }
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;
}
