import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeName } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { CHUNK_SIZE, MAX_FILE_SIZE } from "@/lib/upload-config";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();

    const { fileName, mimeType, fileSize, folderId } = (await request.json()) as {
      fileName: string;
      mimeType: string;
      fileSize: number;
      folderId?: string;
    };

    if (!fileName || !fileSize || fileSize <= 0) {
      return NextResponse.json({ error: "fileName and fileSize are required." }, { status: 400 });
    }
    if (fileSize > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Maximum file size is 2 GB (Telegram's limit)." }, { status: 413 });
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    const file = await prisma.file.create({
      data: {
        userId: user.id,
        filename: safeName(fileName),
        originalName: fileName,
        mimeType: mimeType || "application/octet-stream",
        size: BigInt(fileSize),
        storageMode: StorageMode.BOT,
        storageChatId: user.telegramId,
        isChunked: true,
        totalChunks,
        uploadStatus: "uploading",
        folderId: typeof folderId === "string" && folderId ? folderId : null
      }
    });

    return NextResponse.json({ fileId: file.id, totalChunks, chunkSizeBytes: CHUNK_SIZE });
  } catch (error) {
    return jsonError(error, "Could not initialise upload.");
  }
}
