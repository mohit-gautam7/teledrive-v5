import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { purgeTelegramCopies } from "@/lib/file-delete";
import { jsonError } from "@/lib/api-response";

const schema = z.union([
  z.object({
    ids: z.array(z.string()).min(1).max(500),
    action: z.enum(["move", "trash", "restore", "favorite", "unfavorite", "delete"]),
    folderId: z.string().nullable().optional()
  }),
  z.object({ action: z.literal("emptyTrash") })
]);

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    const body = schema.parse(await request.json());

    // Empty trash: permanently delete every trashed file for this user.
    if (body.action === "emptyTrash") {
      const trashed = await prisma.file.findMany({
        where: { userId: user.id, isDeleted: true },
        include: { chunks: true, user: { include: { storageConfig: true } } }
      });
      for (const file of trashed) await purgeTelegramCopies(file);
      await prisma.file.deleteMany({ where: { userId: user.id, isDeleted: true } });
      return NextResponse.json({ ok: true, count: trashed.length });
    }

    const { ids, action, folderId } = body;
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
      for (const file of files) await purgeTelegramCopies(file);
      await prisma.file.deleteMany({ where: scope });
    }

    return NextResponse.json({ ok: true, count: ids.length });
  } catch (error) {
    return jsonError(error, "Bulk action failed.");
  }
}
