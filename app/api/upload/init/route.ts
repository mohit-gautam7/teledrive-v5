import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeName } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { CHUNK_SIZE, SAVED_MESSAGES, STALE_UPLOAD_MS, backendFor } from "@/lib/upload-config";
import { purgeTelegramCopies } from "@/lib/file-delete";
import { maxUploadBytesFor, describeLimit } from "@/lib/upload-limits";

export const runtime = "nodejs";

/** MTProto identifies an in-progress big-file upload by a client-chosen 64-bit id. */
function newMtprotoFileId() {
  return crypto.randomBytes(8).readBigInt64LE(0).toString();
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();

    const { fileName, mimeType, fileSize, folderId, resumeKey } = (await request.json()) as {
      fileName: string;
      mimeType: string;
      fileSize: number;
      folderId?: string;
      resumeKey?: string;
    };

    if (!fileName || !fileSize || fileSize <= 0) {
      return NextResponse.json({ error: "fileName and fileSize are required." }, { status: 400 });
    }

    const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
    const limit = maxUploadBytesFor(config);
    if (fileSize > limit) {
      return NextResponse.json({ error: `Maximum file size is ${describeLimit(limit)}.` }, { status: 413 });
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const targetFolder = typeof folderId === "string" && folderId ? folderId : null;

    // Sweep this user's long-abandoned sessions. A session is kept resumable for
    // a day; past that the browser that started it is not coming back, and the
    // row would otherwise sit in the database forever. Capped per call so a user
    // with a backlog does not pay for the whole cleanup on one upload, and never
    // fatal — a failed sweep must not block a working upload.
    try {
      const stale = await prisma.file.findMany({
        where: {
          userId: user.id,
          uploadStatus: "uploading",
          createdAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) }
        },
        include: { chunks: true, user: { include: { storageConfig: true } } },
        take: 5
      });
      for (const old of stale) {
        await purgeTelegramCopies(old);
        await prisma.file.delete({ where: { id: old.id } });
      }
    } catch (sweepError) {
      console.warn("[upload/init] stale-session sweep failed (continuing):", (sweepError as Error).message);
    }

    // Anything a bot cannot hold in one message goes through the user's own
    // Telegram session when they have linked one: a single message in their
    // Saved Messages instead of hundreds of bot chunks, and the only way past
    // the Bot API's 20 MB download ceiling.
    const useMtproto = backendFor(fileSize, Boolean(config?.mtprotoSession)) === "mtproto";

    // Resume: an unfinished session for the same file+destination is reused, so
    // a dropped connection costs only the chunks that were still in flight.
    if (resumeKey) {
      const existing = await prisma.file.findFirst({
        where: {
          userId: user.id,
          resumeKey,
          uploadStatus: "uploading",
          isChunked: true,
          size: BigInt(fileSize),
          folderId: targetFolder
        },
        include: { chunks: { select: { chunkIndex: true } } }
      });
      // Only resume a session that was chunked at the size we use now. If
      // UPLOAD_CHUNK_MB changed since it started, its chunk boundaries no longer
      // line up and reusing it would interleave slices of two different sizes —
      // so it is left to the sweeper and a fresh session is created instead.
      if (existing && existing.totalChunks === totalChunks) {
        return NextResponse.json({
          fileId: existing.id,
          totalChunks: existing.totalChunks,
          chunkSizeBytes: CHUNK_SIZE,
          backend: existing.backend,
          received: existing.chunks.map(c => c.chunkIndex),
          resumed: true
        });
      }
    }

    const file = await prisma.file.create({
      data: {
        userId: user.id,
        filename: safeName(fileName),
        originalName: fileName,
        mimeType: mimeType || "application/octet-stream",
        size: BigInt(fileSize),
        storageMode: useMtproto ? StorageMode.PERSONAL : StorageMode.BOT,
        backend: useMtproto ? "mtproto" : "bot",
        // For MTProto this holds the in-progress upload id, not a Bot API file_id.
        telegramFileId: useMtproto ? newMtprotoFileId() : null,
        // "me" — the account's own Saved Messages, which is literally what the
        // finalise, download and delete paths pass to Telegram for these files.
        storageChatId: useMtproto ? SAVED_MESSAGES : user.telegramId,
        isChunked: true,
        totalChunks,
        uploadStatus: "uploading",
        resumeKey: resumeKey || null,
        folderId: targetFolder
      }
    });

    return NextResponse.json({
      fileId: file.id,
      totalChunks,
      chunkSizeBytes: CHUNK_SIZE,
      backend: file.backend,
      received: [],
      resumed: false
    });
  } catch (error) {
    return jsonError(error, "Could not initialise upload.");
  }
}
