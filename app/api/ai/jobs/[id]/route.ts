import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { jobWorkerEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a queued AI job. Scoped to the caller, so one user cannot read another's
 *  result by guessing an id. */
export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    const job = await prisma.job.findFirst({
      where: { id: params.id, userId: user.id },
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        result: true,
        error: true,
        runAt: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true
      }
    });
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });

    return NextResponse.json({
      job,
      // Without a worker a queued job never moves, and "queued" alone looks like
      // the request simply being slow. Say so instead.
      workerRunning: jobWorkerEnabled()
    });
  } catch (error) {
    return jsonError(error, "Could not read the job.");
  }
}
