import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";

export const runtime = "nodejs";

// Aggregate totals for the sidebar — cheap, index-backed, avoids loading rows.
export async function GET() {
  try {
    const user = await requireUser();
    const agg = await prisma.file.aggregate({
      where: { userId: user.id, isDeleted: false },
      _sum: { size: true },
      _count: true
    });
    return NextResponse.json({
      totalSize: Number(agg._sum.size ?? 0),
      count: agg._count
    });
  } catch (error) {
    return jsonError(error, "Could not load stats.");
  }
}
