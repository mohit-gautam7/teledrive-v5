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
  /** Stored in a way Telegram will not serve back (single bot document > 20 MB).
   *  Re-uploading is the only fix, so the tile says so instead of failing mutely. */
  unreachable?: boolean;
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
  /** Bytes confirmed stored. Percent, speed and ETA are derived from this. */
  loaded: number;
  percent: number;
  /** Bytes per second over a recent window; null until there's enough signal. */
  speed: number | null;
  /** Seconds remaining at the current speed, or null when unknown. */
  eta: number | null;
  /** `paused` is a session restored after a reload: the server still holds the
   *  chunks, but this tab has no bytes to send until the file is handed back. */
  status: "pending" | "uploading" | "done" | "error" | "paused";
  error?: string;
  /** Null only for a restored session whose file this tab cannot read yet. */
  file: File | null;
  /** Destination folder, kept so a restored session resumes into the right place. */
  folderId?: string | null;
  /** Server-side session fingerprint; the resume key is what makes this durable. */
  resumeKey?: string;
  /** Relative path when the item came from a folder drop / directory picker. */
  path?: string;
};

/** One in-flight download, mirrored from the uploads so both read alike. */
export type DownloadItem = {
  id: string;
  fileId: string;
  name: string;
  /** Total bytes, or 0 while the server has not said (no Content-Length yet). */
  size: number;
  loaded: number;
  percent: number;
  speed: number | null;
  eta: number | null;
  status: "downloading" | "done" | "error" | "cancelled";
  error?: string;
};

export type TransferItem =
  | ({ kind: "upload" } & UploadItem)
  | ({ kind: "download" } & DownloadItem);

export function formatSpeed(bytesPerSecond: number | null) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "—";
  const mb = bytesPerSecond / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
}

export function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type TelegramLink = {
  available: boolean;
  linked: boolean;
  telegramUserId: string | null;
  premium: boolean;
  maxBytes: number;

  /** Names of env vars this host is missing, so the card can say which. */
  missingEnv?: string[];};

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
  /** Folders the user owns, at every depth. Only in the ?full=1 response. */
  folderCount?: number;
  byBackend: Array<{ backend: string; bytes: number; files: number }>;
  byType: Array<{ bucket: string; bytes: number; files: number }>;
  largest: Array<{ id: string; originalName: string; mimeType: string; size: number }>;
};

export const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME || "";

/** Aggregated AI spend. `costMicros` is micro-USD; see AiUsage.pricedCalls. */
export type AiUsage = {
  days: number;
  calls: number;
  errors: number;
  /** How many of `calls` had a configured price. The rest contribute nothing to
   *  costMicros, so a total without this number is misleading. */
  pricedCalls: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  avgLatencyMs: number;
  byProvider: Array<{ provider: string; calls: number; promptTokens: number; completionTokens: number; costMicros: number }>;
  byTask: Array<{ task: string; calls: number; costMicros: number }>;
  byDay: Array<{ day: string; calls: number; promptTokens: number; completionTokens: number; costMicros: number }>;
};

/** A provider the vault can hold keys for. Mirrors publicProviders() — no secrets. */
export type AiProvider = {
  id: string;
  label: string;
  defaultBaseUrl: string | null;
  keysUrl: string | null;
  local: boolean;
  /** True when a key for this provider must carry its own endpoint. */
  requiresBaseUrl: boolean;
};

/**
 * A stored key as the browser is allowed to see it: `hint` is the last four
 * characters, and the secret itself is never sent back.
 */
export type AiKeyRow = {
  id: string;
  provider: string;
  nickname: string;
  hint: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  priority: number;
  dailyLimitMicros: number | null;
  health: string;
  failureCount: number;
  lastError: string | null;
  lastUsedAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

/** Where this file actually lives in Telegram, for the "open in Telegram" action. */
export function telegramDeepLink(file: DriveFile, mtprotoUserId: string | null): string | null {
  if (file.backend === "mtproto" && file.telegramMessageId && mtprotoUserId) {
    return `tg://openmessage?user_id=${mtprotoUserId}&message_id=${file.telegramMessageId}`;
  }
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;
}
