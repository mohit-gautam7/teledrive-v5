import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBotFileUrl } from "@/lib/telegram";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const file = await prisma.file.findFirst({ where: { id: params.id, userId: user.id, isDeleted: false } });
  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  if (file.storageMode === StorageMode.PERSONAL) {
    return NextResponse.json(
      { error: "Personal Telegram download needs a VPS worker or MTProto download session." },
      { status: 501 }
    );
  }
  if (!file.telegramFileId) return NextResponse.json({ error: "Missing Telegram file id." }, { status: 404 });
  const config = await prisma.storageConfig.findUnique({ where: { userId: user.id } });
  const url = await getBotFileUrl(file.telegramFileId, config?.botToken);
  return NextResponse.redirect(url);
}
