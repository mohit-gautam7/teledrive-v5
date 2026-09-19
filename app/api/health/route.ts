import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is this deployment actually able to do its job?
 *
 * Unauthenticated on purpose — a load balancer, an uptime monitor and a person
 * with curl all need it, and none of them has a session. That constrains what
 * may appear here: the three dependencies are reported as reachable or not, with
 * a latency, and nothing else. No connection strings, no bot username, no
 * version of anything that would help someone pick an exploit. A failure says
 * which dependency failed, never why in the provider's words, because those
 * messages routinely contain hostnames and user names.
 *
 * Checked rather than assumed. "The process is up" is what the container's own
 * HEALTHCHECK already answers; this endpoint exists for the failure that
 * actually happens — the process is fine and the database is paused, or the bot
 * token has been revoked — which a liveness probe cannot see.
 */

type Check = { ok: boolean; ms: number; error?: string };

async function timed(name: string, run: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await run();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    console.error(`[health] ${name} failed:`, err);
    // Deliberately generic. The real message is in the logs, where it is not
    // being served to anonymous callers.
    return { ok: false, ms: Date.now() - started, error: "unreachable" };
  }
}

/** Abandon a hanging dependency rather than hanging the health check with it. */
function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

export async function GET() {
  const [database, telegram] = await Promise.all([
    timed("database", () => withTimeout(prisma.$queryRaw`select 1`, 5000)),

    // getMe is the cheapest call that proves the token is still valid, which is
    // the Telegram failure that matters: a revoked token looks exactly like a
    // healthy app until someone tries to download a file.
    timed("telegram", async () => {
      const token = process.env.BOT_TOKEN;
      if (!token) throw new Error("BOT_TOKEN is not set");
      const res = await withTimeout(
        fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: "no-store" }),
        5000
      );
      if (!res.ok) throw new Error(`getMe returned ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      if (!body.ok) throw new Error("getMe reported not ok");
    })
  ]);

  const ok = database.ok && telegram.ok;
  return NextResponse.json(
    { ok, checks: { database, telegram }, uptimeSeconds: Math.round(process.uptime()) },
    {
      // 503 so an uptime monitor and an orchestrator both treat a degraded
      // deployment as down without having to parse the body.
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" }
    }
  );
}
