import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/rate-limit";
import { run, estimate, NoKeyAvailableError } from "@/lib/ai/router";
import { ProviderError } from "@/lib/ai/client";
import { enqueue } from "@/lib/jobs/queue";
import { AI_MODES, resolvePlan } from "@/lib/ai/modes";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Run a prompt through the router.
 *
 * Three modes, because the right one depends on the caller:
 *   estimate — what each usable key would charge, without calling anything
 *   async    — hand it to the job queue and return an id (needs a worker)
 *   default  — run it now and wait
 */

const body = z.object({
  task: z.string().trim().min(1).max(60).default("chat"),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(100_000)
      })
    )
    .min(1),
  providers: z.array(z.string()).max(12).optional(),
  strategy: z.enum(["priority", "round-robin", "least-used", "lowest-cost", "fastest"]).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Overrides the account mode for this one request. */
  mode: z.enum(AI_MODES).optional(),
  estimateOnly: z.boolean().optional(),
  async: z.boolean().optional()
});

export async function POST(request: NextRequest) {
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    // Each call spends the user's own money, so the ceiling is about runaway
    // loops rather than protecting the server.
    rateLimit(`ai-run:${user.id}`, 60, 60_000);

    const input = body.parse(await request.json());

    if (input.estimateOnly) {
      const options = await estimate({
        userId: user.id,
        task: input.task,
        messages: input.messages,
        providers: input.providers,
        maxTokens: input.maxTokens
      });
      return NextResponse.json({ options });
    }

    if (input.async) {
      const job = await enqueue({
        userId: user.id,
        type: "ai.completion",
        payload: {
          task: input.task,
          messages: input.messages,
          providers: input.providers,
          maxTokens: input.maxTokens
        }
      });
      return NextResponse.json({ job });
    }

    // The mode decides which keys may answer; anything the caller states
    // explicitly (providers, strategy) still wins over the resolved plan.
    const plan = await resolvePlan(user.id, input.task, input.mode);
    const result = await run({
      userId: user.id,
      task: input.task,
      messages: input.messages,
      providers: input.providers ?? plan.providers,
      strategy: input.strategy ?? plan.strategy,
      localOnly: plan.localOnly,
      freeOnly: plan.freeOnly,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      signal: request.signal
    });

    return NextResponse.json({
      text: result.text,
      provider: result.provider,
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      // Null when the model has no configured price — not zero.
      costMicros: result.costMicros,
      latencyMs: result.latencyMs
    });
  } catch (error) {
    if (error instanceof NoKeyAvailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProviderError) {
      // The provider's own status, so the caller can tell "your key is wrong"
      // from "the provider is down".
      return NextResponse.json({ error: error.message }, { status: error.status || 502 });
    }
    return jsonError(error, "The AI request failed.");
  }
}
