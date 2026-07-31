import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toPublicFile } from "@/lib/file-router";
import { jsonError } from "@/lib/api-response";
import { finalizeBigFile } from "@/lib/telegram-user";
import { userMtprotoSession } from "@/lib/mtproto-session";
import { MTPROTO_PART_SIZE } from "@/lib/upload-config";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: NextRequest,
  { params }: { params: { fileId: string } }
) {
  try {
    const user = await requireUser();
    const fileId = params.fileId;

    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: user.id, uploadStatus: "uploading", isChunked: true },
      include: { chunks: true }
    });
    if (!file) {
      return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
    }

    if (file.chunks.length < file.totalChunks) {
      return NextResponse.json(
        { error: `Incomplete: ${file.chunks.length}/${file.totalChunks} chunks received.` },
        { status: 400 }
      );
    }

    const stored = file.chunks.reduce((sum: number, c: { chunkSize: number }) => sum + c.chunkSize, 0);
    if (stored !== Number(file.size)) {
      return NextResponse.json(
        { error: `Size mismatch: stored ${stored} bytes, expected ${file.size}. Retry the upload.` },
        { status: 400 }
      );
    }

    // MTProto: the parts are on Telegram's servers but not yet a message. Turn
    // them into one document in the user's Saved Messages.
    if (file.backend === "mtproto") {
      const session = await userMtprotoSession(user.id);
      if (!session) {
        return NextResponse.json(
          { error: "Your Telegram account is no longer linked, so this upload can't be finalised." },
          { status: 409 }
        );
      }
      if (!file.telegramFileId) {
        return NextResponse.json({ error: "Upload session is missing its Telegram file id." }, { status: 500 });
      }
      const { messageId } = await finalizeBigFile({
        session,
        fileId: file.telegramFileId,
        totalParts: Math.ceil(Number(file.size) / MTPROTO_PART_SIZE),
        fileName: file.filename,
        mimeType: file.mimeType,
        caption: `📄 ${file.originalName}`
      });
      const updated = await prisma.file.update({
        where: { id: fileId },
        data: {
          uploadStatus: "complete",
          telegramMessageId: String(messageId),
          // Bytes now live in one message, not in per-chunk records.
          isChunked: false
        }
      });
      await prisma.chunk.deleteMany({ where: { fileId } });
      return NextResponse.json({ file: toPublicFile(updated) });
    }

    const updated = await prisma.file.update({
      where: { id: fileId },
      data: { uploadStatus: "complete" }
    });

    return NextResponse.json({ file: toPublicFile(updated) });
  } catch (error) {
    return jsonError(error, "Could not complete upload.");
  }
}
