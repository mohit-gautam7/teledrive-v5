import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { decideStorage, safeName, toPublicFile } from "@/lib/file-router";
import { prisma } from "@/lib/prisma";
import { uploadWithBot, uploadWithPersonalTelegram } from "@/lib/telegram";
import { decryptSecret } from "@/lib/crypto";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const form = await request.formData();
    const file = form.get("file");
    const folderId = form.get("folderId");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file." }, { status: 400 });
    }

    const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
    const hasPersonalSession = !!(config?.telegramSession || process.env.TELEGRAM_SESSION);

    if (!hasPersonalSession && file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ error: "Files over 50 MB require a Telegram personal session. Configure it in Settings → Large Files." }, { status: 413 });
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: "Telegram's maximum file size is 2 GB." }, { status: 413 });
    }

    const mimeType = file.type || "application/octet-stream";
    const decision = decideStorage(mimeType, file.size, hasPersonalSession);
    const storageResult: { fileId?: string; messageId?: string; filePath?: string } =
      decision.storageMode === "BOT"
        ? await uploadWithBot(file, config?.botToken, config?.botChannelId)
        : await uploadWithPersonalTelegram(file, decryptSecret(config?.telegramSession));

    const record = await prisma.file.create({
      data: {
        userId: user.id,
        filename: safeName(file.name),
        originalName: file.name,
        mimeType,
        size: BigInt(file.size),
        storageMode: decision.storageMode,
        telegramFileId: storageResult.fileId || null,
        telegramMessageId: storageResult.messageId || null,
        telegramFilePath: storageResult.filePath || null,
        folderId: typeof folderId === "string" && folderId ? folderId : null
      }
    });
    return NextResponse.json({ file: toPublicFile(record), routing: decision });
  } catch (error) {
    return jsonError(error, "Upload failed.");
  }
}
