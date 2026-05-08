import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBotFileUrl } from "@/lib/telegram";

export async function GET(request: NextRequest, { params }: { params: { token: string } }) {
  const share = await prisma.share.findUnique({ where: { shareToken: params.token }, include: { file: { include: { user: { include: { storageConfig: true } } } } } });
  if (!share || share.disabled || share.file.isDeleted) return NextResponse.json({ error: "Share not found." }, { status: 404 });
  if (share.expiryDate && share.expiryDate < new Date()) return NextResponse.json({ error: "Share expired." }, { status: 410 });
  if (share.passwordHash) return NextResponse.json({ error: "Password protected shares must be opened in the share page." }, { status: 401 });
  if (share.file.storageMode === StorageMode.PERSONAL) {
    return NextResponse.json({ error: "Personal Telegram streaming requires the signed-in MTProto session." }, { status: 501 });
  }
  if (!share.file.telegramFileId) return NextResponse.json({ error: "Missing Telegram file id." }, { status: 404 });
  const url = await getBotFileUrl(share.file.telegramFileId, share.file.user.storageConfig?.botToken);
  const upstream = await fetch(url, {
    headers: request.headers.get("range") ? { range: request.headers.get("range") as string } : {}
  });
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": share.file.mimeType,
      "accept-ranges": "bytes",
      "content-length": upstream.headers.get("content-length") || String(share.file.size),
      ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") as string } : {})
    }
  });
}
