import { MAX_FILE_SIZE, MAX_FILE_SIZE_PREMIUM } from "@/lib/upload-config";

type LimitConfig = { mtprotoSession: string | null; mtprotoPremium: boolean } | null;

/**
 * The largest single file this user can store.
 *
 * Bot-chunked storage and a plain MTProto session both stop at Telegram's 2 GB
 * per-file cap; only a Premium account raises it to 4 GB. There is no route past
 * that — the ceiling is Telegram's, not ours.
 */
export function maxUploadBytesFor(config: LimitConfig): number {
  if (config?.mtprotoSession && config.mtprotoPremium) return MAX_FILE_SIZE_PREMIUM;
  return MAX_FILE_SIZE;
}

export function describeLimit(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
}
