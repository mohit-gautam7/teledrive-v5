import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getBotFileUrl } from "@/lib/telegram";

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const share = await prisma.share.findUnique({ where: { shareToken: params.token }, include: { file: { include: { user: { include: { storageConfig: true } } } } } });
  if (!share || share.disabled || share.file.isDeleted) return NextResponse.json({ error: "Share not found." }, { status: 404 });
  if (share.expiryDate && share.expiryDate < new Date()) return NextResponse.json({ error: "Share expired." }, { status: 410 });
  if (share.passwordHash) return NextResponse.json({ error: "Password protected shares must be opened in the share page." }, { status: 401 });
  if (share.file.storageMode === StorageMode.PERSONAL) {
    return NextResponse.json({ error: "Personal Telegram downloads require the signed-in MTProto session." }, { status: 501 });
  }
  if (!share.file.telegramFileId) return NextResponse.json({ error: "Missing Telegram file id." }, { status: 404 });
  const url = await getBotFileUrl(share.file.telegramFileId, share.file.user.storageConfig?.botToken);
  return NextResponse.redirect(url);
}
