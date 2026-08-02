import { claim, complete, fail, requeueStuck, type ClaimedJob } from "@/lib/jobs/queue";
import { jobWorkerEnabled } from "@/lib/feature-flags";
import { run as runAi } from "@/lib/ai/router";
import type { ChatMessage } from "@/lib/ai/client";
import { resolvePlan } from "@/lib/ai/modes";
import { prisma } from "@/lib/prisma";
import { streamInclude } from "@/lib/file-stream";
import { runFileTask, isFileAction } from "@/lib/ai/file-tasks";
import { indexFile } from "@/lib/ai/search";
import { runAutomation } from "@/lib/ai/automation";

/**
 * The loop that drains the job queue. Started once per always-on process from
 * instrumentation.ts, and only when JOB_WORKER_ENABLED=1.
 */

type Handler = (job: ClaimedJob) => Promise<unknown>;

/**
 * An AI job carries the prompt, never a key: keys are resolved from the vault at
 * run time by userId, so a queued row is not a place a secret can leak from.
 */
type AiCompletionPayload = {
  task: string;
  messages: ChatMessage[];
  providers?: string[];
  maxTokens?: number;
};

const handlers: Record<string, Handler> = {
  "ai.completion": async job => {
    const payload = job.payload as AiCompletionPayload;
    if (!payload?.messages?.length) throw new Error("ai.completion job has no messages.");
    const task = payload.task || "ai.completion";
    // Resolved at run time, not enqueue time: a job that waited in the queue
    // should honour the mode the user has now, not the one they had then.
    const plan = await resolvePlan(job.userId, task);
    const result = await runAi({
      userId: job.userId,
      task,
      messages: payload.messages,
      providers: payload.providers ?? plan.providers,
      strategy: plan.strategy,
      localOnly: plan.localOnly,
      freeOnly: plan.freeOnly,
      maxTokens: payload.maxTokens
    });
    // The generated text plus what it cost — no key material.
    return {
      text: result.text,
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costMicros: result.costMicros
    };
  }
};

/** An AI action against a stored file. The payload carries the file id, not its
 *  bytes — the worker re-reads it, so a queued row stays small. */
type AiFilePayload = { fileId: string; action: string; question?: string; language?: string };

handlers["ai.file"] = async job => {
  const payload = job.payload as AiFilePayload;
  if (!payload?.fileId || !isFileAction(payload.action)) {
    throw new Error("ai.file job is missing a file id or has an unknown action.");
  }
  const file = await prisma.file.findFirst({
    where: { id: payload.fileId, userId: job.userId, isDeleted: false },
    include: streamInclude
  });
  if (!file) throw new Error("The file no longer exists.");

  const result = await runFileTask({
    userId: job.userId,
    file,
    action: payload.action,
    question: payload.question,
    language: payload.language
  });
  return result;
};

handlers["ai.index"] = async job => {
  const { fileId } = job.payload as { fileId?: string };
  if (!fileId) throw new Error("ai.index job has no file id.");
  return indexFile(job.userId, fileId);
};

handlers["automation"] = async job => {
  const { automationId, fileId } = job.payload as { automationId?: string; fileId?: string };
  if (!automationId || !fileId) throw new Error("automation job is missing an automation or file id.");
  return runAutomation(job.userId, automationId, fileId);
};

/** Register work types outside this file (thumbnails, automations) without
 *  editing the worker. */
export function registerHandler(type: string, handler: Handler) {
  handlers[type] = handler;
}

const IDLE_MS = 2_000;
const BATCH = 2;
const SWEEP_EVERY_MS = 5 * 60_000;

let running = false;

export function startJobWorker() {
  if (running || !jobWorkerEnabled()) return;
  running = true;

  console.log("[jobs] worker started");

  let lastSweep = 0;

  const tick = async () => {
    while (running) {
      try {
        if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
          lastSweep = Date.now();
          const requeued = await requeueStuck();
          if (requeued) console.log(`[jobs] re-queued ${requeued} job(s) abandoned by a dead worker`);
        }

        const jobs = await claim(BATCH);
        if (!jobs.length) {
          await new Promise(r => setTimeout(r, IDLE_MS));
          continue;
        }

        for (const job of jobs) {
          const handler = handlers[job.type];
          if (!handler) {
            await fail(job, `No handler registered for job type "${job.type}".`);
            continue;
          }
          try {
            await complete(job.id, (await handler(job)) as never);
          } catch (err) {
            const { retrying } = await fail(job, (err as Error).message);
            console.warn(`[jobs] ${job.type} failed${retrying ? ", will retry" : " permanently"}:`, (err as Error).message);
          }
        }
      } catch (err) {
        // The loop itself must survive a database blip, or the worker silently
        // stops draining and nothing ever runs again.
        console.error("[jobs] worker loop error:", (err as Error).message);
        await new Promise(r => setTimeout(r, IDLE_MS));
      }
    }
  };

  void tick();
}

export function stopJobWorker() {
  running = false;
}
