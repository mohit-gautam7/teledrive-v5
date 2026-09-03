import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { safeName, toPublicFile } from "@/lib/file-router";
import { prisma } from "@/lib/prisma";
import { sendDocumentToChat } from "@/lib/telegram-bot";
import { jsonError } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { SINGLE_SHOT_LIMIT } from "@/lib/upload-config";
import { resolveOwnedFolder } from "@/lib/folder-tree";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Fast path for small files (≤ one chunk): a single request that stores the
 * document in the user's own bot chat. Larger files use init/chunk/complete.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    rateLimit(`upload-small:${user.id}`, 300, 60_000);
    const form = await request.formData();
    const file = form.get("file");
    const folderId = form.get("folderId");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }
    // Not just "bigger than a chunk": this path stores one bot document, and a
    // bot cannot download one over 20 MB. See SINGLE_SHOT_LIMIT.
    if (file.size > SINGLE_SHOT_LIMIT) {
      return NextResponse.json(
        { error: `Files over ${Math.round(SINGLE_SHOT_LIMIT / (1024 * 1024))} MB must use the chunked upload.` },
        { status: 413 }
      );
    }

    const destination = await resolveOwnedFolder(user.id, typeof folderId === "string" ? folderId : null);
    const mimeType = file.type || "application/octet-stream";
    const buffer = Buffer.from(await file.arrayBuffer());

    const sent = await sendDocumentToChat({
      chatId: user.telegramId,
      data: buffer,
      filename: safeName(file.name),
      mimeType,
      caption: `📄 ${file.name}`
    });

    const record = await prisma.file.create({
      data: {
        userId: user.id,
        filename: safeName(file.name),
        originalName: file.name,
        mimeType,
        size: BigInt(file.size),
        storageMode: StorageMode.BOT,
        storageChatId: user.telegramId,
        isChunked: true,
        totalChunks: 1,
        uploadStatus: "complete",
        folderId: destination,
        chunks: {
          create: { chunkIndex: 0, telegramMsgId: sent.messageId, telegramFileId: sent.fileId, chunkSize: buffer.length }
        }
      }
    });
    return NextResponse.json({ file: toPublicFile(record) });
  } catch (error) {
    return jsonError(error, "Upload failed.");
  }
}
