import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { jsonError } from "@/lib/api-response";
import { aiEnabled } from "@/lib/feature-flags";
import { rateLimit } from "@/lib/rate-limit";
import { streamInclude } from "@/lib/file-stream";
import { FILE_ACTIONS, runFileTask, FileTaskError } from "@/lib/ai/file-tasks";
import { NoKeyAvailableError } from "@/lib/ai/router";
import { ProviderError } from "@/lib/ai/client";
import { enqueue } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Run an AI action against one stored file: summarize, translate, chat, OCR,
 * caption or transcribe.
 *
 * Transcription and long documents can outlast a request, so `async: true`
 * hands the work to the job queue instead — which needs a host that runs the
 * worker (see docs/RENDER.md).
 */

const body = z.object({
  action: z.enum(FILE_ACTIONS),
  question: z.string().trim().max(2000).optional(),
  language: z.string().trim().max(60).optional(),
  async: z.boolean().optional()
});

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  if (!aiEnabled()) {
    return NextResponse.json({ error: "The AI features are not enabled on this server." }, { status: 404 });
  }
  try {
    const user = await requireUser();
    rateLimit(`ai-file:${user.id}`, 30, 60_000);

    const input = body.parse(await request.json());

    const file = await prisma.file.findFirst({
      where: { id: params.id, userId: user.id, isDeleted: false, uploadStatus: { not: "uploading" } },
      include: streamInclude
    });
    if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });

    if (input.async) {
      const job = await enqueue({
        userId: user.id,
        type: "ai.file",
        payload: { fileId: file.id, action: input.action, question: input.question, language: input.language }
      });
      return NextResponse.json({ job });
    }

    const result = await runFileTask({
      userId: user.id,
      file,
      action: input.action,
      question: input.question,
      language: input.language,
      signal: request.signal
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FileTaskError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof NoKeyAvailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status || 502 });
    }
    return jsonError(error, "The AI request failed.");
  }
}
