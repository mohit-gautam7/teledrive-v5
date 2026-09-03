/**
 * Chunking constants — shared by client and server.
 *
 * 4 MiB keeps every request under Vercel's 4.5 MB serverless body limit and
 * every stored chunk under Telegram's 20 MB bot-download limit, while staying
 * far below the 50 MB bot-upload limit.
 */
/** MTProto uploads in 512 KiB parts, so a chunk must be a whole number of them. */
const PART = 512 * 1024;
const DEFAULT_CHUNK_MB = 4;
/** Cloudflare's free plan caps a request body at 100 MB; staying well under it
 *  leaves room for multipart overhead and keeps a failed chunk cheap to retry. */
const MAX_CHUNK_MB = 50;

function resolveChunkSize() {
  const raw = Number(process.env.UPLOAD_CHUNK_MB);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHUNK_MB * 1024 * 1024;
  const mb = Math.min(Math.max(raw, 1), MAX_CHUNK_MB);
  // Round down to a whole number of MTProto parts; a ragged chunk would make
  // PARTS_PER_CHUNK fractional and misalign every big-file upload.
  return Math.max(PART, Math.floor((mb * 1024 * 1024) / PART) * PART);
}

/**
 * Bytes per upload chunk.
 *
 * 4 MiB is the default because it is the only value that fits Vercel's 4.5 MB
 * request-body cap. On an always-on host (Render, a VM) there is no such cap, and
 * raising this to 16–32 MB cuts the number of round-trips — and therefore the
 * number of Telegram messages — by the same factor.
 *
 * Read from the environment at module load, which is safe because the value
 * reaches the browser through /api/upload/init rather than a build-time constant:
 * the client chunks at whatever size the server reports, so changing this cannot
 * strand an in-flight resumable upload.
 */
export const CHUNK_SIZE = resolveChunkSize();

/**
 * Telegram refuses `getFile` above this, whatever the bot managed to *send*.
 *
 * The asymmetry is the trap: a bot may upload a 50 MB document but may only
 * download 20 MB of one. An early version stored anything under 50 MB as a
 * single document, so files between these two numbers went up fine and can
 * never come back down. Chunking exists precisely to stay under it.
 */
export const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

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
export const CHUNK_CONCURRENCY = (() => {
  const raw = Number(process.env.UPLOAD_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 12) : 3;
})();

/** MTProto splits big files into 512 KiB parts; 4 MiB of payload = 8 parts. */
export const MTPROTO_PART_SIZE = 512 * 1024;

/**
 * Above this, a linked account stores the file in its own Telegram session.
 *
 * The number is Telegram's, not a preference: BOT_DOWNLOAD_LIMIT is the largest
 * document a bot can serve back, so it is exactly the largest file bot storage
 * can hold in one message. Anything bigger has to be either bot-chunked into
 * hundreds of parts or — when the user has linked their account — sent through
 * MTProto as a single message in their own Saved Messages.
 *
 * It used to sit at 64 MB, which meant a linked user's 30 MB file was still
 * chunked across eight bot messages for no reason at all.
 */
export const MTPROTO_PREFERRED_ABOVE = BOT_DOWNLOAD_LIMIT;

/**
 * `chatId` recorded for a file stored in the user's own Saved Messages.
 *
 * MTProto's own name for "this account's chat with itself", so it is what the
 * download, delete and finalise paths already pass to Telegram. Storing it makes
 * the row say where the bytes are instead of leaving it null and implied.
 */
export const SAVED_MESSAGES = "me";

/**
 * The largest file the single-request /api/upload path may take.
 *
 * Two ceilings, and the lower one wins. A chunk is the obvious one. The other is
 * that this path stores its file as *one* bot document, so raising
 * UPLOAD_CHUNK_MB above 20 would quietly start minting files Telegram will never
 * serve back to a bot — the exact class of unreachable file chunking exists to
 * prevent. Client and server both route on this, so they cannot disagree.
 */
export const SINGLE_SHOT_LIMIT = Math.min(CHUNK_SIZE, BOT_DOWNLOAD_LIMIT);

export type UploadBackend = "bot" | "mtproto";

/**
 * Where a new upload is stored. The whole of P1 lives in this one line, so it
 * lives in one place rather than inline in the route that happened to need it.
 */
export function backendFor(fileSize: number, hasMtprotoSession: boolean): UploadBackend {
  return hasMtprotoSession && fileSize > MTPROTO_PREFERRED_ABOVE ? "mtproto" : "bot";
}

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
