import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/rate-limit";
import { semanticSearch } from "@/lib/ai/search";
import { NoKeyAvailableError } from "@/lib/ai/router";
import { ProviderError } from "@/lib/ai/client";
import { enqueue } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Semantic search, and indexing.
 *
 * POST { q }        search
 * POST { indexFileId } queue that file for embedding
 */

const body = z.union([
  z.object({ q: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }),
  z.object({ indexFileId: z.string().min(1).max(80) })
]);

export async function POST(request: NextRequest) {
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    rateLimit(`ai-search:${user.id}`, 60, 60_000);

    const input = body.parse(await request.json());

    if ("indexFileId" in input) {
      // Embedding a file means downloading it back out of Telegram, so it goes
      // to the queue rather than holding a request open.
      const job = await enqueue({
        userId: user.id,
        type: "ai.index",
        payload: { fileId: input.indexFileId }
      });
      return NextResponse.json({ job });
    }

    const hits = await semanticSearch(user.id, input.q, input.limit ?? 10);
    return NextResponse.json({ hits });
  } catch (error) {
    if (error instanceof NoKeyAvailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status || 502 });
    }
    return jsonError(error, "Search failed.");
  }
}
