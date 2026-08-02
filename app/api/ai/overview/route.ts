import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { listKeys } from "@/lib/ai/vault";
import { publicProviders } from "@/lib/ai/providers";
import { AI_MODES, readPreferences } from "@/lib/ai/modes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the Settings AI section needs, in one request.
 *
 * The four cards used to fetch independently. That is four round-trips which,
 * against a transaction pooler running `connection_limit=1`, serialise — the
 * usage aggregates alone took ~7.6 s, and whichever card lost the race rendered
 * blank. Here the queries still run against one connection, but as a single
 * `Promise.all` inside one request, and the section renders once with all of it.
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

    const [keys, preferences, automations, totals, priced, errors, byProvider, byTask, daily] = await Promise.all([
      listKeys(user.id),
      readPreferences(user.id),
      prisma.automation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
      prisma.aiUsage.aggregate({
        where: scope,
        _sum: { promptTokens: true, completionTokens: true, costMicros: true },
        _count: { _all: true },
        _avg: { latencyMs: true }
      }),
      prisma.aiUsage.count({ where: { ...scope, costMicros: { not: null } } }),
      prisma.aiUsage.count({ where: { ...scope, status: "error" } }),
      prisma.aiUsage.groupBy({
        by: ["provider"],
        where: scope,
        _sum: { promptTokens: true, completionTokens: true, costMicros: true },
        _count: { _all: true }
      }),
      prisma.aiUsage.groupBy({ by: ["task"], where: scope, _sum: { costMicros: true }, _count: { _all: true } }),
      prisma.$queryRaw<
        Array<{ day: Date; calls: bigint; prompt: bigint | null; completion: bigint | null; cost: bigint | null }>
      >`
        SELECT date_trunc('day', "createdAt") AS day,
               COUNT(*) AS calls,
               SUM("promptTokens") AS prompt,
               SUM("completionTokens") AS completion,
               SUM("costMicros") AS cost
        FROM "AiUsage"
        WHERE "userId" = ${user.id} AND "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1 ASC
      `
    ]);

    return NextResponse.json({
      providers: publicProviders(),
      keys: keys.map(k => ({ ...k, dailyLimitMicros: k.dailyLimitMicros === null ? null : Number(k.dailyLimitMicros) })),
      preferences,
      modes: AI_MODES,
      automations,
      usage: {
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
        byTask: byTask.map(t => ({ task: t.task, calls: t._count._all, costMicros: Number(t._sum.costMicros ?? BigInt(0)) })),
        byDay: daily.map(d => ({
          day: d.day.toISOString().slice(0, 10),
          calls: Number(d.calls),
          promptTokens: Number(d.prompt ?? 0),
          completionTokens: Number(d.completion ?? 0),
          costMicros: Number(d.cost ?? 0)
        }))
      }
    });
  } catch (error) {
    return jsonError(error, "Could not load AI settings.");
  }
}
