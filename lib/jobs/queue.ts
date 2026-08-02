import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * A durable background queue on the existing Postgres.
 *
 * There is no broker to run: work is a table, and workers claim rows with
 * SELECT ... FOR UPDATE SKIP LOCKED, which lets several of them share the queue
 * without ever handing the same job to two workers. That is the whole reason
 * this needs the always-on host — a serverless function can enqueue, but
 * nothing there stays alive long enough to drain.
 */

export type JobType = "ai.completion" | "ai.file" | "ai.index" | "thumbnail" | "automation";

export type EnqueueInput = {
  userId: string;
  type: JobType;
  payload: Prisma.InputJsonValue;
  /** Lower runs first. */
  priority?: number;
  /** Delay before the job becomes eligible. */
  runAt?: Date;
  maxAttempts?: number;
};

export async function enqueue(input: EnqueueInput) {
  return prisma.job.create({
    data: {
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      priority: input.priority ?? 100,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3
    },
    select: { id: true, type: true, status: true, runAt: true, createdAt: true }
  });
}

export type ClaimedJob = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
};

/**
 * Take up to `limit` eligible jobs and mark them running, atomically.
 *
 * Raw SQL because Prisma has no way to express SKIP LOCKED, which is the part
 * that makes concurrent workers safe: a row already locked by another worker is
 * stepped over instead of blocking.
 */
export async function claim(limit = 1): Promise<ClaimedJob[]> {
  return prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" SET
      status = 'running',
      "startedAt" = NOW(),
      attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE status = 'queued' AND "runAt" <= NOW()
      ORDER BY priority ASC, "runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, "userId", type, payload, attempts, "maxAttempts"
  `;
}

export async function complete(jobId: string, result?: Prisma.InputJsonValue) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "done", finishedAt: new Date(), error: null, ...(result === undefined ? {} : { result }) }
  });
}

/** Exponential backoff with a ceiling, so a provider outage does not become a
 *  tight retry loop. */
function backoffMs(attempts: number) {
  return Math.min(30_000 * 2 ** (attempts - 1), 30 * 60_000);
}

/**
 * Record a failure. The job is rescheduled while it has attempts left, and only
 * marked failed once it does not — so a transient error costs a delay, not the
 * work.
 */
export async function fail(job: ClaimedJob, error: string) {
  const exhausted = job.attempts >= job.maxAttempts;
  await prisma.job.update({
    where: { id: job.id },
    data: exhausted
      ? { status: "failed", finishedAt: new Date(), error: error.slice(0, 1000) }
      : { status: "queued", runAt: new Date(Date.now() + backoffMs(job.attempts)), error: error.slice(0, 1000) }
  });
  return { retrying: !exhausted };
}

/**
 * Return jobs abandoned by a worker that died mid-run.
 *
 * A crashed process leaves rows stuck in "running" forever; anything older than
 * `olderThanMs` is assumed orphaned and re-queued.
 */
export async function requeueStuck(olderThanMs = 15 * 60_000) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.job.updateMany({
    where: { status: "running", startedAt: { lt: cutoff } },
    data: { status: "queued" }
  });
  return count;
}
