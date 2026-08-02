import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendDocumentToChat } from "@/lib/telegram-bot";
import { saveBigFileParts } from "@/lib/telegram-user";
import { userMtprotoSession } from "@/lib/mtproto-session";
import { jsonError } from "@/lib/api-response";
import { CHUNK_SIZE, MTPROTO_PART_SIZE } from "@/lib/upload-config";

export const runtime = "nodejs";
export const maxDuration = 60;

const PARTS_PER_CHUNK = CHUNK_SIZE / MTPROTO_PART_SIZE;

export async function POST(
  request: NextRequest,
  { params }: { params: { fileId: string; chunkIndex: string } }
) {
  try {
    const user = await requireUser();
    const fileId = params.fileId;
    const chunkIndex = parseInt(params.chunkIndex, 10);

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return NextResponse.json({ error: "Invalid chunkIndex." }, { status: 400 });
    }

    const file = await prisma.file.findFirst({
      where: { id: fileId, userId: user.id, uploadStatus: "uploading", isChunked: true }
    });
    if (!file) {
      return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
    }
    if (chunkIndex >= file.totalChunks) {
      return NextResponse.json({ error: "chunkIndex out of range." }, { status: 400 });
    }

    const form = await request.formData();
    const blob = form.get("chunk");
    if (!(blob instanceof Blob)) {
      return NextResponse.json({ error: "Missing 'chunk' field in form data." }, { status: 400 });
    }
    if (blob.size > CHUNK_SIZE + 1024) {
      return NextResponse.json({ error: "Chunk exceeds the 4 MB limit." }, { status: 413 });
    }

    // Idempotent: a retried or resumed chunk that already landed is acknowledged
    // without sending a second copy into Telegram.
    const already = await prisma.chunk.findUnique({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
      select: { chunkSize: true }
    });
    if (already && already.chunkSize === blob.size) {
      return NextResponse.json({ success: true, chunkIndex, deduped: true });
    }

    const buffer = Buffer.from(await blob.arrayBuffer());

    // ── The user's own Telegram session: 512 KiB MTProto parts ───────────────
    if (file.backend === "mtproto") {
      const session = await userMtprotoSession(user.id);
      if (!session) {
        return NextResponse.json(
          { error: "Your Telegram account is no longer linked. Re-link it in Settings and retry." },
          { status: 409 }
        );
      }
      if (!file.telegramFileId) {
        return NextResponse.json({ error: "Upload session is missing its Telegram file id." }, { status: 500 });
      }
      const totalParts = Math.ceil(Number(file.size) / MTPROTO_PART_SIZE);
      await saveBigFileParts(session, file.telegramFileId, chunkIndex * PARTS_PER_CHUNK, totalParts, buffer);

      await prisma.chunk.upsert({
        where: { fileId_chunkIndex: { fileId, chunkIndex } },
        create: { fileId, chunkIndex, telegramMsgId: 0, telegramFileId: null, chunkSize: buffer.length },
        update: { chunkSize: buffer.length }
      });
      return NextResponse.json({ success: true, chunkIndex });
    }

    // ── Bot storage: one document per chunk in the user's own bot chat ───────
    const chatId = file.storageChatId || user.telegramId;
    const single = file.totalChunks === 1;

    const sent = await sendDocumentToChat({
      chatId,
      data: buffer,
      filename: single ? file.filename : `${file.filename}.part${String(chunkIndex + 1).padStart(3, "0")}`,
      mimeType: single ? file.mimeType : "application/octet-stream",
      caption: single
        ? `📄 ${file.originalName}`
        : `📦 ${file.originalName} — part ${chunkIndex + 1}/${file.totalChunks}`,
      userKey: user.id
    });

    await prisma.chunk.upsert({
      where: { fileId_chunkIndex: { fileId, chunkIndex } },
      create: { fileId, chunkIndex, telegramMsgId: sent.messageId, telegramFileId: sent.fileId, chunkSize: buffer.length },
      update: { telegramMsgId: sent.messageId, telegramFileId: sent.fileId, chunkSize: buffer.length }
    });

    return NextResponse.json({ success: true, chunkIndex });
  } catch (error) {
    return jsonError(error, "Chunk upload failed.");
  }
}
