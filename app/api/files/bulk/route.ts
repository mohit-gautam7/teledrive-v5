import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteMessagesBot } from "@/lib/telegram-bot";
import { deleteChunkMessages } from "@/lib/telegram";
import { decryptSecret } from "@/lib/crypto";
import { jsonError } from "@/lib/api-response";

const schema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(["move", "trash", "restore", "favorite", "unfavorite", "delete"]),
  folderId: z.string().nullable().optional()
});

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const { ids, action, folderId } = schema.parse(await request.json());
    const scope = { id: { in: ids }, userId: user.id };

    if (action === "move") {
      await prisma.file.updateMany({ where: scope, data: { folderId: folderId ?? null } });
    } else if (action === "trash") {
      await prisma.file.updateMany({ where: scope, data: { isDeleted: true } });
    } else if (action === "restore") {
      await prisma.file.updateMany({ where: scope, data: { isDeleted: false } });
    } else if (action === "favorite") {
      await prisma.file.updateMany({ where: scope, data: { isFavorite: true } });
    } else if (action === "unfavorite") {
      await prisma.file.updateMany({ where: scope, data: { isFavorite: false } });
    } else if (action === "delete") {
      // Permanent delete — remove Telegram copies where we can, then the rows.
      const files = await prisma.file.findMany({
        where: scope,
        include: { chunks: true, user: { include: { storageConfig: true } } }
      });
      type ChunkLite = { telegramFileId: string | null; telegramMsgId: number };
      for (const file of files) {
        const botMsgIds = file.chunks.filter((c: ChunkLite) => c.telegramFileId && c.telegramMsgId > 0).map((c: ChunkLite) => c.telegramMsgId);
        const legacyMsgIds = file.chunks.filter((c: ChunkLite) => !c.telegramFileId).map((c: ChunkLite) => c.telegramMsgId);
        if (botMsgIds.length && file.storageChatId) await deleteMessagesBot(file.storageChatId, botMsgIds);
        if (legacyMsgIds.length) await deleteChunkMessages(legacyMsgIds, decryptSecret(file.user.storageConfig?.telegramSession));
      }
      await prisma.file.deleteMany({ where: scope });
    }

    return NextResponse.json({ ok: true, count: ids.length });
  } catch (error) {
    return jsonError(error, "Bulk action failed.");
  }
}
