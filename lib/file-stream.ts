import { NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { fetchBotFile } from "@/lib/telegram-bot";
import { downloadChunkFromTelegram, legacySessionAvailable } from "@/lib/telegram";
import { downloadRange } from "@/lib/telegram-user";
import { decryptSecret } from "@/lib/crypto";
import { BOT_DOWNLOAD_LIMIT } from "@/lib/upload-config";

/**
 * One streaming path for every download/preview/share route.
 * - New files: chunks stored via Bot API in the user's own bot chat (telegramFileId per chunk).
 * - Legacy chunked files: MTProto messages in the owner's Saved Messages.
 * - Legacy single files: Bot API documents in the old channel.
 * Bytes are always proxied — Telegram URLs embed the bot token and must never
 * reach the browser.
 */

export type StreamableFile = {
  id: string;
  originalName: string;
  mimeType: string;
  size: bigint | number;
  storageMode: StorageMode;
  backend: string;
  isChunked: boolean;
  uploadStatus: string;
  telegramFileId: string | null;
  telegramMessageId: string | null;
  chunks: Array<{ chunkIndex: number; telegramMsgId: number; telegramFileId: string | null; chunkSize: number }>;
  user?: {
    storageConfig?: { botToken: string | null; telegramSession: string | null; mtprotoSession: string | null } | null;
  } | null;
};

/** How much of an MTProto file we pull per read. Big enough to amortise the
 *  round trip, small enough that a 2 GB file never sits in function memory. */
const MTPROTO_WINDOW = 4 * 1024 * 1024;

/**
 * Which stored types may be handed to the browser to *render*, rather than save.
 *
 * The stored mime type is whatever the uploader's browser reported, so echoing
 * it back on an inline response let a user pick it. Upload an .html file, share
 * it, and the victim opening the share ran the uploader's script on this app's
 * own origin — with their session cookie. That is stored XSS, reachable by
 * anyone with a share link.
 *
 * So inline rendering is allowlisted rather than filtered: anything not named
 * here is served as an opaque download. SVG is deliberately absent — it is a
 * document format that can carry script, not a picture.
 */
const INLINE_SAFE = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "video/",
  "audio/",
  "application/pdf",
  "text/plain"
];

function inlineSafe(mimeType: string) {
  const type = (mimeType || "").toLowerCase().split(";")[0].trim();
  return INLINE_SAFE.some(allowed => (allowed.endsWith("/") ? type.startsWith(allowed) : type === allowed));
}

/**
 * Headers every file response carries, whichever route served it.
 *
 * `nosniff` stops a browser from deciding an octet-stream is really HTML, and
 * the CSP is the belt to that brace: even if something slipped through the
 * allowlist above, a document rendered under `default-src 'none'; sandbox` has
 * no script, no origin and no access to anything.
 */
function protectiveHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'"
  };
}


/**
 * How much is served for a range that names no end.
 *
 * A player opening a video sends `Range: bytes=0-`, which literally asks for the
 * rest of the file — for a 975 MB video that is one response the browser must
 * hold open for the entire film, and any hiccup restarts it. Answering with a
 * bounded slice is explicitly allowed (a server may return less than was asked
 * for) and is what makes seeking responsive: each request is short, finishes
 * cleanly, and the player simply asks for the next piece.
 */
const OPEN_RANGE_WINDOW = 16 * 1024 * 1024;

export function parseRange(
  rangeHeader: string | null,
  totalSize: number
): { start: number; end: number; partial: boolean } {
  if (!rangeHeader) return { start: 0, end: totalSize - 1, partial: false };
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!m || (!m[1] && !m[2])) return { start: 0, end: totalSize - 1, partial: false };
  const start = m[1] ? Math.max(0, parseInt(m[1], 10)) : Math.max(0, totalSize - parseInt(m[2], 10));
  const end = m[1] && m[2]
    ? Math.min(parseInt(m[2], 10), totalSize - 1)
    : // Open-ended: cap the slice rather than committing to the whole tail.
      Math.min(start + OPEN_RANGE_WINDOW - 1, totalSize - 1);
  return { start, end, partial: true };
}

