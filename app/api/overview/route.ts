import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { STORED_ONLY } from "@/lib/upload-config";
import { describeLink } from "@/lib/telegram-link";
import { rollUpFolders } from "@/lib/folder-tree";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the drive needs on load, except the file listing.
 *
 * Mounting used to fire four requests — session, folder tree, storage totals and
 * the Telegram link — which against the transaction pooler's single connection
 * do not overlap: they queue, and the page finishes loading at the sum of their
 * latencies rather than the longest. They are answered together here, the same
 * way the AI section already works.
 *
 * The file listing stays separate on purpose: it depends on the folder, sort,
 * filter and search, and it is cached per combination client-side.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const live = { userId: user.id, isDeleted: false, ...STORED_ONLY };

    const [folders, grouped, totals, config] = await Promise.all([
      prisma.folder.findMany({
        where: { userId: user.id },
        select: { id: true, name: true, parentId: true, createdAt: true }
      }),
      prisma.file.groupBy({
        by: ["folderId"],
        where: { userId: user.id, isDeleted: false, folderId: { not: null } },
        _sum: { size: true },
        _count: { _all: true }
      }),
      prisma.file.aggregate({ where: live, _sum: { size: true }, _count: true }),
      prisma.storageConfig.findUnique({ where: { userId: user.id } })
    ]);

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        avatar: user.avatar
      },
      folders: rollUpFolders(folders, grouped),
      stats: { totalSize: Number(totals._sum.size ?? 0), count: totals._count },
      link: describeLink(config)
    });
  } catch (error) {
    return jsonError(error, "Could not load your drive.");
  }
}
