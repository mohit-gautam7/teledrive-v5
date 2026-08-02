import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendDocumentToChat } from "@/lib/telegram-bot";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Thumbnails are tiny; anything larger is not one. */
const MAX_THUMB_BYTES = 512 * 1024;

/**
 * Store a browser-generated thumbnail for a file the user just uploaded, so the
 * grid never has to pay for lazy server-side generation.
 */
export async function POST(request: NextRequest, { params }: { params: { fileId: string } }) {
  try {
    const user = await requireUser();

    const file = await prisma.file.findFirst({
      where: { id: params.fileId, userId: user.id, isDeleted: false },
      select: { id: true, originalName: true, storageChatId: true, thumbFileId: true }
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
    // Already has one (a retry, or the server generated it first).
    if (file.thumbFileId) return NextResponse.json({ ok: true, alreadyPresent: true });

    const form = await request.formData();
    const blob = form.get("thumb");
    if (!(blob instanceof Blob)) {
      return NextResponse.json({ error: "Missing 'thumb' field." }, { status: 400 });
    }
    if (blob.size === 0 || blob.size > MAX_THUMB_BYTES) {
      return NextResponse.json({ error: "Thumbnail is empty or too large." }, { status: 413 });
    }

    const sent = await sendDocumentToChat({
      chatId: file.storageChatId || user.telegramId,
      data: Buffer.from(await blob.arrayBuffer()),
      filename: `${file.id}.thumb.webp`,
      mimeType: "image/webp",
      caption: `🖼 thumb: ${file.originalName}`
    });

    await prisma.file.update({ where: { id: file.id }, data: { thumbFileId: sent.fileId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error, "Could not store the thumbnail.");
  }
}
