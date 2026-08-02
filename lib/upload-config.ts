/**
 * Chunking constants — shared by client and server.
 *
 * 4 MiB keeps every request under Vercel's 4.5 MB serverless body limit and
 * every stored chunk under Telegram's 20 MB bot-download limit, while staying
 * far below the 50 MB bot-upload limit.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB

/** Telegram's per-file ceiling on a normal user account. */
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
/** Telegram Premium raises the per-file ceiling to 4 GB. */
export const MAX_FILE_SIZE_PREMIUM = 4 * 1024 * 1024 * 1024; // 4 GB

/**
 * How many chunks of one file are in flight at once.
 *
 * Every chunk is a serverless invocation that then does a Telegram sendDocument,
 * so this is the main dial on how hard one browser leans on the bot's ~30 msg/s
 * budget. Three is enough to hide per-request latency without a single user
 * monopolising the bot when several people upload at the same time.
 */
export const CHUNK_CONCURRENCY = 3;

/** MTProto splits big files into 512 KiB parts; 4 MiB of payload = 8 parts. */
export const MTPROTO_PART_SIZE = 512 * 1024;

/** Files at or above this size prefer the user's own MTProto session when one
 *  is authorised — one Telegram message instead of hundreds of bot chunks. */
export const MTPROTO_PREFERRED_ABOVE = 64 * 1024 * 1024; // 64 MB

export type UploadBackend = "bot" | "mtproto";

/**
 * An upload session becomes a `File` row before any bytes reach Telegram, so a
 * failed or abandoned upload leaves a row whose `size` is the *intended* size
 * and whose chunks may not exist. Listing those made a phantom file appear in
 * the drive — full size, broken thumbnail, nothing behind it — and counted
 * toward the storage total.
 *
 * Every query that answers "what does the user actually have stored?" filters
 * on this. Written as `not: "uploading"` rather than `equals: "complete"` so
 * rows predating the column (default `"complete"`) are unaffected.
 */
export const STORED_ONLY = { uploadStatus: { not: "uploading" } } as const;

/** Abandoned upload sessions are garbage-collected after this long. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
