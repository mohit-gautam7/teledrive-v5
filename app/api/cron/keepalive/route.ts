import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Keeps the managed database from pausing itself.
 *
 * Supabase's free tier pauses a project after seven days without activity, and
 * a paused project stops resolving in DNS — the site does not degrade, it
 * disappears, and only a click in a dashboard brings it back. That has now
 * happened three times. The files were never at risk (they are in Telegram),
 * but the index that finds them was unreachable each time.
 *
 * One query a day is all it takes to never be idle. This is a workaround, not
 * a fix: the real fix is a database that does not pause, which is why
 * DEPLOYMENT.md still recommends moving off the free tier. But it costs
 * nothing, needs no new host, and removes the failure mode today.
 *
 * Deliberately a real read against a real table rather than `SELECT 1`: a
 * connection that opens and answers a trivial literal can be served by the
 * pooler alone. Counting rows proves Postgres itself woke up.
 */
export async function GET(request: NextRequest) {
  // Vercel sends this header on scheduled invocations whenever CRON_SECRET is
  // set. Unset, the route stays reachable — it leaks one integer and nothing
  // else, and refusing to run without a secret would silently disable the very
  // thing that keeps the site alive.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const started = Date.now();
  try {
    const files = await prisma.file.count({ where: { isDeleted: false } });
    return NextResponse.json({ ok: true, files, ms: Date.now() - started });
  } catch (error) {
    // 500 so a failure is visible in Vercel's cron log rather than looking
    // like a successful ping that did nothing.
    console.error("[cron/keepalive] database unreachable:", error);
    return NextResponse.json(
      { ok: false, error: "database unreachable", ms: Date.now() - started },
      { status: 500 }
    );
  }
}
