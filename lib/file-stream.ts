import { NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { fetchBotFile } from "@/lib/telegram-bot";
import { downloadChunkFromTelegram, legacySessionAvailable } from "@/lib/telegram";
import { decryptSecret } from "@/lib/crypto";

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
  isChunked: boolean;
  uploadStatus: string;
  telegramFileId: string | null;
  telegramMessageId: string | null;
  chunks: Array<{ chunkIndex: number; telegramMsgId: number; telegramFileId: string | null; chunkSize: number }>;
  user?: { storageConfig?: { botToken: string | null; telegramSession: string | null } | null } | null;
};

export function parseRange(rangeHeader: string | null, totalSize: number): { start: number; end: number; partial: boolean } {
  if (!rangeHeader) return { start: 0, end: totalSize - 1, partial: false };
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!m || (!m[1] && !m[2])) return { start: 0, end: totalSize - 1, partial: false };
  const start = m[1] ? Math.max(0, parseInt(m[1], 10)) : Math.max(0, totalSize - parseInt(m[2], 10));
  const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
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

async function fetchBotChunkBuffer(fileId: string, botToken?: string | null): Promise<Buffer> {
  const res = await fetchBotFile(fileId, botToken);
  return Buffer.from(await res.arrayBuffer());
}

export function streamFileResponse(
  file: StreamableFile,
  rangeHeader: string | null,
  disposition: "inline" | "attachment"
): NextResponse {
  const totalSize = Number(file.size);
  const userSession = decryptSecret(file.user?.storageConfig?.telegramSession);
  const userBotToken = file.user?.storageConfig?.botToken || null;

  const baseHeaders: Record<string, string> = {
    "Content-Type": file.mimeType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${disposition}; filename="${encodeURIComponent(file.originalName)}"`
  };

  const { start, end, partial } = parseRange(rangeHeader, totalSize);
  if (start > end || start >= totalSize) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${totalSize}` } });
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
        ? fetchBotChunkBuffer(chunk.fileId, userBotToken)
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
    const stream = buildChunkStream(singleChunk, start, end, () => fetchBotChunkBuffer(fileId, userBotToken));
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
