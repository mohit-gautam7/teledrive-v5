/**
 * Chunking constants — shared by client and server.
 *
 * 4 MiB keeps every request under Vercel's 4.5 MB serverless body limit and
 * every stored chunk under Telegram's 20 MB bot-download limit, while staying
 * far below the 50 MB bot-upload limit.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB — Telegram's per-file cap
