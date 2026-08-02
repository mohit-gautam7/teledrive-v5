import { claim, complete, fail, requeueStuck, type ClaimedJob } from "@/lib/jobs/queue";
import { jobWorkerEnabled } from "@/lib/feature-flags";
import { run as runAi } from "@/lib/ai/router";
import type { ChatMessage } from "@/lib/ai/client";

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
    const result = await runAi({
      userId: job.userId,
      task: payload.task || "ai.completion",
      messages: payload.messages,
      providers: payload.providers,
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