type OffsetChunk = { start: number; end: number; msgId: number; fileId: string | null; size: number };

export function mapChunkOffsets(
  chunks: StreamableFile["chunks"]
): OffsetChunk[] {
  const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const out: OffsetChunk[] = [];
  let offset = 0;
  for (const c of sorted) {
    out.push({ start: offset, end: offset + c.chunkSize - 1, msgId: c.telegramMsgId, fileId: c.telegramFileId, size: c.chunkSize });
    offset += c.chunkSize;
  }
  return out;
}

/** Pull-based stream over stored chunks — downloads at the pace the client
 *  consumes, so a 2 GB file never sits in serverless memory. */
function buildChunkStream(
  chunkMap: OffsetChunk[],
  rangeStart: number,
  rangeEnd: number,
  fetchChunk: (chunk: OffsetChunk) => Promise<Buffer>
): ReadableStream<Uint8Array> {
  const relevant = chunkMap.filter(c => c.end >= rangeStart && c.start <= rangeEnd);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= relevant.length) {
        controller.close();
        return;
      }
      const chunk = relevant[index++];
      try {
        const buf = await fetchChunk(chunk);
        const sliceFrom = Math.max(0, rangeStart - chunk.start);
        const sliceTo = Math.min(buf.length, rangeEnd - chunk.start + 1);
        controller.enqueue(new Uint8Array(buf.subarray(sliceFrom, sliceTo)));
      } catch (err) {
        controller.error(err);
      }
    }
  });
}

/** Pull-based stream over an arbitrary byte range, one window at a time. */
function buildRangeStream(
  rangeStart: number,
  rangeEnd: number,
  read: (start: number, end: number) => Promise<Buffer>
): ReadableStream<Uint8Array> {
  let cursor = rangeStart;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor > rangeEnd) {
        controller.close();
        return;
      }
      const end = Math.min(cursor + MTPROTO_WINDOW - 1, rangeEnd);
      try {
        const buf = await read(cursor, end);
        // Advance by what actually arrived, not by what was asked for. A short
        // read — Telegram returning a partial window near a part boundary — used
        // to skip the missing bytes *and* leave the body shorter than the
        // Content-Length already promised in the headers. The browser sees a
        // truncated 206, throws the whole response away and restarts from zero,
        // which is the reload loop.
        if (!buf.length) {
          throw new Error(`Upstream returned no data at byte ${cursor}.`);
        }
        cursor += buf.length;
        controller.enqueue(new Uint8Array(buf));
      } catch (err) {
        controller.error(err);
      }
    }
  });
}

/** The user's own bot token, decrypted. Stored ciphertext since the token
 *  stopped being kept in the clear; decryptSecret passes older plaintext
 *  through untouched, so existing rows keep working. */
export function userBotToken(file: StreamableFile) {
  return decryptSecret(file.user?.storageConfig?.botToken) || null;
}

async function fetchBotChunkBuffer(fileId: string, botToken?: string | null): Promise<Buffer> {
  const res = await fetchBotFile(fileId, botToken);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Read a whole bot-stored file into memory (for thumbnail generation only).
 * Returns null for storage kinds we don't want to buffer (legacy MTProto,
 * or anything over ~25 MB) — the caller falls back to normal streaming.
 */
