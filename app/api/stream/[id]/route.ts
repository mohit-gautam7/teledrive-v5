import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBotFileUrl } from "@/lib/telegram";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const file = await prisma.file.findFirst({ where: { id: params.id, userId: user.id, isDeleted: false } });
  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  if (file.storageMode === StorageMode.PERSONAL) {
    return NextResponse.json({ error: "Personal video streaming requires a long-running MTProto worker." }, { status: 501 });
  }
  if (!file.telegramFileId) return NextResponse.json({ error: "Missing Telegram file id." }, { status: 404 });
  const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
  const url = await getBotFileUrl(file.telegramFileId, config?.botToken);
  const upstream = await fetch(url, {
    headers: request.headers.get("range") ? { range: request.headers.get("range") as string } : {}
  });
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": file.mimeType,
      "accept-ranges": "bytes",
      "content-length": upstream.headers.get("content-length") || String(file.size),
      ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") as string } : {})
    }
  });
}
