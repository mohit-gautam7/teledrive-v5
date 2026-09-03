import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { env } from "@/lib/env";
import { deleteMessagesBot } from "@/lib/telegram-bot";
import { purgeTelegramCopies } from "@/lib/file-delete";
import { decryptSecret } from "@/lib/crypto";
import { resolveOwnedFolder } from "@/lib/folder-tree";

const patchSchema = z.union([
  z.object({ name: z.string().min(1).max(180) }),
  z.object({ isFavorite: z.boolean() }),
  z.object({ restore: z.literal(true) }),
  z.object({ folderId: z.string().nullable() })
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
    } else if ("folderId" in body) {
      data = { folderId: await resolveOwnedFolder(user.id, body.folderId) };
    } else {
      data = { isDeleted: false };
    }
    // Ownership is confirmed before the write rather than left to the update's
    // own miss. Prisma raises P2025 for "no row matched", which jsonError can
    // only report as a 500 — so someone else's file id answered with a server
    // error (and a logged reference) instead of the 404 every sibling route
    // gives. The write was already scoped; only the answer was wrong.
    const owned = await prisma.file.findFirst({ where: { id: params.id, userId: user.id }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "File not found." }, { status: 404 });

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
    const file = await prisma.file.findFirst({
      where: { id: params.id, userId: user.id },
      include: { chunks: true, user: { include: { storageConfig: true } } }
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    if (file.isDeleted) {
      // Permanent delete — also try to remove the Telegram copies.
      await purgeTelegramCopies(file);

      if (!file.isChunked && file.storageMode === "BOT" && file.telegramMessageId) {
        const channelId = file.user.storageConfig?.botChannelId || env.BOT_CHANNEL_ID;
        if (channelId) {
          await deleteMessagesBot(
            channelId,
            [Number(file.telegramMessageId)],
            decryptSecret(file.user.storageConfig?.botToken)
          );
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
