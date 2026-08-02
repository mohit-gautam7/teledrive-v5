import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { STORED_ONLY } from "@/lib/upload-config";

export const runtime = "nodejs";

/**
 * Aggregate totals for the sidebar, and the fuller breakdown for the insights
 * panel behind `?full=1`. All aggregation happens in Postgres — no file rows
 * are shipped to the app.
 *
 * The split matters under load: the transaction pooler runs one connection per
 * request, so the five-query version serialises. Every page load paying that
 * cost would be the single most expensive thing the app does at rest.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const live = { userId: user.id, isDeleted: false, ...STORED_ONLY };

    if (new URL(request.url).searchParams.get("full") !== "1") {
      const agg = await prisma.file.aggregate({ where: live, _sum: { size: true }, _count: true });
      return NextResponse.json({ totalSize: Number(agg._sum.size ?? 0), count: agg._count });
    }

    const [agg, trash, byBackend, byType, largest] = await Promise.all([
      prisma.file.aggregate({ where: live, _sum: { size: true }, _count: true }),
      prisma.file.aggregate({ where: { userId: user.id, isDeleted: true }, _sum: { size: true }, _count: true }),
      prisma.file.groupBy({ by: ["backend"], where: live, _sum: { size: true }, _count: { _all: true } }),
      prisma.$queryRaw<Array<{ bucket: string; bytes: bigint; files: bigint }>>`
        SELECT
          CASE
            WHEN "mimeType" LIKE 'image/%' THEN 'image'
            WHEN "mimeType" LIKE 'video/%' THEN 'video'
            WHEN "mimeType" LIKE 'audio/%' THEN 'audio'
            ELSE 'document'
          END AS bucket,
          COALESCE(SUM("size"), 0) AS bytes,
          COUNT(*) AS files
        FROM "File"
        WHERE "userId" = ${user.id} AND "isDeleted" = false
        GROUP BY bucket
      `,
      prisma.file.findMany({
        where: live,
        orderBy: { size: "desc" },
        take: 5,
        select: { id: true, originalName: true, mimeType: true, size: true }
      })
    ]);

    return NextResponse.json({
      totalSize: Number(agg._sum.size ?? 0),
      count: agg._count,
      trashSize: Number(trash._sum.size ?? 0),
      trashCount: trash._count,
      byBackend: byBackend.map(b => ({
        backend: b.backend,
        bytes: Number(b._sum.size ?? 0),
        files: b._count._all
      })),
      byType: byType.map(t => ({ bucket: t.bucket, bytes: Number(t.bytes), files: Number(t.files) })),
      largest: largest.map(f => ({ ...f, size: Number(f.size) }))
    });
  } catch (error) {
    return jsonError(error, "Could not load stats.");
  }
}
