import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma, readWithRetry } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { PUBLIC_KEY_FIELDS } from "@/lib/ai/vault";
import { publicProviders } from "@/lib/ai/providers";
import { AI_MODES, parsePreferences } from "@/lib/ai/modes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shape of the usage aggregate Postgres builds for us in one pass. */
type UsageJson = {
  calls: number;
  errors: number;
  pricedCalls: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
  avgLatencyMs: number;
  byProvider: Array<{ provider: string; calls: number; promptTokens: number; completionTokens: number; costMicros: number }>;
  byTask: Array<{ task: string; calls: number; costMicros: number }>;
  byDay: Array<{ day: string; calls: number; promptTokens: number; completionTokens: number; costMicros: number }>;
};

/**
 * Everything the Settings AI section needs, in one request and one round-trip.
 *
 * The four cards used to fetch independently — four round-trips that serialised
 * behind the pooler, so whichever card lost the race rendered blank. Answering
 * them together fixed that, but the handler still issued nine queries: three
 * table reads and six separate aggregates over AiUsage.
 *
 * Now the six aggregates are one query — Postgres is perfectly happy to build
 * the totals, the per-provider split, the per-task split and the daily series in
 * a single pass and hand back JSON — and all four reads go out as one batched
 * transaction. That is one network round-trip for the whole section instead of
 * nine, which is the difference between the section appearing and the section
 * timing out on a busy pooler.
 */
export async function GET(request: NextRequest) {
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [keys, preferenceRow, automations, usageRows] = await readWithRetry(() =>
      prisma.$transaction([
        prisma.aiKey.findMany({
          where: { userId: user.id },
          select: PUBLIC_KEY_FIELDS,
          orderBy: [{ provider: "asc" }, { priority: "asc" }, { createdAt: "asc" }]
        }),
        prisma.aiPreference.findUnique({ where: { userId: user.id } }),
        prisma.automation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
        prisma.$queryRaw<Array<{ usage: UsageJson }>>`
          WITH scoped AS (
            SELECT * FROM "AiUsage" WHERE "userId" = ${user.id} AND "createdAt" >= ${since}
          )
          SELECT json_build_object(
            'calls',            (SELECT COUNT(*) FROM scoped),
            'errors',           (SELECT COUNT(*) FROM scoped WHERE status = 'error'),
            'pricedCalls',      (SELECT COUNT(*) FROM scoped WHERE "costMicros" IS NOT NULL),
            'promptTokens',     (SELECT COALESCE(SUM("promptTokens"), 0) FROM scoped),
            'completionTokens', (SELECT COALESCE(SUM("completionTokens"), 0) FROM scoped),
            'costMicros',       (SELECT COALESCE(SUM("costMicros"), 0) FROM scoped),
            'avgLatencyMs',     (SELECT COALESCE(ROUND(AVG("latencyMs")), 0) FROM scoped),
            'byProvider', (SELECT COALESCE(json_agg(r), '[]'::json) FROM (
              SELECT provider,
                     COUNT(*)                              AS calls,
                     COALESCE(SUM("promptTokens"), 0)      AS "promptTokens",
                     COALESCE(SUM("completionTokens"), 0)  AS "completionTokens",
                     COALESCE(SUM("costMicros"), 0)        AS "costMicros"
              FROM scoped GROUP BY provider ORDER BY provider
            ) r),
            'byTask', (SELECT COALESCE(json_agg(r), '[]'::json) FROM (
              SELECT task,
                     COUNT(*)                       AS calls,
                     COALESCE(SUM("costMicros"), 0) AS "costMicros"
              FROM scoped GROUP BY task ORDER BY task
            ) r),
            'byDay', (SELECT COALESCE(json_agg(r), '[]'::json) FROM (
              SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
                     COUNT(*)                              AS calls,
                     COALESCE(SUM("promptTokens"), 0)      AS "promptTokens",
                     COALESCE(SUM("completionTokens"), 0)  AS "completionTokens",
                     COALESCE(SUM("costMicros"), 0)        AS "costMicros"
              FROM scoped GROUP BY 1 ORDER BY 1
            ) r)
          ) AS usage
        `
      ])
    );

    const usage = usageRows[0]?.usage;

    return NextResponse.json({
      providers: publicProviders(),
      keys: keys.map(k => ({ ...k, dailyLimitMicros: k.dailyLimitMicros === null ? null : Number(k.dailyLimitMicros) })),
      preferences: parsePreferences(preferenceRow),
      modes: AI_MODES,
      automations,
      usage: {
        days,
        calls: Number(usage?.calls ?? 0),
        errors: Number(usage?.errors ?? 0),
        pricedCalls: Number(usage?.pricedCalls ?? 0),
        promptTokens: Number(usage?.promptTokens ?? 0),
        completionTokens: Number(usage?.completionTokens ?? 0),
        costMicros: Number(usage?.costMicros ?? 0),
        avgLatencyMs: Number(usage?.avgLatencyMs ?? 0),
        byProvider: (usage?.byProvider ?? []).map(p => ({
          provider: p.provider,
          calls: Number(p.calls),
          promptTokens: Number(p.promptTokens),
          completionTokens: Number(p.completionTokens),
          costMicros: Number(p.costMicros)
        })),
        byTask: (usage?.byTask ?? []).map(t => ({ task: t.task, calls: Number(t.calls), costMicros: Number(t.costMicros) })),
        byDay: (usage?.byDay ?? []).map(d => ({
          day: d.day,
          calls: Number(d.calls),
          promptTokens: Number(d.promptTokens),
          completionTokens: Number(d.completionTokens),
          costMicros: Number(d.costMicros)
        }))
      }
    });
  } catch (error) {
    return jsonError(error, "Could not load AI settings.");
  }
}
