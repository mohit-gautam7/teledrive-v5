import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { env } from "@/lib/env";
import { deleteMessageFromBot } from "@/server/services/telegramBot";

const patchSchema = z.union([
  z.object({ name: z.string().min(1).max(180) }),
  z.object({ isFavorite: z.boolean() }),
  z.object({ restore: z.literal(true) })
]);

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const body = patchSchema.parse(await request.json());
    let data: Record<string, unknown>;
    if ("name" in body) {
      data = { originalName: body.name, filename: body.name };
    } else if ("isFavorite" in body) {
      data = { isFavorite: body.isFavorite };
    } else {
      data = { isDeleted: false };
    }
    const file = await prisma.file.update({
      where: { id: params.id, userId: user.id },
      data
    });
    return NextResponse.json({ file: { ...file, size: Number(file.size) } });
  } catch (error) {
    return jsonError(error, "Could not update file.");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    const file = await prisma.file.findUnique({
      where: { id: params.id, userId: user.id },
      include: { user: { include: { storageConfig: true } } }
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    if (file.isDeleted) {
      // Permanently delete — also remove from Telegram channel for BOT storage
      if (file.storageMode === "BOT" && file.telegramMessageId) {
        const botToken = file.user.storageConfig?.botToken || env.BOT_TOKEN;
        const channelId = file.user.storageConfig?.botChannelId || env.BOT_CHANNEL_ID;
        if (botToken && channelId) {
          try {
            await deleteMessageFromBot(botToken, channelId, Number(file.telegramMessageId));
          } catch {
            console.error("Telegram delete failed, continuing with DB delete");
          }
        }
      }
      await prisma.file.delete({ where: { id: params.id } });
      return NextResponse.json({ ok: true, permanent: true });
    }

    await prisma.file.update({ where: { id: params.id }, data: { isDeleted: true } });
    return NextResponse.json({ ok: true, permanent: false });
  } catch (error) {
    return jsonError(error, "Could not delete file.");
  }
}