export async function readEntireFile(file: StreamableFile): Promise<Buffer | null> {
  const totalSize = Number(file.size);
  if (totalSize > 25 * 1024 * 1024) return null;
  const botToken = userBotToken(file);

  if (file.backend === "mtproto" && file.telegramMessageId) {
    const session = decryptSecret(file.user?.storageConfig?.mtprotoSession);
    if (!session) return null;
    return downloadRange(session, Number(file.telegramMessageId), 0, totalSize - 1);
  }

  if (file.isChunked) {
    if (file.uploadStatus !== "complete" || !file.chunks.length) return null;
    if (!file.chunks.every(c => !!c.telegramFileId)) return null; // legacy MTProto chunks
    const ordered = [...file.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const parts: Buffer[] = [];
    for (const c of ordered) parts.push(await fetchBotChunkBuffer(c.telegramFileId as string, botToken));
    return Buffer.concat(parts);
  }

  if (file.storageMode === StorageMode.BOT && file.telegramFileId) {
    return fetchBotChunkBuffer(file.telegramFileId, botToken);
  }
  return null;
}

/**
 * Why this file's bytes cannot be fetched at all, or null when they can.
 *
 * Checked *before* a streaming response is committed to. A stream that fails on
 * its first pull has already sent `200`/`206` and a Content-Length, so the only
 * thing left to do is destroy the connection mid-body — which Next reports as
 * "failed to pipe response", a proxy turns into a 5xx, and the browser shows as
 * a dead request with no explanation. Answering up front turns an unservable
 * file into one honest, cheap, explainable response instead.
 */
export function unreachableReason(file: StreamableFile): string | null {
  const totalSize = Number(file.size);

  if (file.isChunked) {
    // Every chunk is fetched by file_id, so any single chunk over the ceiling is
    // unreachable even though the file as a whole is chunked.
    const oversized = file.chunks.find(c => c.telegramFileId && c.chunkSize > BOT_DOWNLOAD_LIMIT);
    if (oversized) {
      return `This file was stored in ${Math.round(oversized.chunkSize / (1024 * 1024))} MB pieces, and Telegram will not let a bot download a piece larger than 20 MB. Re-upload it to store it in smaller pieces.`;
    }
    return null;
  }

  if (file.backend !== "mtproto" && file.storageMode === StorageMode.BOT && totalSize > BOT_DOWNLOAD_LIMIT) {
    return `Telegram will not let a bot download a file larger than 20 MB, and this one was stored as a single ${(totalSize / (1024 * 1024)).toFixed(1)} MB document by an earlier version of TeleDrive. Re-upload it — uploads are now split into pieces that download fine.`;
  }

  return null;
}

export { protectiveHeaders };

export function streamFileResponse(
  file: StreamableFile,
  rangeHeader: string | null,
  disposition: "inline" | "attachment"
): NextResponse {
  const totalSize = Number(file.size);

  // 409, not 500: nothing is broken server-side, the bytes are simply out of
  // the bot's reach. `Cache-Control: no-store` because re-uploading fixes it.
  const unreachable = unreachableReason(file);
  if (unreachable) {
    return NextResponse.json(
      { error: unreachable },
      { status: 409, headers: { ...protectiveHeaders(), "Cache-Control": "no-store" } }
    );
  }

  const userSession = decryptSecret(file.user?.storageConfig?.telegramSession);
  const mtprotoSession = decryptSecret(file.user?.storageConfig?.mtprotoSession);
  const botToken = userBotToken(file);

  // An inline request for a type we will not render becomes a download. The
  // type is dropped too: naming it invites a sniffing browser to try anyway.
  const renderable = disposition === "inline" && inlineSafe(file.mimeType);
  const effectiveDisposition = disposition === "attachment" || renderable ? disposition : "attachment";

  const baseHeaders: Record<string, string> = {
    ...protectiveHeaders(),
    "Content-Type": renderable || disposition === "attachment" ? file.mimeType || "application/octet-stream" : "application/octet-stream",
    "Accept-Ranges": "bytes",
    // `no-store` meant the browser could keep nothing, so every seek in a video
    // re-fetched bytes it had already been given — on a 975 MB file that is the
    // difference between scrubbing and re-buffering. The URL is authenticated
    // per user and the bytes are immutable once stored, so a private cache is
    // safe; `private` keeps it out of any shared proxy or CDN.
    "Cache-Control": effectiveDisposition === "inline" ? "private, max-age=3600" : "private, no-store",
    "Content-Disposition": `${effectiveDisposition}; filename="${encodeURIComponent(file.originalName)}"`
  };

  const { start, end, partial } = parseRange(rangeHeader, totalSize);
  if (start > end || start >= totalSize) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${totalSize}` } });
  }

  // ── Stored in the user's own Telegram account (one message, up to 2/4 GB) ──
  if (file.backend === "mtproto" && file.telegramMessageId) {
    if (!mtprotoSession) {
      return NextResponse.json(
        { error: "This file lives in your own Telegram account. Re-link it in Settings to download." },
        { status: 409 }
      );
    }
    const msgId = Number(file.telegramMessageId);
    const stream = buildRangeStream(start, end, (from, to) => downloadRange(mtprotoSession, msgId, from, to));
    const headers: Record<string, string> = { ...baseHeaders, "Content-Length": String(end - start + 1) };
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    return new NextResponse(stream, { status: partial ? 206 : 200, headers });
  }

  // ── Chunked files (all new uploads + legacy MTProto chunked) ───────────────
  if (file.isChunked) {
    if (file.uploadStatus !== "complete") {
      return NextResponse.json({ error: "File is still uploading." }, { status: 409 });
    }
    if (!file.chunks.length) {
      return NextResponse.json({ error: "File has no stored chunks." }, { status: 500 });
    }

    const chunkMap = mapChunkOffsets(file.chunks);
    const isBotStored = file.chunks.every(c => !!c.telegramFileId);

    if (!isBotStored && !legacySessionAvailable(userSession)) {
      return NextResponse.json(
        { error: "This file was stored with a legacy Telegram session. Add your session string in Settings → Legacy recovery to download it." },
        { status: 501 }
      );
    }

    const stream = buildChunkStream(chunkMap, start, end, chunk =>
      chunk.fileId
        ? fetchBotChunkBuffer(chunk.fileId, botToken)
        : downloadChunkFromTelegram(chunk.msgId, userSession)
    );

    const headers: Record<string, string> = { ...baseHeaders, "Content-Length": String(end - start + 1) };
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    return new NextResponse(stream, { status: partial ? 206 : 200, headers });
  }

  // ── Legacy single-document files (old channel uploads) ─────────────────────
  if (file.storageMode === StorageMode.BOT && file.telegramFileId) {
    const fileId = file.telegramFileId;
    const singleChunk: OffsetChunk[] = [{ start: 0, end: totalSize - 1, msgId: 0, fileId, size: totalSize }];
    const stream = buildChunkStream(singleChunk, start, end, () => fetchBotChunkBuffer(fileId, botToken));
    const headers: Record<string, string> = { ...baseHeaders, "Content-Length": String(end - start + 1) };
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    return new NextResponse(stream, { status: partial ? 206 : 200, headers });
  }

  // ── Legacy personal-session single files ───────────────────────────────────
  if (file.storageMode === StorageMode.PERSONAL && file.telegramMessageId) {
    if (!legacySessionAvailable(userSession)) {
      return NextResponse.json(
        { error: "This file needs the legacy Telegram session. Add it in Settings → Legacy recovery." },
        { status: 501 }
      );
    }
    const msgId = Number(file.telegramMessageId);
    const singleChunk: OffsetChunk[] = [{ start: 0, end: totalSize - 1, msgId, fileId: null, size: totalSize }];
    const stream = buildChunkStream(singleChunk, start, end, () => downloadChunkFromTelegram(msgId, userSession));
    const headers: Record<string, string> = { ...baseHeaders, "Content-Length": String(end - start + 1) };
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
    return new NextResponse(stream, { status: partial ? 206 : 200, headers });
  }

  return NextResponse.json({ error: "File has no retrievable Telegram storage reference." }, { status: 404 });
}

/** Standard Prisma include needed by streamFileResponse. */
export const streamInclude = {
  chunks: { orderBy: { chunkIndex: "asc" as const } },
  user: { include: { storageConfig: true } }
};
