import { MAX_FILE_SIZE, MAX_SPLIT_FILE_SIZE } from "@/lib/upload-config";

type LimitConfig = { mtprotoSession: string | null; mtprotoPremium: boolean } | null;

/**
 * The largest single file this user can store.
 *
 * A linked account uploads straight from the browser, and anything past one
 * Telegram message (2,000 MiB) is stored as several messages, so the 2/4 GB
 * per-file cap stops mattering. Without a linked account nothing new can be
 * stored at all; MAX_FILE_SIZE is only what the UI shows in that case.
 */
export function maxUploadBytesFor(config: LimitConfig): number {
  return config?.mtprotoSession ? MAX_SPLIT_FILE_SIZE : MAX_FILE_SIZE;
}

export function describeLimit(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
}
