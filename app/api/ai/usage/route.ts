import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
// Without this Next prerenders the route: the flag check returns before
// anything touches cookies, so the build sees a static 404 and bakes in the
// answer from build time — leaving the endpoint dead even with AI_ENABLED set.
export const dynamic = "force-dynamic";

/**
 * Usage and spend, aggregated in Postgres.
 *
 * `costMicros` sums only the calls whose model has a configured price, so
 * `pricedCalls` is reported alongside it — a total is misleading without knowing
 * how much of the traffic it actually covers.
 */
export async function GET(request: NextRequest) {
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scope = { userId: user.id, createdAt: { gte: since } };

    const [totals, priced, byProvider, byTask] = await Promise.all([
      prisma.aiUsage.aggregate({
        where: scope,
        _sum: { promptTokens: true, completionTokens: true, costMicros: true },
        _count: { _all: true },
        _avg: { latencyMs: true }
      }),
      prisma.aiUsage.count({ where: { ...scope, costMicros: { not: null } } }),
      prisma.aiUsage.groupBy({
        by: ["provider"],
        where: scope,
        _sum: { promptTokens: true, completionTokens: true, costMicros: true },
        _count: { _all: true }
      }),
      prisma.aiUsage.groupBy({
        by: ["task"],
        where: scope,
        _sum: { costMicros: true },
        _count: { _all: true }
      })
    ]);

    const errors = await prisma.aiUsage.count({ where: { ...scope, status: "error" } });

    return NextResponse.json({
      days,
      calls: totals._count._all,
      errors,
      pricedCalls: priced,
      promptTokens: totals._sum.promptTokens ?? 0,
      completionTokens: totals._sum.completionTokens ?? 0,
      costMicros: Number(totals._sum.costMicros ?? BigInt(0)),
      avgLatencyMs: Math.round(totals._avg.latencyMs ?? 0),
      byProvider: byProvider.map(p => ({
        provider: p.provider,
        calls: p._count._all,
        promptTokens: p._sum.promptTokens ?? 0,
        completionTokens: p._sum.completionTokens ?? 0,
        costMicros: Number(p._sum.costMicros ?? BigInt(0))
      })),
      byTask: byTask.map(t => ({
        task: t.task,
        calls: t._count._all,
        costMicros: Number(t._sum.costMicros ?? BigInt(0))
      }))
    });
  } catch (error) {
    return jsonError(error, "Could not load AI usage.");
  }
}
