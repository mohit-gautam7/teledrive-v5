import { NextRequest, NextResponse } from "next/server";
import { StorageMode } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getBotFileUrl } from "@/lib/telegram";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser();
  const file = await prisma.file.findFirst({
    where: { id: params.id, userId: user.id, isDeleted: false },
    include: { user: { include: { storageConfig: true } } }
  });

  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  if (file.storageMode === StorageMode.PERSONAL) {
    return NextResponse.json({ error: "Personal Telegram previews need MTProto download support." }, { status: 501 });
  }
  if (!file.telegramFileId) return NextResponse.json({ error: "Missing Telegram file id." }, { status: 404 });

  const url = await getBotFileUrl(file.telegramFileId, file.user.storageConfig?.botToken);
  const response = NextResponse.redirect(url);
  response.headers.set("cache-control", "private, max-age=300, stale-while-revalidate=3600");
  return response;
}
